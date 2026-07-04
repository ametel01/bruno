import { isValidAgentId } from "@/src/server/agents/agent-id";
import { ManualRunnerDocker } from "@/src/runner-service/docker";

const RUNNER_TOKEN_ENV = "AGENTBAY_RUNNER_BEARER_TOKEN";

type RunnerAction = "start" | "stop" | "restart" | "status" | "logs";

export type RunnerServiceOptions = {
  authToken?: string;
  docker?: Pick<ManualRunnerDocker, RunnerAction>;
};

export function createRunnerService(options: RunnerServiceOptions = {}) {
  const docker = options.docker ?? new ManualRunnerDocker();
  const authToken = options.authToken ?? process.env[RUNNER_TOKEN_ENV]?.trim();

  return {
    fetch: async (request: Request): Promise<Response> => {
      const authFailure = authenticateRequest(request, authToken);

      if (authFailure) {
        return authFailure;
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
        return Response.json(
          {
            ok: true,
            agentId: route.agentId,
            action: route.action,
            ...(await docker[route.action](route.agentId)),
          },
          { status: 200 },
        );
      } catch {
        return jsonError(502, "docker_command_failed", "Runner Docker command failed.");
      }
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
  const match = /^\/runner\/v1\/agents\/([^/]+)\/(start|stop|restart|status|logs)$/.exec(pathname);

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
