import {
  AgentLifecyclePersistenceError,
  restartAgentForDevelopmentUser,
} from "@/src/server/agents/lifecycle";

type RestartAgentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: RestartAgentRouteContext) {
  const params = await context.params;
  const agentId = params.agentId ?? "";
  let decodedAgentId: string;

  try {
    decodedAgentId = decodeURIComponent(agentId);
  } catch (error) {
    if (error instanceof URIError) {
      return validationResponse();
    }

    throw error;
  }

  try {
    const result = await restartAgentForDevelopmentUser(decodedAgentId);

    if (result.ok) {
      return Response.json(result, {
        status: 202,
      });
    }

    if (result.reason === "missing_agent_id" || result.reason === "malformed_agent_id") {
      return validationResponse();
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
          message: "Agent cannot be restarted from its current status.",
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
            code: "agent_restart_failed",
            message: "Agent could not be restarted.",
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

function validationResponse() {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    },
    {
      status: 400,
    },
  );
}
