import {
  AgentDetailPersistenceError,
  getActiveAgentForUser,
} from "@/src/server/agents/list-agents";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  getLifecycleManualRunnerAdapter,
  getLifecycleRunnerAdapterForUser,
} from "@/src/server/agents/lifecycle";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  type AgentLogDto,
  type AgentLogPage,
  listAgentLogsForUser,
} from "@/src/server/logs/agent-logs";
import { getAssignedRunnerForActiveAgentForUser } from "@/src/server/runners/manual-runner-persistence";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type AgentLogsRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

type AgentLogsRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

type ParsedIntegerQuery =
  | {
      ok: true;
      value?: number;
    }
  | {
      ok: false;
    };

const MAX_ROUTE_AGENT_LOG_LIMIT = 100;

type PublicAgentLogDto = Omit<
  AgentLogDto,
  "id" | "agentId" | "runnerId" | "localRunnerProcessId" | "dockerRunnerContainerId" | "metadata"
>;

type PublicAgentLogPage = {
  logs: PublicAgentLogDto[];
  nextAfter: number | null;
};

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: AgentLogsRouteContext,
  dependencies: AgentLogsRouteDependencies = {},
) {
  const params = await context.params;
  const decodedAgentId = decodeAgentId(params.agentId ?? "");

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  const requestUrl = new URL(request.url);
  const parsedAfter = parseAfter(requestUrl);
  const parsedLimit = parseLimit(requestUrl);

  if (!parsedAfter.ok) {
    return validationResponse("After must be a non-negative safe integer.");
  }

  if (!parsedLimit.ok) {
    return validationResponse("Limit must be a positive integer.");
  }

  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser);
  }

  let connection: DatabaseConnection | null = null;

  try {
    const routeConnection = createDatabaseConnection();
    connection = routeConnection;

    const activeAgent = await getActiveAgentForUser(applicationUser.userId, decodedAgentId.value, {
      createConnection: () => routeConnection,
    });

    if (!activeAgent) {
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

    let page: AgentLogPage;

    if (activeAgent.status === "running") {
      const assignedRunner = await getAssignedRunnerForActiveAgentForUser(
        applicationUser.userId,
        decodedAgentId.value,
        {
          createConnection: () => routeConnection,
        },
      );
      const runnerAdapter = assignedRunner
        ? getLifecycleManualRunnerAdapter(assignedRunner, {
            createConnection: () => routeConnection,
          })
        : getLifecycleRunnerAdapterForUser(applicationUser.userId, {
            createConnection: () => routeConnection,
          });

      page = await runnerAdapter.streamLogs({
        agentId: decodedAgentId.value,
        ...(parsedAfter.value === undefined ? {} : { after: parsedAfter.value }),
        ...(parsedLimit.value === undefined ? {} : { limit: parsedLimit.value }),
      });
    } else {
      page = await listAgentLogsForUser({
        db: routeConnection.db,
        userId: applicationUser.userId,
        agentId: decodedAgentId.value,
        ...(parsedAfter.value === undefined ? {} : { after: parsedAfter.value }),
        ...(parsedLimit.value === undefined ? {} : { limit: parsedLimit.value }),
      });
    }

    return Response.json(toPublicAgentLogPage(page));
  } catch (error) {
    if (error instanceof AgentDetailPersistenceError || error instanceof Error) {
      return Response.json(
        {
          error: {
            code: "agent_logs_failed",
            message: "Agent logs could not be loaded.",
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

function toPublicAgentLogPage(page: AgentLogPage): PublicAgentLogPage {
  return {
    logs: page.logs.map(toPublicAgentLog),
    nextAfter: page.nextAfter,
  };
}

function toPublicAgentLog(log: AgentLogDto): PublicAgentLogDto {
  return {
    source: log.source,
    stream: log.stream,
    level: log.level,
    message: summarizeOperationalText(log.message, "Log details omitted."),
    sequence: log.sequence,
    createdAt: log.createdAt,
  };
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

function parseAfter(requestUrl: URL): ParsedIntegerQuery {
  const rawAfter = parseSingleQueryValue(requestUrl, "after");

  if (rawAfter === false) {
    return { ok: false };
  }

  if (rawAfter === null) {
    return { ok: true };
  }

  const parsedAfter = parseUnsignedInteger(rawAfter);

  if (parsedAfter === null) {
    return { ok: false };
  }

  return {
    ok: true,
    value: parsedAfter,
  };
}

function parseLimit(requestUrl: URL): ParsedIntegerQuery {
  const rawLimit = parseSingleQueryValue(requestUrl, "limit");

  if (rawLimit === false) {
    return { ok: false };
  }

  if (rawLimit === null) {
    return { ok: true };
  }

  const parsedLimit = parseUnsignedInteger(rawLimit);

  if (parsedLimit === null || parsedLimit < 1) {
    return { ok: false };
  }

  return {
    ok: true,
    value: Math.min(parsedLimit, MAX_ROUTE_AGENT_LOG_LIMIT),
  };
}

function parseSingleQueryValue(requestUrl: URL, key: string): string | null | false {
  const values = requestUrl.searchParams.getAll(key);

  if (values.length > 1) {
    return false;
  }

  return values[0] ?? null;
}

function parseUnsignedInteger(rawValue: string): number | null {
  const trimmedValue = rawValue.trim();

  if (!/^\d+$/.test(trimmedValue)) {
    return null;
  }

  const value = Number(trimmedValue);

  if (!Number.isSafeInteger(value)) {
    return null;
  }

  return value;
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
