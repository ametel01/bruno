import "server-only";

import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import {
  readDecryptedActiveAgentSecretsForUser,
  type AgentSecretKind,
} from "@/src/server/agents/agent-secrets";
import {
  AGENT_LAUNCH_SPEC_VERSION,
  type AgentLaunchSpec,
  parseAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agents } from "@/src/server/db/schema";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";

export type AgentLaunchSpecBuildResult =
  | { ok: true; spec: AgentLaunchSpec }
  | {
      ok: false;
      reason:
        | "missing_agent_id"
        | "malformed_agent_id"
        | "agent_not_found"
        | "hermes_setup_incomplete"
        | "launch_spec_invalid";
      message: string;
    };

export type AgentLaunchSpecBuilderDependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  hermesWorkloadImage?: string;
  requestId?: () => string;
};

type AgentLaunchConfigRow = {
  agent: typeof agents.$inferSelect;
  config: typeof agentConfigs.$inferSelect;
};

const REQUIRED_SECRET_MESSAGES = {
  api_server_key: "Run Hermes setup before starting this agent.",
} as const satisfies Partial<Record<AgentSecretKind, string>>;

export async function buildHermesAgentLaunchSpecForUser(
  userId: string,
  agentId: string,
  dependencies: AgentLaunchSpecBuilderDependencies = {},
): Promise<AgentLaunchSpecBuildResult> {
  const normalizedAgentId = agentId.trim();

  if (!normalizedAgentId) {
    return {
      ok: false,
      reason: "missing_agent_id",
      message: "Agent ID is required.",
    };
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalizedAgentId,
    )
  ) {
    return {
      ok: false,
      reason: "malformed_agent_id",
      message: "Agent ID must be a valid UUID.",
    };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const row = await readAgentLaunchConfig(connection, userId, normalizedAgentId);

    if (!row) {
      return {
        ok: false,
        reason: "agent_not_found",
        message: "Agent was not found.",
      };
    }

    const decrypted = await readDecryptedActiveAgentSecretsForUser(userId, normalizedAgentId, {
      createConnection: () => connection,
      ...(dependencies.env ? { env: dependencies.env } : {}),
      kind: "api_server_key",
    });

    if (!decrypted.ok) {
      return {
        ok: false,
        reason: decrypted.reason,
        message: "Agent secrets could not be loaded.",
      };
    }

    for (const kind of Object.keys(REQUIRED_SECRET_MESSAGES) as Array<
      keyof typeof REQUIRED_SECRET_MESSAGES
    >) {
      if (!decrypted.secrets[kind]) {
        return {
          ok: false,
          reason: "hermes_setup_incomplete",
          message: REQUIRED_SECRET_MESSAGES[kind],
        };
      }
    }

    const spec = {
      version: AGENT_LAUNCH_SPEC_VERSION,
      requestId: dependencies.requestId?.() ?? randomUUID(),
      agent: {
        id: row.agent.id,
        name: row.agent.name,
        templateKey: row.agent.templateKey,
        templateVersion: row.agent.templateVersion,
        configRevision: `cfg-${row.config.updatedAt.getTime()}`,
      },
      image: {
        ref: dependencies.hermesWorkloadImage?.trim() || DEFAULT_HERMES_WORKLOAD_IMAGE,
      },
      model: {
        provider: "hermes",
        model: "configured-by-hermes",
      },
      schedule: {
        mode: row.config.scheduleMode,
        cron: row.config.scheduleCron,
        timezone: row.config.timezone,
      },
      prompt: {
        soul: row.config.systemPrompt,
      },
      runtime: {
        dataDir: "/opt/data",
        workspaceDir: "/workspace",
        terminalCwd: "/workspace",
        browserEnabled: false,
        unattendedLoopLimit: 25,
      },
      tools: {
        enabled: ["file_operations", "terminal"],
        disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
      },
      secrets: {
        kind: "inline",
        apiServerKey: decrypted.secrets.api_server_key ?? "",
      },
    } satisfies AgentLaunchSpec;
    const parsed = parseAgentLaunchSpec(spec);

    if (!parsed.ok) {
      return {
        ok: false,
        reason: "launch_spec_invalid",
        message: "Hermes launch spec could not be built.",
      };
    }

    return { ok: true, spec: parsed.spec };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function readAgentLaunchConfig(
  connection: DatabaseConnection,
  userId: string,
  agentId: string,
): Promise<AgentLaunchConfigRow | null> {
  const [row] = await connection.db
    .select({
      agent: agents,
      config: agentConfigs,
    })
    .from(agents)
    .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.deletedAt)))
    .limit(1);

  return row ?? null;
}
