import { isValidAgentId } from "@/src/server/agents/agent-id";
import { retryAgentDeploymentForUser } from "@/src/server/agents/agent-deployment-retry";
import { scheduleAgentDeploymentReconcileAfterResponse } from "@/src/server/agents/agent-deployment-triggers";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type RetryRouteContext = {
  params: Promise<{ agentId?: string }>;
};

type RetryRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  retryDeployment?: typeof retryAgentDeploymentForUser;
  scheduleDeploymentReconcile?: typeof scheduleAgentDeploymentReconcileAfterResponse;
};

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: RetryRouteContext,
  dependencies: RetryRouteDependencies = {},
) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationResponse();
  }

  if (!isRetryPayload(payload)) {
    return validationResponse();
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  const params = await context.params;
  const agentId = decodeAgentId(params.agentId);

  if (!agentId) {
    return validationResponse();
  }

  const result = await (dependencies.retryDeployment ?? retryAgentDeploymentForUser)({
    userId: applicationUser.userId,
    agentId,
    idempotencyKey: payload.idempotencyKey,
    dependencies: {
      onDeploymentCommitted:
        dependencies.scheduleDeploymentReconcile ?? scheduleAgentDeploymentReconcileAfterResponse,
    },
  });

  if (result.ok) {
    return Response.json({ deployment: result.deployment }, { status: 202 });
  }

  if (result.reason === "agent_not_found") {
    return Response.json(
      { error: { code: "agent_not_found", message: "Agent was not found." } },
      { status: 404 },
    );
  }

  if (result.reason === "deployment_not_retryable") {
    return Response.json(
      {
        error: {
          code: "deployment_not_retryable",
          message: "Deployment is not retryable.",
        },
      },
      { status: 409 },
    );
  }

  if (result.reason === "invalid_idempotency_key") {
    return validationResponse();
  }

  return Response.json(
    {
      error: {
        code: "deployment_retry_failed",
        message: "Deployment retry could not be persisted.",
      },
    },
    { status: 500 },
  );
}

function decodeAgentId(value: string | undefined): string | null {
  try {
    const decoded = decodeURIComponent(value ?? "").trim();
    return isValidAgentId(decoded) ? decoded : null;
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }

    throw error;
  }
}

function isRetryPayload(value: unknown): value is { idempotencyKey: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const keys = Object.keys(value);

  return (
    keys.length === 1 &&
    keys[0] === "idempotencyKey" &&
    typeof (value as { idempotencyKey?: unknown }).idempotencyKey === "string"
  );
}

function validationResponse() {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
      },
    },
    { status: 400 },
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
