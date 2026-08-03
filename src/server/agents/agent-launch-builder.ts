import "server-only";

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  readRequiredDecryptedActiveAgentSecretsInTransaction,
  type AgentSecretKind,
} from "@/src/server/agents/agent-secrets";
import {
  AGENT_LAUNCH_SPEC_VERSION,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
  type AgentLaunchSpec,
  parseAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { validateDeploymentConfigRevision } from "@/src/server/agents/deployment-state";
import { getApprovedOpenRouterModel } from "@/src/server/agents/openrouter-models";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentDeployments, agents } from "@/src/server/db/schema";
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
        | "managed_deployment_missing"
        | "managed_configuration_invalid"
        | "required_secret_missing"
        | "required_secret_revoked"
        | "secret_storage_unavailable"
        | "secret_decryption_failed"
        | "launch_spec_invalid";
      message: string;
      kind?: AgentSecretKind;
    };

export type AgentLaunchSpecBuilderDependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  hermesWorkloadImage?: string;
  requestId?: () => string;
  /** Trusted runtime-controller override; never accepted from an HTTP payload. */
  trustedConfigRevision?: string;
};

type AgentLaunchTransaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

type AgentLaunchConfigRow = {
  agent: typeof agents.$inferSelect;
  config: typeof agentConfigs.$inferSelect;
  deployment: typeof agentDeployments.$inferSelect | null;
};

const REQUIRED_NATIVE_SECRET_KINDS = [
  "api_server_key",
] as const satisfies readonly AgentSecretKind[];
const REQUIRED_MANAGED_SECRET_KINDS = [
  "openrouter_api_key",
  "telegram_bot_token",
  "telegram_allowed_users",
  "api_server_key",
] as const satisfies readonly AgentSecretKind[];

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
    return await connection.db.transaction(
      async (tx) => {
        const row = await readAgentLaunchConfig(tx, userId, normalizedAgentId);

        if (!row) {
          return {
            ok: false,
            reason: "agent_not_found",
            message: "Agent was not found.",
          };
        }

        if (isManagedLaunchRow(row)) {
          return await buildManagedLaunchSpec({ row, userId, tx, dependencies });
        }

        if (row.deployment && row.config.modelProvider === "openrouter") {
          return {
            ok: false,
            reason: "managed_configuration_invalid",
            message: "Managed Hermes configuration is invalid.",
          };
        }

        return await buildNativeLaunchSpec({ row, userId, tx, dependencies });
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  } catch {
    return {
      ok: false,
      reason: "secret_storage_unavailable",
      message: "Agent secrets could not be loaded.",
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function isManagedLaunchRow(row: AgentLaunchConfigRow): boolean {
  return (
    row.deployment !== null &&
    row.config.modelProvider === "openrouter" &&
    getApprovedOpenRouterModel(row.config.modelName) !== null
  );
}

async function buildNativeLaunchSpec(input: {
  row: AgentLaunchConfigRow;
  userId: string;
  tx: AgentLaunchTransaction;
  dependencies: AgentLaunchSpecBuilderDependencies;
}): Promise<AgentLaunchSpecBuildResult> {
  const decrypted = await readRequiredDecryptedActiveAgentSecretsInTransaction(input.tx, {
    userId: input.userId,
    agentId: input.row.agent.id,
    ...(input.dependencies.env ? { env: input.dependencies.env } : {}),
    kinds: REQUIRED_NATIVE_SECRET_KINDS,
  });

  if (!decrypted.ok) {
    if (
      decrypted.reason === "required_secret_missing" ||
      decrypted.reason === "required_secret_revoked"
    ) {
      return {
        ok: false,
        reason: "hermes_setup_incomplete",
        message: "Run Hermes setup before starting this agent.",
      };
    }

    return {
      ok: false,
      reason: decrypted.reason,
      message: "Agent secrets could not be loaded.",
      ...(decrypted.kind ? { kind: decrypted.kind } : {}),
    };
  }

  const spec = {
    version: AGENT_LAUNCH_SPEC_VERSION,
    requestId: input.dependencies.requestId?.() ?? randomUUID(),
    agent: {
      id: input.row.agent.id,
      name: input.row.agent.name,
      templateKey: input.row.agent.templateKey,
      templateVersion: input.row.agent.templateVersion,
      configRevision: `cfg-${input.row.config.updatedAt.getTime()}`,
    },
    image: {
      ref: input.dependencies.hermesWorkloadImage?.trim() || DEFAULT_HERMES_WORKLOAD_IMAGE,
    },
    model: {
      provider: "hermes",
      model: "configured-by-hermes",
    },
    schedule: {
      mode: input.row.config.scheduleMode,
      cron: input.row.config.scheduleCron,
      timezone: input.row.config.timezone,
    },
    prompt: {
      soul: input.row.config.systemPrompt,
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
      apiServerKey: decrypted.secrets.api_server_key,
    },
  } satisfies AgentLaunchSpec;

  return parseBuiltSpec(spec);
}

async function buildManagedLaunchSpec(input: {
  row: AgentLaunchConfigRow;
  userId: string;
  tx: AgentLaunchTransaction;
  dependencies: AgentLaunchSpecBuilderDependencies;
}): Promise<AgentLaunchSpecBuildResult> {
  const model = getApprovedOpenRouterModel(input.row.config.modelName);

  if (!input.row.deployment || input.row.config.modelProvider !== "openrouter" || !model) {
    return {
      ok: false,
      reason: "managed_configuration_invalid",
      message: "Managed Hermes configuration is invalid.",
    };
  }

  const configRevision =
    input.dependencies.trustedConfigRevision === undefined
      ? input.row.deployment.configRevision
      : validateDeploymentConfigRevision(input.dependencies.trustedConfigRevision)
        ? input.dependencies.trustedConfigRevision
        : null;

  if (!configRevision) {
    return {
      ok: false,
      reason: "managed_configuration_invalid",
      message: "Managed Hermes configuration is invalid.",
    };
  }

  const decrypted = await readRequiredDecryptedActiveAgentSecretsInTransaction(input.tx, {
    userId: input.userId,
    agentId: input.row.agent.id,
    ...(input.dependencies.env ? { env: input.dependencies.env } : {}),
    kinds: REQUIRED_MANAGED_SECRET_KINDS,
  });

  if (!decrypted.ok) {
    return {
      ok: false,
      reason: decrypted.reason,
      message: "Managed Hermes secrets could not be loaded.",
      ...(decrypted.kind ? { kind: decrypted.kind } : {}),
    };
  }

  const spec = {
    version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
    requestId: input.dependencies.requestId?.() ?? randomUUID(),
    agent: {
      id: input.row.agent.id,
      name: input.row.agent.name,
      templateKey: input.row.agent.templateKey,
      templateVersion: input.row.agent.templateVersion,
      configRevision,
    },
    image: {
      ref: input.dependencies.hermesWorkloadImage?.trim() || DEFAULT_HERMES_WORKLOAD_IMAGE,
    },
    model: {
      provider: "openrouter",
      model: model.id,
    },
    platforms: {
      required: ["api_server", "telegram"],
      apiServer: {
        enabled: true,
        host: "0.0.0.0",
        port: 8642,
      },
      telegram: {
        enabled: true,
        allowAllUsers: false,
        unauthorizedDmBehavior: "ignore",
      },
    },
    schedule: {
      mode: input.row.config.scheduleMode,
      cron: input.row.config.scheduleCron,
      timezone: input.row.config.timezone,
    },
    prompt: {
      soul: input.row.config.systemPrompt,
    },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 25,
      toolLoopGuardrails: {
        hardStopEnabled: true,
        hardStopAfter: {
          exactFailure: 5,
          idempotentNoProgress: 5,
        },
      },
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      openrouterApiKey: decrypted.secrets.openrouter_api_key,
      telegramBotToken: decrypted.secrets.telegram_bot_token,
      telegramAllowedUsers: decrypted.secrets.telegram_allowed_users.split(","),
      apiServerKey: decrypted.secrets.api_server_key,
    },
  } satisfies AgentLaunchSpec;

  return parseBuiltSpec(spec);
}

function parseBuiltSpec(spec: AgentLaunchSpec): AgentLaunchSpecBuildResult {
  const parsed = parseAgentLaunchSpec(spec);

  if (!parsed.ok) {
    return {
      ok: false,
      reason: "launch_spec_invalid",
      message: "Hermes launch spec could not be built.",
    };
  }

  return { ok: true, spec: parsed.spec };
}

async function readAgentLaunchConfig(
  tx: AgentLaunchTransaction,
  userId: string,
  agentId: string,
): Promise<AgentLaunchConfigRow | null> {
  const [row] = await tx
    .select({
      agent: agents,
      config: agentConfigs,
    })
    .from(agents)
    .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId), isNull(agents.deletedAt)))
    .limit(1);

  if (!row) {
    return null;
  }

  const [deployment] = await tx
    .select()
    .from(agentDeployments)
    .where(and(eq(agentDeployments.agentId, agentId), eq(agentDeployments.userId, userId)))
    .orderBy(desc(agentDeployments.createdAt), desc(agentDeployments.id))
    .limit(1);

  return {
    ...row,
    deployment: deployment ?? null,
  };
}
