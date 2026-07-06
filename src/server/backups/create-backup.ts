import "server-only";

import { and, asc, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentLogs, agents, backups } from "@/src/server/db/schema";
import { recordAgentEventInTransaction } from "@/src/server/events/agent-events";
import { getDevelopmentUserId } from "@/src/server/users/development-user";
import {
  type BackupManifest,
  type BackupStatus,
  validateBackupManifest,
} from "@/src/server/backups/backup-manifest";
import {
  backupStorageFailure,
  createBackupObjectStorage,
  type BackupObjectStorage,
} from "@/src/server/backups/backup-storage";

export const BACKUP_CREATED_EVENT_TYPE = "backup.created";

type BackupTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type AgentBackupRow = typeof agents.$inferSelect & {
  config: typeof agentConfigs.$inferSelect;
};

type BackupRow = typeof backups.$inferSelect;
type AgentLogRow = typeof agentLogs.$inferSelect;

export type ManualBackupResponse = {
  backup: {
    id: string;
    agentId: string;
    runnerId: string | null;
    status: BackupStatus;
    storageUri: string | null;
    createdAt: string;
    restoredAt: string | null;
  };
};

export type ManualBackupCreateResult =
  | {
      ok: true;
      backup: ManualBackupResponse["backup"];
      event: { type: typeof BACKUP_CREATED_EVENT_TYPE };
    }
  | {
      ok: false;
      reason:
        | "agent_not_found"
        | "backup_manifest_invalid"
        | "backup_storage_failed"
        | "backup_storage_not_configured";
      message: string;
      backup?: ManualBackupResponse["backup"];
    };

export type ManualBackupDependencies = {
  createConnection?: () => DatabaseConnection;
  storage?: BackupObjectStorage | null;
  now?: () => Date;
};

export class ManualBackupPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Manual backup creation failed.");
    this.name = "ManualBackupPersistenceError";
    this.cause = cause;
  }
}

const MANIFEST_CONTENT_TYPE = "application/vnd.agentbay.backup-manifest+json";
const REDACTED_SECRET = "[redacted]";
const SECRET_KEY_PATTERN =
  /(api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|refresh[_-]?token|provider[_-]?token|registration[_-]?token|secret|token|password|credential|authorization|bearer)/i;
const RAW_SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bdop_v1_[A-Za-z0-9_-]{8,}\b/g,
  /\bagb_(?:run|reg)_[A-Za-z0-9_-]{8,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/g,
] as const;

export async function createManualBackupForDevelopmentUser(
  input: { agentId: string },
  dependencies: ManualBackupDependencies = {},
): Promise<ManualBackupCreateResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());

  try {
    const backupContext = await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return null;
      }

      const row = await selectAgentForBackup(tx, {
        agentId: input.agentId,
        userId,
      });

      if (!row) {
        return null;
      }

      const logs = await tx
        .select()
        .from(agentLogs)
        .where(eq(agentLogs.agentId, input.agentId))
        .orderBy(asc(agentLogs.sequence), asc(agentLogs.id));
      const manifest = buildBackupManifest(row, logs);
      const validation = validateBackupManifest(manifest);

      if (!validation.ok) {
        const [failedBackup] = await tx
          .insert(backups)
          .values({
            agentId: row.id,
            runnerId: row.runnerId,
            status: "failed",
            manifestJson: buildFailureManifest(row, now()),
            createdBy: userId,
          })
          .returning();

        if (!failedBackup) {
          throw new Error("Failed backup insert returned no rows.");
        }

        return {
          userId,
          agent: row,
          backup: failedBackup,
          manifest: null,
          manifestErrors: validation.errors,
        };
      }

      const [createdBackup] = await tx
        .insert(backups)
        .values({
          agentId: row.id,
          runnerId: row.runnerId,
          status: "uploading",
          manifestJson: validation.manifest,
          createdBy: userId,
        })
        .returning();

      if (!createdBackup) {
        throw new Error("Backup insert returned no rows.");
      }

      return {
        userId,
        agent: row,
        backup: createdBackup,
        manifest: validation.manifest,
        manifestErrors: [],
      };
    });

    if (!backupContext) {
      return {
        ok: false,
        reason: "agent_not_found",
        message: "Agent could not be found.",
      };
    }

    if (!backupContext.manifest) {
      return {
        ok: false,
        reason: "backup_manifest_invalid",
        message:
          "Backup manifest could not be validated. Review agent configuration and retry the backup.",
        backup: toBackupResponse(backupContext.backup),
      };
    }

    const storageResult = resolveBackupObjectStorage(dependencies);

    if (!storageResult.ok) {
      const failedBackup = await markBackupFailed(connection, backupContext.backup.id);

      return {
        ok: false,
        reason: storageResult.reason,
        message: storageResult.message,
        backup: toBackupResponse(failedBackup),
      };
    }

    const artifactKey = buildManualBackupArtifactKey({
      agentId: backupContext.agent.id,
      backupId: backupContext.backup.id,
    });
    const uploadResult = await storageResult.storage.upload({
      key: artifactKey,
      body: new TextEncoder().encode(JSON.stringify(backupContext.manifest, null, 2)),
      contentType: MANIFEST_CONTENT_TYPE,
    });

    if (!uploadResult.ok) {
      const failedBackup = await markBackupFailed(connection, backupContext.backup.id);

      return {
        ok: false,
        reason: "backup_storage_failed",
        message: uploadResult.message,
        backup: toBackupResponse(failedBackup),
      };
    }

    const readyBackup = await connection.db.transaction(async (tx) => {
      const [updatedBackup] = await tx
        .update(backups)
        .set({
          status: "ready",
          storageUri: uploadResult.storageUri,
        })
        .where(eq(backups.id, backupContext.backup.id))
        .returning();

      if (!updatedBackup) {
        throw new Error("Ready backup update returned no rows.");
      }

      await recordAgentEventInTransaction(tx, {
        agentId: backupContext.agent.id,
        actorUserId: backupContext.userId,
        type: BACKUP_CREATED_EVENT_TYPE,
        message: `Created manual backup for agent "${backupContext.agent.name}".`,
        metadata: {
          backupId: updatedBackup.id,
          status: updatedBackup.status,
          storageUri: updatedBackup.storageUri,
        },
      });

      return updatedBackup;
    });

    return {
      ok: true,
      backup: toBackupResponse(readyBackup),
      event: { type: BACKUP_CREATED_EVENT_TYPE },
    };
  } catch (error) {
    throw new ManualBackupPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function selectAgentForBackup(
  tx: BackupTransaction,
  input: { agentId: string; userId: string },
): Promise<AgentBackupRow | null> {
  const [row] = await tx
    .select({
      agent: agents,
      config: agentConfigs,
    })
    .from(agents)
    .innerJoin(agentConfigs, eq(agentConfigs.agentId, agents.id))
    .where(
      and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.deletedAt)),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  return {
    ...row.agent,
    config: row.config,
  };
}

function buildBackupManifest(agent: AgentBackupRow, logs: AgentLogRow[]): BackupManifest {
  const sanitizedTemplateSnapshot = sanitizeRecord(agent.templateSnapshotJson);

  return {
    schemaVersion: 1,
    agent: {
      id: agent.id,
      name: sanitizeNonEmptyText(agent.name, "Untitled agent"),
      status: agent.status,
      templateKey: sanitizeNonEmptyText(agent.templateKey, "unknown_template"),
      templateVersion: sanitizeNonEmptyText(agent.templateVersion, "unknown"),
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    },
    config: {
      modelProvider: sanitizeNonEmptyText(agent.config.modelProvider, "not_configured"),
      modelName: sanitizeNonEmptyText(agent.config.modelName, "not_configured"),
      scheduleMode: agent.config.scheduleMode,
      timezone: sanitizeNonEmptyText(agent.config.timezone, "UTC"),
      maxDailySpendCents: agent.config.maxDailySpendCents,
      scheduleCron: sanitizeText(agent.config.scheduleCron),
    },
    templateSnapshot: sanitizedTemplateSnapshot,
    systemPrompt: sanitizeNonEmptyText(agent.config.systemPrompt, "System prompt redacted."),
    skills: {
      folderPath: ".agent/skills",
      files: [],
    },
    memory: {
      files: [],
    },
    logs: {
      included: false,
      entries: summarizeLogMetadata(logs),
    },
  };
}

function buildFailureManifest(agent: AgentBackupRow, createdAt: Date): BackupManifest {
  return {
    schemaVersion: 1,
    agent: {
      id: agent.id,
      name: sanitizeNonEmptyText(agent.name, "Untitled agent"),
      status: agent.status,
      templateKey: sanitizeNonEmptyText(agent.templateKey, "unknown_template"),
      templateVersion: sanitizeNonEmptyText(agent.templateVersion, "unknown"),
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    },
    config: {
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual",
      timezone: "UTC",
      maxDailySpendCents: 0,
      scheduleCron: null,
    },
    templateSnapshot: {
      backupCreatedAt: createdAt.toISOString(),
      validation: "failed",
    },
    systemPrompt: "Backup manifest validation failed before upload.",
    skills: { files: [] },
    memory: { files: [] },
    logs: { included: false, entries: [] },
  };
}

function summarizeLogMetadata(logs: AgentLogRow[]): BackupManifest["logs"]["entries"] {
  const summaries = new Map<string, BackupManifest["logs"]["entries"][number]>();

  for (const log of logs) {
    const stream = log.stream === "stderr" ? "stderr" : "stdout";
    const source = sanitizeNonEmptyText(log.source, "unknown");
    const level = sanitizeNonEmptyText(log.level, "info");
    const key = `${source}\0${stream}\0${level}`;
    const current = summaries.get(key);

    if (!current) {
      summaries.set(key, {
        source,
        stream,
        level,
        sequenceFrom: log.sequence,
        sequenceTo: log.sequence,
        entryCount: 1,
      });
      continue;
    }

    current.sequenceFrom = Math.min(current.sequenceFrom ?? log.sequence, log.sequence);
    current.sequenceTo = Math.max(current.sequenceTo ?? log.sequence, log.sequence);
    current.entryCount = (current.entryCount ?? 0) + 1;
  }

  return [...summaries.values()];
}

function resolveBackupObjectStorage(dependencies: ManualBackupDependencies):
  | { ok: true; storage: BackupObjectStorage }
  | {
      ok: false;
      reason: "backup_storage_failed" | "backup_storage_not_configured";
      message: string;
    } {
  try {
    const storage = "storage" in dependencies ? dependencies.storage : createBackupObjectStorage();

    if (!storage) {
      return {
        ok: false,
        reason: "backup_storage_not_configured",
        message:
          "Backup artifact upload failed. Configure backup object storage before creating manual backups.",
      };
    }

    return { ok: true, storage };
  } catch {
    return {
      ok: false,
      reason: "backup_storage_failed",
      message: backupStorageFailure("upload").message,
    };
  }
}

async function markBackupFailed(
  connection: DatabaseConnection,
  backupId: string,
): Promise<BackupRow> {
  const [failedBackup] = await connection.db
    .update(backups)
    .set({ status: "failed" })
    .where(eq(backups.id, backupId))
    .returning();

  if (!failedBackup) {
    throw new Error("Failed backup update returned no rows.");
  }

  return failedBackup;
}

function buildManualBackupArtifactKey(input: { agentId: string; backupId: string }): string {
  return `agents/${input.agentId}/backups/${input.backupId}.json`;
}

function toBackupResponse(row: BackupRow): ManualBackupResponse["backup"] {
  return {
    id: row.id,
    agentId: row.agentId,
    runnerId: row.runnerId,
    status: row.status,
    storageUri: row.storageUri,
    createdAt: row.createdAt.toISOString(),
    restoredAt: row.restoredAt?.toISOString() ?? null,
  };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeBackupValue(value);

  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeBackupValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeBackupValue);
  }

  if (!isRecord(value)) {
    return value;
  }

  const sanitized: Record<string, unknown> = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      continue;
    }

    sanitized[key] = sanitizeBackupValue(nestedValue);
  }

  return sanitized;
}

function sanitizeText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return RAW_SECRET_TEXT_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED_SECRET),
    value,
  );
}

function sanitizeNonEmptyText(value: string | null | undefined, fallback: string): string {
  const sanitized = sanitizeText(value)?.trim();

  return sanitized && sanitized.length > 0 ? sanitized : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
