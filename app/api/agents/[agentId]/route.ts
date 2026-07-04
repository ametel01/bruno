import {
  AgentLifecyclePersistenceError,
  deleteAgentForDevelopmentUser,
} from "@/src/server/agents/lifecycle";
import {
  AgentConfigUpdatePersistenceError,
  updateAgentConfigForDevelopmentUser,
  validateUpdateAgentConfigPayload,
} from "@/src/server/agents/update-agent-config";

type DeleteAgentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: DeleteAgentRouteContext) {
  const decodedAgentId = await decodeAgentId(context);

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationIssuesResponse([
      { field: "body", message: "Request body must be valid JSON." },
    ]);
  }

  const validation = validateUpdateAgentConfigPayload(payload);

  if (!validation.ok) {
    return validationIssuesResponse(validation.issues);
  }

  try {
    const result = await updateAgentConfigForDevelopmentUser(
      decodedAgentId.agentId,
      validation.value,
    );

    if (result.ok) {
      return Response.json(result);
    }

    if (result.reason === "missing_agent_id" || result.reason === "malformed_agent_id") {
      return validationResponse("Agent ID must be a valid UUID.");
    }

    if (result.reason === "validation_failed") {
      return validationIssuesResponse(result.issues);
    }

    return Response.json(
      {
        error: {
          code: "agent_not_found",
          message: "Agent could not be found.",
        },
      },
      {
        status: 404,
      },
    );
  } catch (error) {
    if (error instanceof AgentConfigUpdatePersistenceError) {
      return configPersistenceErrorResponse(error);
    }

    throw error;
  }
}

export async function DELETE(_request: Request, context: DeleteAgentRouteContext) {
  const decodedAgentId = await decodeAgentId(context);

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  try {
    const result = await deleteAgentForDevelopmentUser(decodedAgentId.agentId);

    if (result.ok) {
      return Response.json(result);
    }

    if (result.reason === "missing_agent_id" || result.reason === "malformed_agent_id") {
      return validationResponse("Agent ID must be a valid UUID.");
    }

    if (result.reason === "agent_not_found") {
      return Response.json(
        {
          error: {
            code: "agent_not_found",
            message: "Agent could not be found.",
          },
        },
        {
          status: 404,
        },
      );
    }

    return Response.json(
      {
        error: {
          code: "invalid_agent_status",
          message: "Agent cannot be deleted from its current status.",
          status: result.status,
        },
      },
      {
        status: 409,
      },
    );
  } catch (error) {
    if (error instanceof AgentLifecyclePersistenceError) {
      return Response.json(
        {
          error: {
            code: "agent_delete_failed",
            message: "Agent could not be deleted.",
          },
        },
        {
          status: 500,
        },
      );
    }

    throw error;
  }
}

async function decodeAgentId(context: DeleteAgentRouteContext): Promise<
  | {
      ok: true;
      agentId: string;
    }
  | {
      ok: false;
    }
> {
  const params = await context.params;
  const agentId = params.agentId ?? "";

  try {
    return {
      ok: true,
      agentId: decodeURIComponent(agentId),
    };
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false };
    }

    throw error;
  }
}

function validationResponse(message: string) {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message,
      },
    },
    {
      status: 400,
    },
  );
}

function validationIssuesResponse(issues: Array<{ field: string; message: string }>) {
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

function configPersistenceErrorResponse(error: AgentConfigUpdatePersistenceError) {
  if (hasErrorCode(error.cause, ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])) {
    return Response.json(
      {
        error: {
          code: "database_unavailable",
          message:
            "Database is unavailable. Start Postgres and run migrations before updating agent config.",
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
          message: "Database schema is missing. Run migrations before updating agent config.",
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
        code: "agent_config_update_failed",
        message: "Agent config could not be updated.",
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
