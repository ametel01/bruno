import { AgentLifecyclePersistenceError, startAgentForUser } from "@/src/server/agents/lifecycle";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type StartAgentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

type StartAgentRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: StartAgentRouteContext,
  dependencies: StartAgentRouteDependencies = {},
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
    const result = await startAgentForUser(applicationUser.userId, decodedAgentId);

    if (result.ok) {
      return Response.json(result, {
        status: result.state === "accepted" ? 202 : 200,
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

    if (result.reason === "hermes_setup_incomplete") {
      return Response.json(
        {
          error: {
            code: "hermes_setup_incomplete",
            message: result.message ?? "Complete Hermes setup before starting this agent.",
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
