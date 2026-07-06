import {
  AgentLifecyclePersistenceError,
  startAgentForDevelopmentUser,
} from "@/src/server/agents/lifecycle";

type StartAgentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: StartAgentRouteContext) {
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
    const result = await startAgentForDevelopmentUser(decodedAgentId);

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

    if (result.reason === "runner_start_failed") {
      return Response.json(
        {
          error: {
            code: "agent_start_failed",
            message: "Agent could not be started.",
          },
        },
        {
          status: 500,
        },
      );
    }

    if (result.reason === "plan_limit_reached") {
      return Response.json(
        {
          error: {
            code: "plan_limit_reached",
            message: "Agent plan limit reached.",
            currentAgents: result.currentAgents,
            maxAgents: result.maxAgents,
          },
        },
        {
          status: 409,
        },
      );
    }

    if (result.reason === "runner_capacity_reached") {
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

    if (result.reason === "no_online_runner") {
      return Response.json(
        {
          error: {
            code: "no_online_runner",
            message: "No online runner is available yet.",
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
          code: "invalid_agent_status",
          message: "Agent cannot be started from its current status.",
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
            code: "agent_start_failed",
            message: "Agent could not be started.",
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
