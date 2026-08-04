import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AGENT_LAUNCH_SPEC_MAX_BYTES,
  parseAgentLaunchSpecJson,
  type AgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { ManualRunnerDocker } from "@/src/runner-service/docker";
import {
  HermesReadinessError,
  RunnerCanaryNotReadyError,
  RunnerLaunchAcceptanceTimeoutError,
  RunnerLaunchCancelledError,
} from "@/src/runner-service/docker";
import {
  parseRunnerCanaryRequest,
  type RunnerCanaryRequest,
} from "@/src/runner-service/runner-contracts";
import {
  createRunnerBootReadinessController,
  type RunnerBootReadinessController,
} from "@/src/runner-service/boot-self-test";
import {
  HermesSetupSessionError,
  HermesSetupSessionManager,
  type HermesSetupWebSocketData,
} from "@/src/runner-service/hermes-setup-sessions";
import {
  HermesProjectionInvalidError,
  HermesSetupRequiredError,
} from "@/src/runner-service/hermes-projection";
import {
  resolveRunnerReleaseEvidence,
  type RunnerReleaseEvidence,
} from "@/src/runner-service/release-identity";

const RUNNER_TOKEN_ENV = "AGENTBAY_RUNNER_BEARER_TOKEN";

type RunnerAction = "start" | "stop" | "restart" | "status" | "logs" | "cleanup" | "canary";

export type RunnerServiceOptions = {
  authToken?: string;
  docker?: RunnerServiceDocker;
  heartbeat?: RunnerHeartbeatLoopOptions;
  readiness?: RunnerBootReadinessController;
  setupSessions?: HermesSetupSessionManager;
};

type RunnerUpgradeServer = {
  upgrade(
    request: Request,
    options: {
      data: HermesSetupWebSocketData;
      headers: Record<string, string>;
    },
  ): boolean;
};

type RunnerServiceDocker = {
  start(agentId: string, launchSpec: AgentLaunchSpec | null): Promise<object>;
  stop(agentId: string): Promise<object>;
  restart(agentId: string, launchSpec: AgentLaunchSpec | null): Promise<object>;
  status(agentId: string): Promise<object>;
  logs(agentId: string): Promise<object>;
  cleanup(agentId: string): Promise<object>;
  canary?(agentId: string, request: RunnerCanaryRequest): Promise<object>;
};

type RunnerWebSocket = {
  data: HermesSetupWebSocketData;
  send(data: string): number;
  close(code?: number, reason?: string): void;
};

type RunnerFetch = {
  (request: Request): Promise<Response>;
  (request: Request, upgradeServer: RunnerUpgradeServer): Promise<Response | undefined>;
};

export type RunnerHeartbeatLoopOptions = {
  appBaseUrl: string;
  credential: string;
  intervalMs?: number;
  maxAgents?: number;
  runnerId: string;
  releaseEvidence?: RunnerReleaseEvidence;
  resolveReleaseEvidence?: () => Promise<RunnerReleaseEvidence>;
  start?: (input: { appBaseUrl: string; credential: string; runnerId: string }) => { stop(): void };
  fetch?: typeof fetch;
};

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_RUNNER_MAX_AGENTS = 3;

export function createRunnerService(options: RunnerServiceOptions = {}) {
  const docker = options.docker ?? new ManualRunnerDocker();
  const setupSessions = options.setupSessions ?? new HermesSetupSessionManager();
  const authToken = options.authToken ?? process.env[RUNNER_TOKEN_ENV]?.trim();
  const heartbeatLoop = options.heartbeat ? startRunnerHeartbeatLoop(options.heartbeat) : null;
  const readiness = options.readiness ?? createRunnerBootReadinessController();
  void readiness.start().catch(() => undefined);

  const handleFetch = async (
    request: Request,
    upgradeServer?: RunnerUpgradeServer,
  ): Promise<Response | undefined> => {
    if (isSetupWebSocketRequest(request)) {
      const authorization = setupSessions.authorizeUpgrade(request);

      if (
        !authorization.ok ||
        !upgradeServer?.upgrade(request, {
          data: authorization.data,
          headers: { "Sec-WebSocket-Protocol": authorization.protocol },
        })
      ) {
        return jsonError(401, "unauthorized", "Unauthorized.");
      }

      return undefined;
    }

    const authFailure = authenticateRequest(request, authToken);

    if (authFailure) {
      return authFailure;
    }

    const readinessResponse = await handleReadinessRequest(request, readiness);

    if (readinessResponse) {
      return readinessResponse;
    }

    const setupRoute = parseSetupSessionCreateRoute(request);

    if (setupRoute) {
      if (!isValidAgentId(setupRoute.agentId)) {
        return jsonError(400, "invalid_agent_id", "Agent id must be a UUID.");
      }

      if (request.method !== "POST") {
        return jsonError(405, "method_not_allowed", "setup-sessions requires POST.", {
          Allow: "POST",
        });
      }

      try {
        const session = await setupSessions.create(setupRoute.agentId);
        return Response.json({ ok: true, agentId: setupRoute.agentId, session }, { status: 201 });
      } catch (error) {
        if (error instanceof HermesSetupSessionError) {
          return jsonError(
            409,
            error.reason,
            error.reason === "agent_running"
              ? "Stop the agent before running Hermes setup."
              : "A Hermes setup session is already active.",
          );
        }

        return jsonError(502, "setup_session_failed", "Hermes setup could not be prepared.");
      }
    }

    const route = parseRunnerRoute(request);

    if (!route) {
      return jsonError(404, "not_found", "Runner route was not found.");
    }

    if (!isValidAgentId(route.agentId)) {
      return jsonError(400, "invalid_agent_id", "Agent id must be a UUID.");
    }

    const methodFailure = validateMethod(request.method, route.action);

    if (methodFailure) {
      return methodFailure;
    }

    try {
      const launchSpecResult = await readLaunchSpec(request, route.action);

      if (!launchSpecResult.ok) {
        return launchSpecResult.response;
      }
      const canaryResult = await readCanaryRequest(request, route.action);

      if (!canaryResult.ok) {
        return canaryResult.response;
      }
      const dockerResult = await callDockerAction(
        docker,
        route,
        launchSpecResult.launchSpec,
        canaryResult.request,
      );
      const status =
        route.action === "start" || route.action === "restart"
          ? "contractVersion" in dockerResult && "operation" in dockerResult
            ? 202
            : 200
          : 200;
      return Response.json(
        {
          ok: true,
          agentId: route.agentId,
          action: route.action,
          ...dockerResult,
        },
        { status },
      );
    } catch (error) {
      if (error instanceof HermesSetupRequiredError) {
        return jsonError(409, "hermes_setup_incomplete", "Run Hermes setup before starting.");
      }

      if (error instanceof HermesReadinessError) {
        return jsonError(502, "hermes_readiness_failed", "Hermes readiness failed.", undefined, {
          reason: error.reason,
        });
      }

      if (error instanceof HermesProjectionInvalidError) {
        return jsonError(409, "hermes_projection_invalid", "Hermes projection is invalid.");
      }

      if (error instanceof RunnerCanaryNotReadyError) {
        return jsonError(409, "canary_not_ready", "Runner canary requires a ready operation.");
      }

      if (error instanceof RunnerLaunchCancelledError) {
        return jsonError(409, "launch_cancelled", "Runner launch was cancelled.");
      }

      if (error instanceof RunnerLaunchAcceptanceTimeoutError) {
        return jsonError(504, "launch_acceptance_timeout", "Runner launch acceptance timed out.");
      }

      if (route.action === "status") {
        return jsonError(502, "runner_status_failed", "Runner status observation failed.");
      }

      return jsonError(502, "docker_command_failed", "Runner Docker command failed.");
    }
  };

  return {
    heartbeatLoop,
    fetch: handleFetch as RunnerFetch,
    websocket: {
      open(socket: RunnerWebSocket) {
        setupSessions.open(socket.data.setupSessionId, socket);
      },
      message(socket: RunnerWebSocket, message: string | Buffer) {
        setupSessions.message(socket.data.setupSessionId, message);
      },
      close(socket: RunnerWebSocket) {
        setupSessions.close(socket.data.setupSessionId);
      },
    },
  };
}

async function callDockerAction(
  docker: RunnerServiceDocker,
  route: { agentId: string; action: RunnerAction },
  launchSpec: AgentLaunchSpec | null,
  canaryRequest: RunnerCanaryRequest | null,
) {
  if (route.action === "start" || route.action === "restart") {
    return await docker[route.action](route.agentId, launchSpec);
  }

  if (route.action === "canary") {
    if (!canaryRequest || !docker.canary) {
      throw new RunnerCanaryNotReadyError();
    }

    return await docker.canary(route.agentId, canaryRequest);
  }

  return await docker[route.action](route.agentId);
}

async function readLaunchSpec(
  request: Request,
  action: RunnerAction,
): Promise<{ ok: true; launchSpec: AgentLaunchSpec | null } | { ok: false; response: Response }> {
  if (action !== "start" && action !== "restart") {
    return { ok: true, launchSpec: null };
  }

  const bodyResult = await readBoundedRequestText(request, AGENT_LAUNCH_SPEC_MAX_BYTES);

  if (!bodyResult.ok) {
    return {
      ok: false,
      response: jsonError(413, "launch_spec_too_large", "Launch spec body is too large."),
    };
  }
  const body = bodyResult.text;

  if (!body.trim()) {
    return { ok: true, launchSpec: null };
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!isJsonContentType(contentType)) {
    return {
      ok: false,
      response: jsonError(415, "unsupported_media_type", "Launch spec requires JSON.", {
        Accept: "application/json",
      }),
    };
  }

  const parsed = parseAgentLaunchSpecJson(body);

  if (!parsed.ok) {
    return {
      ok: false,
      response: jsonError(400, "launch_spec_invalid", "Launch spec is invalid."),
    };
  }

  return { ok: true, launchSpec: parsed.spec };
}

async function readCanaryRequest(
  request: Request,
  action: RunnerAction,
): Promise<{ ok: true; request: RunnerCanaryRequest | null } | { ok: false; response: Response }> {
  if (action !== "canary") {
    return { ok: true, request: null };
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!isJsonContentType(contentType)) {
    return {
      ok: false,
      response: jsonError(415, "unsupported_media_type", "Canary requires JSON.", {
        Accept: "application/json",
      }),
    };
  }

  const bodyResult = await readBoundedRequestText(request, 64 * 1024);

  if (!bodyResult.ok) {
    return {
      ok: false,
      response: jsonError(413, "canary_invalid", "Canary request is invalid."),
    };
  }
  const body = bodyResult.text;

  let parsed: unknown;

  try {
    parsed = JSON.parse(body);
  } catch {
    return {
      ok: false,
      response: jsonError(400, "canary_invalid", "Canary request is invalid."),
    };
  }

  const result = parseRunnerCanaryRequest(parsed);

  if (!result.ok) {
    return {
      ok: false,
      response: jsonError(400, "canary_invalid", "Canary request is invalid."),
    };
  }

  return { ok: true, request: result.request };
}

async function handleReadinessRequest(
  request: Request,
  readiness: RunnerBootReadinessController,
): Promise<Response | null> {
  const { pathname } = new URL(request.url);

  if (pathname !== "/runner/v1/readiness") {
    return null;
  }

  if (request.method !== "GET") {
    return jsonError(405, "method_not_allowed", "readiness requires GET.", {
      Allow: "GET",
    });
  }

  const snapshot = await readiness.read();
  return Response.json(snapshot, {
    status: snapshot.status === "ready" ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}

function isSetupWebSocketRequest(request: Request): boolean {
  const { pathname } = new URL(request.url);

  return (
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    /^\/runner\/v1\/hermes-setup-sessions\/[0-9a-f-]+$/i.test(pathname)
  );
}

function parseSetupSessionCreateRoute(request: Request): { agentId: string } | null {
  const { pathname } = new URL(request.url);
  const match = /^\/runner\/v1\/agents\/([^/]+)\/setup-sessions$/.exec(pathname);

  if (!match?.[1]) {
    return null;
  }

  try {
    return { agentId: decodeURIComponent(match[1]) };
  } catch {
    return null;
  }
}

export function startRunnerHeartbeatLoop(options: RunnerHeartbeatLoopOptions): { stop(): void } {
  const customStartInput = {
    appBaseUrl: options.appBaseUrl,
    credential: options.credential,
    runnerId: options.runnerId,
  };

  if (options.start) {
    return options.start(customStartInput);
  }

  let stopped = false;
  let cachedReleaseEvidence = options.releaseEvidence;
  const fetchImplementation = options.fetch ?? fetch;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  async function sendHeartbeat() {
    if (stopped) {
      return;
    }

    try {
      cachedReleaseEvidence ??= await (options.resolveReleaseEvidence?.() ??
        resolveRunnerReleaseEvidence());
      await fetchImplementation(`${normalizeBaseUrl(options.appBaseUrl)}/runner/v1/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runnerId: options.runnerId,
          status: cachedReleaseEvidence.expectedMatch === false ? "degraded" : "online",
          version: "agentbay-runner/service",
          release: cachedReleaseEvidence.release,
          metrics: {
            maxAgents: normalizePositiveInteger(options.maxAgents, DEFAULT_RUNNER_MAX_AGENTS),
            runningAgents: 0,
          },
        }),
      });
    } catch {
      // Heartbeat failures should not terminate the command server.
    }
  }

  void sendHeartbeat();
  const interval = setInterval(() => {
    void sendHeartbeat();
  }, intervalMs);

  return {
    stop() {
      stopped = true;
      clearInterval(interval);
    },
  };
}

function authenticateRequest(request: Request, authToken: string | undefined): Response | null {
  if (!authToken) {
    return jsonError(500, "runner_token_not_configured", "Runner bearer token is not configured.");
  }

  const authorization = request.headers.get("authorization") ?? "";

  if (authorization !== `Bearer ${authToken}`) {
    return jsonError(401, "unauthorized", "Unauthorized.");
  }

  return null;
}

function parseRunnerRoute(request: Request): { agentId: string; action: RunnerAction } | null {
  const { pathname } = new URL(request.url);
  const match =
    /^\/runner\/v1\/agents\/([^/]+)\/(start|stop|restart|status|logs|cleanup|canary)$/.exec(
      pathname,
    );

  if (!match?.[1] || !match[2]) {
    return null;
  }

  try {
    return {
      agentId: decodeURIComponent(match[1]),
      action: match[2] as RunnerAction,
    };
  } catch {
    return null;
  }
}

function validateMethod(method: string, action: RunnerAction): Response | null {
  const expected = action === "status" || action === "logs" ? "GET" : "POST";

  if (method !== expected) {
    return jsonError(405, "method_not_allowed", `${action} requires ${expected}.`, {
      Allow: expected,
    });
  }

  return null;
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
        ...(details ?? {}),
      },
    },
    {
      status,
      ...(headers ? { headers } : {}),
    },
  );
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function isJsonContentType(value: string): boolean {
  return /^\s*application\/json(?:\s*;|\s*$)/i.test(value);
}

async function readBoundedRequestText(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declaredLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return { ok: false };
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }

    return { ok: true, text: text + decoder.decode() };
  } catch {
    return { ok: false };
  }
}
