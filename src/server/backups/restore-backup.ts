import "server-only";

import { and, eq } from "drizzle-orm";
import { isSupportedTemplateKey, type AgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agents, backups } from "@/src/server/db/schema";
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

export const BACKUP_RESTORED_EVENT_TYPE = "backup.restored";

type BackupRow = typeof backups.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type RestoreStart =
  | { ok: true; backup: BackupRow }
  | { ok: false; backup: BackupRow; reason: "not_restorable" };

export type RestoredBackupResponse = {
  backup: {
    id: string;
    agentId: string;
    runnerId: string | null;
    status: BackupStatus;
    storageUri: string | null;
    createdAt: string;
    restoredAt: string | null;
  };
  restoredAgent: {
    id: string;
    userId: string;
    name: string;
    templateKey: string;
    templateVersion: string;
    templateSnapshotJson: AgentTemplateSnapshot;
    status: "stopped";
    statusReason: null;
    createdAt: string;
    updatedAt: string;
    deletedAt: null;
  };
};

export type RestoreBackupResult =
  | {
      ok: true;
      backup: RestoredBackupResponse["backup"];
      restoredAgent: RestoredBackupResponse["restoredAgent"];
      event: { type: typeof BACKUP_RESTORED_EVENT_TYPE };
    }
  | {
      ok: false;
      reason:
        | "backup_not_found"
        | "backup_not_restorable"
        | "backup_storage_failed"
        | "backup_storage_not_configured"
        | "backup_artifact_invalid";
      message: string;
      backup?: RestoredBackupResponse["backup"];
    };

export type RestoreBackupDependencies = {
  createConnection?: () => DatabaseConnection;
  storage?: BackupObjectStorage | null;
  now?: () => Date;
};

export class RestoreBackupPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Backup restore failed.");
    this.name = "RestoreBackupPersistenceError";
    this.cause = cause;
  }
}

const RAW_SECRET_TEXT_PATTERNS = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/i,
  /\bsk-[A-Za-z0-9_-]{8,}\b/,
  /\bdop_v1_[A-Za-z0-9_-]{8,}\b/,
  /\bagb_(?:run|reg)_[A-Za-z0-9_-]{8,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{8,}\b/,
  /\bAKIA[A-Z0-9]{12,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH |)PRIVATE KEY-----/,
] as const;

export async function restoreBackupForDevelopmentUser(
  input: { agentId: string; backupId: string },
  dependencies: RestoreBackupDependencies = {},
): Promise<RestoreBackupResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());

  try {
    const restoreStart = await selectAndMarkBackupRestoring(connection, input);

    if (!restoreStart) {
      return {
        ok: false,
        reason: "backup_not_found",
        message: "Backup could not be found.",
      };
    }

    if (!restoreStart.ok) {
      return {
        ok: false,
        reason: "backup_not_restorable",
        message: "Backup is not ready to restore.",
        backup: toBackupResponse(restoreStart.backup),
      };
    }

    const backupContext = restoreStart.backup;
    const storageResult = resolveBackupObjectStorage(dependencies);

    if (!storageResult.ok) {
      const failedBackup = await markBackupFailed(connection, backupContext.id);

      return {
        ok: false,
        reason: storageResult.reason,
        message: storageResult.message,
        backup: toBackupResponse(failedBackup),
      };
    }

    const artifactKey = parseBackupStorageKey(backupContext.storageUri);

    if (!artifactKey) {
      const failedBackup = await markBackupFailed(connection, backupContext.id);

      return {
        ok: false,
        reason: "backup_artifact_invalid",
        message: "Backup artifact location is invalid. Create a new backup and retry restore.",
        backup: toBackupResponse(failedBackup),
      };
    }

    const downloadResult = await storageResult.storage.download({ key: artifactKey });

    if (!downloadResult.ok) {
      const failedBackup = await markBackupFailed(connection, backupContext.id);

      return {
        ok: false,
        reason: "backup_storage_failed",
        message: downloadResult.message,
        backup: toBackupResponse(failedBackup),
      };
    }

    const manifestResult = parseAndValidateDownloadedManifest(downloadResult.body);

    if (!manifestResult.ok) {
      const failedBackup = await markBackupFailed(connection, backupContext.id);

      return {
        ok: false,
        reason: "backup_artifact_invalid",
        message:
          "Backup artifact manifest could not be validated. Create a new backup and retry restore.",
        backup: toBackupResponse(failedBackup),
      };
    }

    const restored = await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId || userId !== backupContext.createdBy) {
        throw new Error("Development user changed during backup restore.");
      }

      const [restoredAgent] = await tx
        .insert(agents)
        .values({
          userId,
          runnerId: null,
          name: restoredAgentName(manifestResult.manifest.agent.name),
          templateKey: manifestResult.manifest.agent.templateKey,
          templateVersion: manifestResult.manifest.agent.templateVersion,
          templateSnapshotJson: manifestResult.templateSnapshot,
          status: "stopped",
        })
        .returning();

      if (!restoredAgent) {
        throw new Error("Restored agent insert returned no rows.");
      }

      await tx.insert(agentConfigs).values({
        agentId: restoredAgent.id,
        systemPrompt: manifestResult.manifest.systemPrompt,
        modelProvider: manifestResult.manifest.config.modelProvider,
        modelName: manifestResult.manifest.config.modelName,
        maxDailySpendCents: manifestResult.manifest.config.maxDailySpendCents,
        scheduleMode: manifestResult.manifest.config.scheduleMode === "cron" ? "cron" : "manual",
        scheduleCron:
          manifestResult.manifest.config.scheduleMode === "cron"
            ? manifestResult.manifest.config.scheduleCron
            : null,
        timezone: manifestResult.manifest.config.timezone,
      });

      const restoredAt = now();
      const [restoredBackup] = await tx
        .update(backups)
        .set({
          status: "restored",
          restoredAt,
          manifestJson: manifestResult.manifest,
        })
        .where(eq(backups.id, backupContext.id))
        .returning();

      if (!restoredBackup) {
        throw new Error("Restored backup update returned no rows.");
      }

      await recordAgentEventInTransaction(tx, {
        agentId: restoredAgent.id,
        actorUserId: userId,
        type: BACKUP_RESTORED_EVENT_TYPE,
        message: `Restored agent "${restoredAgent.name}" from backup.`,
        metadata: {
          backupId: restoredBackup.id,
          sourceAgentId: backupContext.agentId,
          status: restoredBackup.status,
        },
      });

      return {
        backup: restoredBackup,
        restoredAgent,
      };
    });

    return {
      ok: true,
      backup: toBackupResponse(restored.backup),
      restoredAgent: toRestoredAgentResponse(restored.restoredAgent),
      event: { type: BACKUP_RESTORED_EVENT_TYPE },
    };
  } catch (error) {
    throw new RestoreBackupPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function selectAndMarkBackupRestoring(
  connection: DatabaseConnection,
  input: { agentId: string; backupId: string },
): Promise<RestoreStart | null> {
  return await connection.db.transaction(async (tx) => {
    const userId = await getDevelopmentUserId(tx);

    if (!userId) {
      return null;
    }

    const [backup] = await tx
      .select()
      .from(backups)
      .where(
        and(
          eq(backups.id, input.backupId),
          eq(backups.agentId, input.agentId),
          eq(backups.createdBy, userId),
        ),
      )
      .limit(1);

    if (!backup) {
      return null;
    }

    if (backup.status !== "ready") {
      return { ok: false, backup, reason: "not_restorable" };
    }

    const [restoringBackup] = await tx
      .update(backups)
      .set({ status: "restoring" })
      .where(and(eq(backups.id, backup.id), eq(backups.status, "ready")))
      .returning();

    if (!restoringBackup) {
      const [currentBackup] = await tx
        .select()
        .from(backups)
        .where(eq(backups.id, backup.id))
        .limit(1);

      if (!currentBackup) {
        return null;
      }

      return { ok: false, backup: currentBackup, reason: "not_restorable" };
    }

    return { ok: true, backup: restoringBackup };
  });
}

function parseAndValidateDownloadedManifest(
  body: Uint8Array,
): { ok: true; manifest: BackupManifest; templateSnapshot: AgentTemplateSnapshot } | { ok: false } {
  let parsed: unknown;

  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return { ok: false };
  }

  const validation = validateBackupManifest(parsed);

  if (!validation.ok) {
    return { ok: false };
  }

  if (containsRawSecretLikeText(validation.manifest)) {
    return { ok: false };
  }

  if (!hasRestorableConfig(validation.manifest.config)) {
    return { ok: false };
  }

  const templateSnapshot = toAgentTemplateSnapshot(validation.manifest.templateSnapshot);

  if (!templateSnapshot) {
    return { ok: false };
  }

  if (
    validation.manifest.agent.templateKey !== templateSnapshot.key ||
    validation.manifest.agent.templateVersion !== templateSnapshot.version
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    manifest: validation.manifest,
    templateSnapshot,
  };
}

function toAgentTemplateSnapshot(value: Record<string, unknown>): AgentTemplateSnapshot | null {
  if (
    !isSupportedTemplateKey(value.key) ||
    typeof value.version !== "string" ||
    typeof value.name !== "string" ||
    typeof value.description !== "string" ||
    value.defaultSchedule !== "Manual" ||
    typeof value.defaultSystemPrompt !== "string" ||
    !isStringArray(value.defaultTools) ||
    !isStringArray(value.requiredIntegrations)
  ) {
    return null;
  }

  return {
    key: value.key,
    version: value.version,
    name: value.name,
    description: value.description,
    defaultTools: value.defaultTools,
    defaultSchedule: value.defaultSchedule,
    defaultSystemPrompt: value.defaultSystemPrompt,
    requiredIntegrations: value.requiredIntegrations,
  };
}

function parseBackupStorageKey(storageUri: string | null): string | null {
  if (!storageUri) {
    return null;
  }

  let parsed: URL;

  try {
    parsed = new URL(storageUri);
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "s3:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }

  const key = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : parsed.pathname;

  return key.trim().length > 0 ? key : null;
}

function resolveBackupObjectStorage(dependencies: RestoreBackupDependencies):
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
          "Backup artifact download failed. Configure backup object storage before restoring backups.",
      };
    }

    return { ok: true, storage };
  } catch {
    return {
      ok: false,
      reason: "backup_storage_failed",
      message: backupStorageFailure("download").message,
    };
  }
}

async function markBackupFailed(
  connection: DatabaseConnection,
  backupId: string,
): Promise<BackupRow> {
  const [failedBackup] = await connection.db
    .update(backups)
    .set({ status: "failed", restoredAt: null })
    .where(eq(backups.id, backupId))
    .returning();

  if (!failedBackup) {
    throw new Error("Failed backup update returned no rows.");
  }

  return failedBackup;
}

function restoredAgentName(name: string): string {
  const restoredName = `${name} (restored)`;

  return restoredName.length <= 120 ? restoredName : restoredName.slice(0, 120).trimEnd();
}

function toBackupResponse(row: BackupRow): RestoredBackupResponse["backup"] {
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

function toRestoredAgentResponse(agent: AgentRow): RestoredBackupResponse["restoredAgent"] {
  return {
    id: agent.id,
    userId: agent.userId,
    name: agent.name,
    templateKey: agent.templateKey,
    templateVersion: agent.templateVersion,
    templateSnapshotJson: agent.templateSnapshotJson,
    status: "stopped",
    statusReason: null,
    createdAt: agent.createdAt.toISOString(),
    updatedAt: agent.updatedAt.toISOString(),
    deletedAt: null,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasRestorableConfig(config: BackupManifest["config"]): boolean {
  if (!isValidTimezone(config.timezone)) {
    return false;
  }

  if (config.scheduleMode === "manual") {
    return config.scheduleCron === null || config.scheduleCron === undefined;
  }

  if (config.scheduleMode === "cron") {
    return typeof config.scheduleCron === "string" && isValidCronExpression(config.scheduleCron);
  }

  return false;
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidCronExpression(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    return false;
  }

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;

  return fields.every((field, index) => {
    const range = ranges[index];

    if (!range) {
      return false;
    }

    return isValidCronField(field, range[0], range[1]);
  });
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => isValidCronFieldPart(part, min, max));
}

function isValidCronFieldPart(part: string, min: number, max: number): boolean {
  const [rangePart, stepPart] = part.split("/");

  if (!rangePart || (stepPart !== undefined && !isPositiveInteger(stepPart))) {
    return false;
  }

  if (rangePart === "*") {
    return true;
  }

  if (rangePart.includes("-")) {
    const [start, end] = rangePart.split("-");

    if (!start || !end || !isIntegerInRange(start, min, max) || !isIntegerInRange(end, min, max)) {
      return false;
    }

    return Number(start) <= Number(end);
  }

  return isIntegerInRange(rangePart, min, max);
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0;
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const numberValue = Number(value);

  return numberValue >= min && numberValue <= max;
}

function containsRawSecretLikeText(value: unknown): boolean {
  if (typeof value === "string") {
    return RAW_SECRET_TEXT_PATTERNS.some((pattern) => pattern.test(value));
  }

  if (Array.isArray(value)) {
    return value.some(containsRawSecretLikeText);
  }

  if (typeof value !== "object" || value === null) {
    return false;
  }

  return Object.values(value).some(containsRawSecretLikeText);
}
