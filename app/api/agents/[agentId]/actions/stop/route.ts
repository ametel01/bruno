import { AgentLifecyclePersistenceError, stopAgentForUser } from "@/src/server/agents/lifecycle";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type StopAgentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

type StopAgentRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: StopAgentRouteContext,
  dependencies: StopAgentRouteDependencies = {},
) {
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

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  try {
    const result = await stopAgentForUser(applicationUser.userId, decodedAgentId);

    if (result.ok) {
      return Response.json(result);
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

    if (result.reason === "runner_stop_failed") {
      return Response.json(
        {
          error: {
            code: "agent_stop_failed",
            message: "Agent could not be stopped.",
          },
        },
        {
          status: 500,
        },
      );
    }

    return Response.json(
      {
        error: {
          code: "invalid_agent_status",
          message: "Agent cannot be stopped from its current status.",
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
            code: "agent_stop_failed",
            message: "Agent could not be stopped.",
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
