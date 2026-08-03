import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AgentDeploymentPersistenceError,
  getLatestAgentDeploymentForUser,
} from "@/src/server/agents/agent-deployments";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type AgentDeploymentRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

type AgentDeploymentRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: AgentDeploymentRouteContext,
  dependencies: AgentDeploymentRouteDependencies = {},
) {
  const decodedAgentId = await decodeAgentId(context);

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  let connection: DatabaseConnection | null = null;

  try {
    connection = createDatabaseConnection();
    const result = await connection.db.transaction((tx) =>
      getLatestAgentDeploymentForUser({
        db: tx,
        userId: applicationUser.userId,
        agentId: decodedAgentId.agentId,
      }),
    );

    if (!result.ok) {
      if (result.reason === "invalid_agent_id") {
        return validationResponse("Agent ID must be a valid UUID.");
      }

      return agentNotFoundResponse();
    }

    return Response.json({
      deployment: result.deployment,
    });
  } catch (error) {
    if (error instanceof AgentDeploymentPersistenceError || error instanceof Error) {
      return Response.json(
        {
          error: {
            code: "agent_deployment_failed",
            message: "Agent deployment could not be loaded.",
          },
        },
        {
          status: 500,
        },
      );
    }

    throw error;
  } finally {
    await connection?.close();
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

async function decodeAgentId(context: AgentDeploymentRouteContext): Promise<
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
    const decodedAgentId = decodeURIComponent(agentId).trim();

    if (!isValidAgentId(decodedAgentId)) {
      return { ok: false };
    }

    return {
      ok: true,
      agentId: decodedAgentId,
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

function agentNotFoundResponse() {
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
