import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  AgentRuntimeReadPersistenceError,
  getAgentRuntimePresentationForUser,
} from "@/src/server/agents/agent-runtime-read";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type AgentRuntimeRouteContext = {
  params: Promise<{ agentId?: string }>;
};

type AgentRuntimeRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  createConnection?: () => DatabaseConnection;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: AgentRuntimeRouteContext,
  dependencies: AgentRuntimeRouteDependencies = {},
) {
  const decodedAgentId = await decodeAgentId(context);

  if (decodedAgentId === null) {
    return jsonNoStore(
      { error: { code: "validation_failed", message: "Agent ID must be a valid UUID." } },
      { status: 400 },
    );
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await connection.db.transaction((tx) =>
      getAgentRuntimePresentationForUser({
        db: tx,
        userId: applicationUser.userId,
        agentId: decodedAgentId,
      }),
    );

    if (!result.ok) {
      return jsonNoStore(
        { error: { code: "agent_not_found", message: "Agent could not be found." } },
        { status: 404 },
      );
    }

    return jsonNoStore({ runtime: result.runtime });
  } catch (error) {
    if (error instanceof AgentRuntimeReadPersistenceError || error instanceof Error) {
      return jsonNoStore(
        {
          error: {
            code: "agent_runtime_failed",
            message: "Agent runtime status could not be loaded.",
          },
        },
        { status: 500 },
      );
    }

    throw error;
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function authenticationResponse(
  result: Exclude<ConfiguredApplicationUserResolution, { ok: true }>,
) {
  return jsonNoStore(
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

async function decodeAgentId(context: AgentRuntimeRouteContext): Promise<string | null> {
  const { agentId = "" } = await context.params;

  try {
    const decoded = decodeURIComponent(agentId).trim();
    return isValidAgentId(decoded) ? decoded : null;
  } catch (error) {
    if (error instanceof URIError) {
      return null;
    }
    throw error;
  }
}

function jsonNoStore(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "private, no-store, max-age=0");
  return Response.json(value, { ...init, headers });
}
