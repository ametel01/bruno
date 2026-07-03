import {
  AgentPersistenceError,
  createAgentForDevelopmentUser,
  validateCreateAgentPayload,
} from "@/src/server/agents/create-agent";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
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

  try {
    const body = await createAgentForDevelopmentUser(validation.value);

    return Response.json(body, {
      status: 201,
    });
  } catch (error) {
    if (error instanceof AgentPersistenceError) {
      return persistenceErrorResponse(error);
    }

    throw error;
  }
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
