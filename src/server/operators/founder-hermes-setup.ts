import "server-only";

import { validateManualRunnerEndpointUrl } from "@/src/env/validation";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { getFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import { RUNNER_BEARER_TOKEN_ENV } from "@/src/server/runners/manual-runner-adapter";
import { getFirstAssignableRunnerForUser } from "@/src/server/runners/manual-runner-persistence";

export type FounderHermesSetupSessionDto = {
  id: string;
  websocketUrl: string;
  websocketProtocol: string;
  expiresAt: string;
};

export type FounderHermesSetupDependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  getOperator?: typeof getFounderOperatorForUser;
  getRunner?: typeof getFirstAssignableRunnerForUser;
};

export class FounderHermesSetupError extends Error {
  constructor(
    readonly code:
      | "operator_not_ready"
      | "runner_unavailable"
      | "runner_not_configured"
      | "operator_running"
      | "setup_session_active"
      | "setup_session_failed"
      | "runner_response_invalid",
    message: string,
    readonly status: 409 | 502 | 503 = 409,
  ) {
    super(message);
    this.name = "FounderHermesSetupError";
  }
}

export async function createFounderHermesSetupSessionForUser(
  userId: string,
  dependencies: FounderHermesSetupDependencies = {},
): Promise<FounderHermesSetupSessionDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const operator = await (dependencies.getOperator ?? getFounderOperatorForUser)(userId, {
      createConnection: () => connection,
    });

    if (operator?.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
      throw new FounderHermesSetupError(
        "operator_not_ready",
        "Prepare the Operator before opening Full Hermes Setup.",
      );
    }

    const runner = await (dependencies.getRunner ?? getFirstAssignableRunnerForUser)(userId, {
      createConnection: () => connection,
    });

    if (!runner) {
      throw new FounderHermesSetupError(
        "runner_unavailable",
        "A ready Operator runner is required for Full Hermes Setup.",
      );
    }

    const env = dependencies.env ?? process.env;
    const runnerToken = env[RUNNER_BEARER_TOKEN_ENV]?.trim();
    if (!runnerToken) {
      throw new FounderHermesSetupError(
        "runner_not_configured",
        "Runner authentication is unavailable.",
        503,
      );
    }

    let endpointUrl: string;
    try {
      endpointUrl = validateManualRunnerEndpointUrl(runner.endpointUrl);
    } catch {
      throw new FounderHermesSetupError(
        "setup_session_failed",
        "Full Hermes Setup could not be prepared.",
        502,
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      let response: Response;
      try {
        response = await (dependencies.fetch ?? fetch)(
          new URL(
            `/runner/v1/agents/${encodeURIComponent(operator.id)}/setup-sessions`,
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
      } catch {
        throw new FounderHermesSetupError(
          "setup_session_failed",
          "Full Hermes Setup could not be prepared.",
          502,
        );
      }

      if (!response.ok) {
        const code = await readRunnerErrorCode(response);
        if (response.status === 409 && code === "agent_running") {
          throw new FounderHermesSetupError(
            "operator_running",
            "Stop the Operator before opening Full Hermes Setup.",
          );
        }
        if (response.status === 409 && code === "setup_session_active") {
          throw new FounderHermesSetupError(
            "setup_session_active",
            "A Full Hermes Setup session is already active.",
          );
        }
        throw new FounderHermesSetupError(
          "setup_session_failed",
          "Full Hermes Setup could not be prepared.",
          response.status >= 500 ? 502 : 409,
        );
      }

      let runnerBody: unknown;
      try {
        runnerBody = await response.json();
      } catch {
        throw new FounderHermesSetupError(
          "runner_response_invalid",
          "Full Hermes Setup could not be prepared.",
          502,
        );
      }
      const parsed = parseRunnerResponse(runnerBody);
      if (!parsed) {
        throw new FounderHermesSetupError(
          "runner_response_invalid",
          "Full Hermes Setup could not be prepared.",
          502,
        );
      }

      const websocketUrl = new URL(parsed.websocketPath, normalizeBaseUrl(endpointUrl));
      websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";

      return {
        id: parsed.id,
        websocketUrl: websocketUrl.toString(),
        websocketProtocol: parsed.websocketProtocol,
        expiresAt: parsed.expiresAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

type RunnerSetupSession = {
  id: string;
  websocketPath: string;
  websocketProtocol: string;
  expiresAt: string;
};

function parseRunnerResponse(value: unknown): RunnerSetupSession | null {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.session)) return null;
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
  return {
    id: session.id,
    websocketPath: session.websocketPath,
    websocketProtocol: session.websocketProtocol,
    expiresAt: session.expiresAt,
  };
}

async function readRunnerErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.clone().json();
    return isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
      ? body.error.code
      : null;
  } catch {
    return null;
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
