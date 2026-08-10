import {
  AgentCreateBlockedError,
  AgentRunnerAssignmentError,
  AgentRunnerProvisioningError,
  AgentRunnerVerificationError,
  AgentPersistenceError,
  ReadyAgentCreationDisabledError,
  ReadyAgentValidationError,
  TelegramBotInUseError,
  TelegramValidationUnavailableError,
  createAgentForUser,
  validateCreateAgentPayload,
} from "@/src/server/agents/create-agent";
import {
  AgentSecretKeyringError,
  AgentSecretLegacyBackfillRequiredError,
} from "@/src/server/agents/agent-secrets";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";
import { scheduleAgentDeploymentReconcileAfterResponse } from "@/src/server/agents/agent-deployment-triggers";
import {
  createAgentDeploymentApiAttemptRecorder,
  type AgentDeploymentApiAttemptRecorder,
} from "@/src/server/agents/agent-deployment-api-acceptance";

type CreateAgentRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  scheduleDeploymentReconcile?: typeof scheduleAgentDeploymentReconcileAfterResponse;
  apiAttemptRecorder?: AgentDeploymentApiAttemptRecorder;
};

type CreateAgentRouteContext = {
  params: Promise<unknown>;
};

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  _context?: CreateAgentRouteContext,
  dependencies: CreateAgentRouteDependencies = {},
) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  const validation = validateCreateAgentPayload(payload);

  if (!validation.ok) {
    return validationResponse(validation.issues);
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  const recorder = productionApiAttemptRecorder(dependencies.apiAttemptRecorder);
  let attemptId: string | null = null;
  if (recorder && "launchMode" in validation.value) {
    try {
      attemptId = await recorder.begin("create_ready");
    } catch {
      return apiEvidenceUnavailableResponse();
    }
  }

  try {
    const body =
      "launchMode" in validation.value
        ? await createAgentForUser(applicationUser.userId, validation.value, {
            onReadyDeploymentCommitted:
              dependencies.scheduleDeploymentReconcile ??
              scheduleAgentDeploymentReconcileAfterResponse,
          })
        : await createAgentForUser(applicationUser.userId, validation.value);

    if (recorder && attemptId && "deployment" in body) {
      await recorder
        .finish({ attemptId, kind: "create_ready", phase: "accepted" })
        .catch(() => undefined);
    }
    return Response.json(body, {
      status: "deployment" in body ? 202 : 201,
    });
  } catch (error) {
    if (recorder && attemptId) {
      await recorder
        .finish({
          attemptId,
          kind: "create_ready",
          phase: "outcome_unknown",
          safeCode: "request_failed",
        })
        .catch(() => undefined);
    }
    if (error instanceof ReadyAgentValidationError) {
      return validationResponse(error.issues);
    }

    if (error instanceof ReadyAgentCreationDisabledError) {
      return Response.json(
        {
          error: {
            code:
              error.reason === "invalid_configuration"
                ? "ready_agent_creation_invalid_config"
                : "ready_agent_creation_disabled",
            message: "Automatic ready agent creation is not enabled.",
          },
        },
        { status: 503 },
      );
    }

    if (error instanceof TelegramValidationUnavailableError) {
      return Response.json(
        {
          error: {
            code: "telegram_validation_unavailable",
            message: "Telegram bot validation is temporarily unavailable.",
          },
        },
        { status: 503 },
      );
    }

    if (error instanceof TelegramBotInUseError) {
      return Response.json(
        {
          error: {
            code: "telegram_bot_in_use",
            message: "Telegram bot is already assigned to an active agent.",
          },
        },
        { status: 409 },
      );
    }

    if (
      error instanceof AgentSecretKeyringError ||
      error instanceof AgentSecretLegacyBackfillRequiredError
    ) {
      return Response.json(
        {
          error: {
            code: "agent_secret_configuration_invalid",
            message: "Agent secret storage is not configured safely.",
          },
        },
        { status: 503 },
      );
    }

    if (error instanceof AgentCreateBlockedError) {
      return createBlockedResponse(error);
    }

    if (error instanceof AgentRunnerAssignmentError) {
      return Response.json(
        {
          error: {
            code: "runner_not_assignable",
            message: "Runner could not be assigned to this agent.",
          },
        },
        { status: 404 },
      );
    }

    if (error instanceof AgentRunnerProvisioningError) {
      return runnerProvisioningErrorResponse(error);
    }

    if (error instanceof AgentRunnerVerificationError) {
      return Response.json(
        {
          error: {
            code: "runner_verification_unavailable",
            message: "Runner availability could not be verified safely. Try again shortly.",
          },
        },
        { status: 503 },
      );
    }

    if (error instanceof AgentPersistenceError) {
      return persistenceErrorResponse(error);
    }

    throw error;
  }
}

function productionApiAttemptRecorder(
  injected: AgentDeploymentApiAttemptRecorder | undefined,
): AgentDeploymentApiAttemptRecorder | null {
  if (injected) return injected;
  return process.env.VERCEL_ENV === "production" ? createAgentDeploymentApiAttemptRecorder() : null;
}

function apiEvidenceUnavailableResponse() {
  return Response.json(
    {
      error: {
        code: "deployment_api_evidence_unavailable",
        message: "Deployment request evidence is temporarily unavailable.",
      },
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

function authenticationResponse(
  result: Exclude<ConfiguredApplicationUserResolution, { ok: true }>,
) {
  return Response.json(
    {
      error: {
        code: result.code,
        message:
          result.status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status: result.status },
  );
}

function runnerProvisioningErrorResponse(error: AgentRunnerProvisioningError) {
  if (error.reason === "provider_not_configured") {
    return Response.json(
      {
        error: {
          code: "runner_provisioning_not_configured",
          message:
            "Cloud runner provisioning is not configured. Add DigitalOcean and runner credentials, then try again.",
        },
      },
      { status: 503 },
    );
  }

  return Response.json(
    {
      error: {
        code: "runner_provisioning_failed",
        message:
          "Cloud runner provisioning could not be started. Check runner provisioning status.",
      },
    },
    { status: 502 },
  );
}

function validationResponse(issues: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues,
      },
    },
    {
      status: 400,
    },
  );
}

function createBlockedResponse(error: AgentCreateBlockedError) {
  if (error.reason === "plan_limit_reached") {
    return Response.json(
      {
        error: {
          code: "plan_limit_reached",
          message: "Agent plan limit reached.",
          currentAgents: error.currentAgents,
          maxAgents: error.maxAgents,
        },
      },
      {
        status: 409,
      },
    );
  }

  return Response.json(
    {
      error: {
        code: "runner_capacity_reached",
        message: "Runner capacity reached.",
      },
    },
    {
      status: 409,
    },
  );
}

function persistenceErrorResponse(error: AgentPersistenceError) {
  if (hasErrorCode(error.cause, ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])) {
    return Response.json(
      {
        error: {
          code: "database_unavailable",
          message:
            "Database is unavailable. Start Postgres and run migrations before creating agents.",
        },
      },
      {
        status: 503,
      },
    );
  }

  if (hasErrorCode(error.cause, ["42P01", "42704"])) {
    return Response.json(
      {
        error: {
          code: "database_schema_missing",
          message: "Database schema is missing. Run migrations before creating agents.",
        },
      },
      {
        status: 503,
      },
    );
  }

  return Response.json(
    {
      error: {
        code: "agent_create_failed",
        message: "Agent could not be created.",
      },
    },
    {
      status: 500,
    },
  );
}

function hasErrorCode(value: unknown, codes: string[], depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) {
    return false;
  }

  const code = "code" in value ? value.code : undefined;

  if (typeof code === "string" && codes.includes(code)) {
    return true;
  }

  const cause = "cause" in value ? value.cause : undefined;

  return hasErrorCode(cause, codes, depth + 1);
}
