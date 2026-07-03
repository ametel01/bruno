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
