import { validateManualRunnerEndpointUrl } from "@/src/env/validation";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AgentSecretKeyringError,
  generateApiServerKeyForUser,
  listAgentSecretStatusesForUser,
} from "@/src/server/agents/agent-secrets";
import { getActiveAgentForUser } from "@/src/server/agents/list-agents";
import { assignRunnerForHermesSetup } from "@/src/server/agents/hermes-setup-runner";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { RUNNER_BEARER_TOKEN_ENV } from "@/src/server/runners/manual-runner-adapter";
import { getAssignedRunnerForActiveAgentForUser } from "@/src/server/runners/manual-runner-persistence";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type RouteContext = {
  params: Promise<{ agentId?: string }>;
};

type RouteDependencies = {
  assignRunner?: typeof assignRunnerForHermesSetup;
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  generateApiServerKey?: typeof generateApiServerKeyForUser;
  getAgent?: typeof getActiveAgentForUser;
  getAssignedRunner?: typeof getAssignedRunnerForActiveAgentForUser;
  listSecretStatuses?: typeof listAgentSecretStatusesForUser;
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

type RunnerSetupSessionResponse = {
  ok: true;
  session: {
    id: string;
    websocketPath: string;
    websocketProtocol: string;
    expiresAt: string;
  };
};

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RouteContext,
  dependencies: RouteDependencies = {},
) {
  const agentId = await decodeAgentId(context);

  if (!agentId) {
    return errorResponse(400, "validation_failed", "Agent ID must be a valid UUID.");
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const agent = await (dependencies.getAgent ?? getActiveAgentForUser)(
      applicationUser.userId,
      agentId,
      {
        createConnection: () => connection,
      },
    );

    if (!agent) {
      return errorResponse(404, "agent_not_found", "Agent could not be found.");
    }

    if (["running", "starting", "restarting", "stopping"].includes(agent.status)) {
      return errorResponse(409, "agent_running", "Stop the agent before running Hermes setup.");
    }

    let runner = await (dependencies.getAssignedRunner ?? getAssignedRunnerForActiveAgentForUser)(
      applicationUser.userId,
      agentId,
      { createConnection: () => connection },
    );

    if (!runner) {
      const assignment = await (dependencies.assignRunner ?? assignRunnerForHermesSetup)(
        connection,
        {
          agentId,
          userId: applicationUser.userId,
        },
      );

      if (!assignment.ok) {
        return errorResponse(
          409,
          assignment.reason,
          assignment.reason === "runner_capacity_reached"
            ? "Runner capacity is full."
            : "Provision an online runner before running Hermes setup.",
        );
      }

      runner = await (dependencies.getAssignedRunner ?? getAssignedRunnerForActiveAgentForUser)(
        applicationUser.userId,
        agentId,
        { createConnection: () => connection },
      );

      if (!runner) {
        return errorResponse(409, "runner_not_ready", "Runner assignment is not ready.");
      }
    }

    const secretStatuses = await (
      dependencies.listSecretStatuses ?? listAgentSecretStatusesForUser
    )(applicationUser.userId, agentId, { createConnection: () => connection });

    if (!secretStatuses.ok) {
      return errorResponse(404, "agent_not_found", "Agent could not be found.");
    }

    const apiServerKey = secretStatuses.secrets.find(
      (secret) => secret.kind === "api_server_key" && secret.configured,
    );

    if (!apiServerKey) {
      const generated = await (dependencies.generateApiServerKey ?? generateApiServerKeyForUser)(
        applicationUser.userId,
        agentId,
        {
          createConnection: () => connection,
          ...(dependencies.env ? { env: dependencies.env } : {}),
        },
      );

      if (!generated.ok) {
        return errorResponse(500, "setup_session_failed", "Hermes setup could not be prepared.");
      }
    }

    const env = dependencies.env ?? process.env;
    const runnerToken = env[RUNNER_BEARER_TOKEN_ENV]?.trim();

    if (!runnerToken) {
      return errorResponse(503, "runner_not_configured", "Runner authentication is unavailable.");
    }

    const endpointUrl = validateManualRunnerEndpointUrl(runner.endpointUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const response = await (dependencies.fetch ?? fetch)(
        new URL(
          `/runner/v1/agents/${encodeURIComponent(agentId)}/setup-sessions`,
          normalizeBaseUrl(endpointUrl),
        ),
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${runnerToken}`,
          },
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        return errorResponse(
          response.status === 409 ? 409 : 502,
          "setup_session_failed",
          response.status === 409
            ? "A Hermes setup session is already active or the agent is running."
            : "Hermes setup could not be prepared.",
        );
      }

      const runnerResponse: unknown = await response.json();
      const parsed = parseRunnerResponse(runnerResponse);

      if (!parsed) {
        return errorResponse(502, "runner_response_invalid", "Hermes setup could not be prepared.");
      }

      const websocketUrl = new URL(parsed.session.websocketPath, normalizeBaseUrl(endpointUrl));
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

      return Response.json(
        {
          ok: true,
          session: {
            id: parsed.session.id,
            websocketUrl: websocketUrl.toString(),
            websocketProtocol: parsed.session.websocketProtocol,
            expiresAt: parsed.session.expiresAt,
          },
        },
        { status: 201 },
      );
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error instanceof AgentSecretKeyringError) {
      return errorResponse(
        503,
        "secret_storage_not_configured",
        "Agent secret storage is unavailable.",
      );
    }

    return errorResponse(500, "setup_session_failed", "Hermes setup could not be prepared.");
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function decodeAgentId(context: RouteContext): Promise<string | null> {
  const raw = (await context.params).agentId ?? "";

  try {
    const decoded = decodeURIComponent(raw);
    return isValidAgentId(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function parseRunnerResponse(value: unknown): RunnerSetupSessionResponse | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.session)) {
    return null;
  }

  const session = value.session;

  if (
    typeof session.id !== "string" ||
    typeof session.websocketPath !== "string" ||
    !session.websocketPath.startsWith("/runner/v1/hermes-setup-sessions/") ||
    typeof session.websocketProtocol !== "string" ||
    !session.websocketProtocol.startsWith("bruno.hermes.setup.") ||
    typeof session.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(session.expiresAt))
  ) {
    return null;
  }

  return value as RunnerSetupSessionResponse;
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

function authenticationResponse(
  result: Exclude<ConfiguredApplicationUserResolution, { ok: true }>,
) {
  return errorResponse(
    result.status,
    result.code,
    result.status === 401 ? "Authentication is required." : "Authentication is not configured.",
  );
}
