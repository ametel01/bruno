import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listAgentEventFeedForUser } from "@/src/server/events/agent-events";
import {
  type OperationalApplicationUserResolution,
  requireOperationalApplicationUser,
} from "@/src/server/users/operational-application-user";

type AgentEventsRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

type AgentEventsRouteDependencies = {
  requireApplicationUser?: typeof requireOperationalApplicationUser;
};

type ParsedLimit =
  | {
      ok: true;
      value?: number;
    }
  | {
      ok: false;
    };

const MAX_ROUTE_EVENT_FEED_LIMIT = 100;

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: AgentEventsRouteContext,
  dependencies: AgentEventsRouteDependencies = {},
) {
  const params = await context.params;
  const decodedAgentId = decodeAgentId(params.agentId ?? "");

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  const requestUrl = new URL(request.url);
  const cursor = parseSingleQueryValue(requestUrl, "cursor");
  const parsedLimit = parseLimit(requestUrl);

  if (cursor === false) {
    return validationResponse("Cursor must be provided at most once.");
  }

  if (!parsedLimit.ok) {
    return validationResponse("Limit must be a positive integer.");
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireOperationalApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  let connection: DatabaseConnection | null = null;

  try {
    const routeConnection = createDatabaseConnection();
    connection = routeConnection;

    const result = await routeConnection.db.transaction((tx) =>
      listAgentEventFeedForUser({
        db: tx,
        userId: applicationUser.userId,
        agentId: decodedAgentId.value,
        cursor,
        ...(parsedLimit.value === undefined ? {} : { limit: parsedLimit.value }),
      }),
    );

    if (!result.ok) {
      if ("reason" in result && result.reason === "agent_not_found") {
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

      return validationResponse("Cursor must be a valid event feed cursor.");
    }

    return Response.json(result.page);
  } catch (error) {
    if (error instanceof Error) {
      return Response.json(
        {
          error: {
            code: "agent_events_failed",
            message: "Agent events could not be loaded.",
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
  result: Exclude<OperationalApplicationUserResolution, { ok: true }>,
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

function decodeAgentId(agentId: string):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
    } {
  let decodedAgentId: string;

  try {
    decodedAgentId = decodeURIComponent(agentId).trim();
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false };
    }

    throw error;
  }

  if (!isValidAgentId(decodedAgentId)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: decodedAgentId,
  };
}

function parseSingleQueryValue(requestUrl: URL, key: string): string | null | false {
  const values = requestUrl.searchParams.getAll(key);

  if (values.length > 1) {
    return false;
  }

  return values[0] ?? null;
}

function parseLimit(requestUrl: URL): ParsedLimit {
  const rawLimit = parseSingleQueryValue(requestUrl, "limit");

  if (rawLimit === false) {
    return { ok: false };
  }

  if (rawLimit === null) {
    return { ok: true };
  }

  const trimmedLimit = rawLimit.trim();

  if (!/^\d+$/.test(trimmedLimit)) {
    return { ok: false };
  }

  const limit = Number(trimmedLimit);

  if (!Number.isSafeInteger(limit) || limit < 1) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Math.min(limit, MAX_ROUTE_EVENT_FEED_LIMIT),
  };
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
