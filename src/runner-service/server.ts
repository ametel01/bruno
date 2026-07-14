import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AGENT_LAUNCH_SPEC_MAX_BYTES,
  parseAgentLaunchSpecJson,
  type AgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { ManualRunnerDocker } from "@/src/runner-service/docker";
import { HermesReadinessError } from "@/src/runner-service/docker";
import {
  HermesSetupSessionError,
  HermesSetupSessionManager,
  type HermesSetupWebSocketData,
} from "@/src/runner-service/hermes-setup-sessions";
import { HermesSetupRequiredError } from "@/src/runner-service/hermes-projection";

const RUNNER_TOKEN_ENV = "AGENTBAY_RUNNER_BEARER_TOKEN";

type RunnerAction = "start" | "stop" | "restart" | "status" | "logs" | "cleanup";

export type RunnerServiceOptions = {
  authToken?: string;
  docker?: Pick<ManualRunnerDocker, RunnerAction>;
  heartbeat?: RunnerHeartbeatLoopOptions;
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

    const readinessResponse = handleReadinessRequest(request);

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

      return Response.json(
        {
          ok: true,
          agentId: route.agentId,
          action: route.action,
          ...(await callDockerAction(docker, route, launchSpecResult.launchSpec)),
        },
        { status: 200 },
      );
    } catch (error) {
      if (error instanceof HermesSetupRequiredError) {
        return jsonError(409, "hermes_setup_incomplete", "Run Hermes setup before starting.");
      }

      if (error instanceof HermesReadinessError) {
        return jsonError(502, "hermes_readiness_failed", "Hermes readiness failed.");
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
  docker: Pick<ManualRunnerDocker, RunnerAction>,
  route: { agentId: string; action: RunnerAction },
  launchSpec: AgentLaunchSpec | null,
) {
  if (route.action === "start" || route.action === "restart") {
    return await docker[route.action](route.agentId, launchSpec);
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

  const body = await request.text();

  if (!body.trim()) {
    return { ok: true, launchSpec: null };
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      response: jsonError(415, "unsupported_media_type", "Launch spec requires JSON.", {
        Accept: "application/json",
      }),
    };
  }

  if (Buffer.byteLength(body, "utf8") > AGENT_LAUNCH_SPEC_MAX_BYTES) {
    return {
      ok: false,
      response: jsonError(413, "launch_spec_too_large", "Launch spec body is too large."),
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

function handleReadinessRequest(request: Request): Response | null {
  const { pathname } = new URL(request.url);

  if (pathname !== "/runner/v1/readiness") {
    return null;
  }

  if (request.method !== "GET") {
    return jsonError(405, "method_not_allowed", "readiness requires GET.", {
      Allow: "GET",
    });
  }

  return Response.json({ ok: true, status: "ready" }, { status: 200 });
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

  return match?.[1] ? { agentId: decodeURIComponent(match[1]) } : null;
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
  const fetchImplementation = options.fetch ?? fetch;
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  async function sendHeartbeat() {
    if (stopped) {
      return;
    }

    try {
      await fetchImplementation(`${normalizeBaseUrl(options.appBaseUrl)}/runner/v1/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runnerId: options.runnerId,
          status: "online",
          version: "agentbay-runner/service",
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
  const match = /^\/runner\/v1\/agents\/([^/]+)\/(start|stop|restart|status|logs|cleanup)$/.exec(
    pathname,
  );

  if (!match?.[1] || !match[2]) {
    return null;
  }

  return {
    agentId: decodeURIComponent(match[1]),
    action: match[2] as RunnerAction,
  };
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
): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message,
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
