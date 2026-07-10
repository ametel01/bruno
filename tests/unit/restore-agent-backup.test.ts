import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import {
  BACKUP_RESTORED_EVENT_TYPE,
  restoreBackupForDevelopmentUser,
} from "@/src/server/backups/restore-backup";
import type { BackupManifest } from "@/src/server/backups/backup-manifest";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentEvents, agents, backups } from "@/src/server/db/schema";

describe("backup restore creation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetRestoreTables(connection);
  });

  afterEach(async () => {
    await resetRestoreTables(connection);
    await connection.close();
  });

  it("restores a ready backup artifact into a new stopped agent and writes backup.restored", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      {
        name: "Restore Source",
        templateKey: "research_agent",
      },
      { createConnection: () => connection },
    );
    const manifest = validManifest({
      agent: {
        ...validManifest().agent,
        id: original.agent.id,
        name: "Restored Research",
      },
      config: {
        ...validManifest().config,
        modelProvider: "openai",
        modelName: "gpt-5",
        scheduleMode: "cron",
        scheduleCron: "0 8 * * *",
        timezone: "Asia/Manila",
        maxDailySpendCents: 1234,
      },
      systemPrompt: "Restored system prompt.",
    });
    const backup = await seedReadyBackup({
      connection,
      storage,
      agentId: original.agent.id,
      userId: original.agent.userId,
      manifest,
    });

    const result = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: backup.id },
      { createConnection: () => connection, storage, now: () => new Date("2026-07-06T05:00:00Z") },
    );

    expect(result).toMatchObject({
      ok: true,
      backup: {
        id: backup.id,
        agentId: original.agent.id,
        status: "restored",
        restoredAt: "2026-07-06T05:00:00.000Z",
      },
      restoredAgent: {
        name: "Restored Research (restored)",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        status: "stopped",
        templateSnapshotJson: manifest.templateSnapshot,
      },
      event: { type: BACKUP_RESTORED_EVENT_TYPE },
    });

    if (!result.ok) {
      throw new Error("Expected restore to succeed.");
    }

    expect(result.restoredAgent.id).not.toBe(original.agent.id);

    const [restoredConfig] = await connection.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, result.restoredAgent.id));
    const [restoredBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, backup.id));
    const restoredEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, BACKUP_RESTORED_EVENT_TYPE));
    const nonOriginalAgents = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));

    expect(nonOriginalAgents).toHaveLength(1);
    expect(restoredConfig).toMatchObject({
      agentId: result.restoredAgent.id,
      systemPrompt: "Restored system prompt.",
      modelProvider: "openai",
      modelName: "gpt-5",
      scheduleMode: "cron",
      scheduleCron: "0 8 * * *",
      timezone: "Asia/Manila",
      maxDailySpendCents: 1234,
    });
    expect(restoredBackup).toMatchObject({
      id: backup.id,
      status: "restored",
      restoredAt: new Date("2026-07-06T05:00:00Z"),
    });
    expect(restoredEvents).toHaveLength(1);
    expect(restoredEvents[0]).toMatchObject({
      agentId: result.restoredAgent.id,
      type: BACKUP_RESTORED_EVENT_TYPE,
      metadata: {
        backupId: backup.id,
        sourceAgentId: original.agent.id,
        status: "restored",
      },
    });
  });

  it("fails safely and marks the backup failed when the artifact is missing", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      { name: "Missing Artifact Source", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const missingBackupId = "00000000-0000-4000-8000-000000000701";
    const [backup] = await connection.db
      .insert(backups)
      .values({
        id: missingBackupId,
        agentId: original.agent.id,
        runnerId: null,
        status: "ready",
        storageUri: `s3://agentbay-backups/${backupArtifactKey(original.agent.userId, original.agent.id, missingBackupId)}`,
        manifestJson: validManifest(),
        createdBy: original.agent.userId,
      })
      .returning();

    if (!backup) {
      throw new Error("Expected backup seed to return a row.");
    }

    const result = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: backup.id },
      { createConnection: () => connection, storage },
    );

    const restoredAgents = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));
    const [failedBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, backup.id));

    expect(result).toMatchObject({
      ok: false,
      reason: "backup_storage_failed",
      message:
        "Backup artifact download failed. Check object storage configuration, credentials, permissions, and artifact availability.",
      backup: {
        id: backup.id,
        status: "failed",
        restoredAt: null,
      },
    });
    expect(restoredAgents).toHaveLength(0);
    expect(failedBackup).toMatchObject({ status: "failed", restoredAt: null });
    expect(JSON.stringify(result)).not.toContain("agentbay:agentbay");
  });

  it("does not restore a backup that is already in a non-ready state", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      { name: "Already Restoring Source", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const [backup] = await connection.db
      .insert(backups)
      .values({
        agentId: original.agent.id,
        runnerId: null,
        status: "restoring",
        storageUri: `s3://agentbay-backups/users/${original.agent.userId}/agents/${original.agent.id}/backups/restoring.json`,
        manifestJson: validManifest(),
        createdBy: original.agent.userId,
      })
      .returning();

    if (!backup) {
      throw new Error("Expected backup seed to return a row.");
    }

    const result = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: backup.id },
      { createConnection: () => connection, storage },
    );

    const restoredAgents = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));

    expect(result).toMatchObject({
      ok: false,
      reason: "backup_not_restorable",
      message: "Backup is not ready to restore.",
      backup: {
        id: backup.id,
        status: "restoring",
      },
    });
    expect(restoredAgents).toHaveLength(0);
  });

  it("fails safely without restoring an agent when the artifact manifest is invalid or unsafe", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      { name: "Unsafe Artifact Source", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const unsafeArtifactManifest = validManifest({
      systemPrompt: "Use sk-unsafe-restore-secret only through references.",
    });
    const backup = await seedReadyBackup({
      connection,
      storage,
      agentId: original.agent.id,
      userId: original.agent.userId,
      manifest: validManifest(),
    });
    await storage.upload({
      key: backupArtifactKey(original.agent.userId, original.agent.id, backup.id),
      body: new TextEncoder().encode(JSON.stringify(unsafeArtifactManifest, null, 2)),
      contentType: "application/vnd.agentbay.backup-manifest+json",
    });

    const result = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: backup.id },
      { createConnection: () => connection, storage },
    );

    const restoredAgents = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));
    const restoredEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, BACKUP_RESTORED_EVENT_TYPE));
    const [failedBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, backup.id));

    expect(result).toMatchObject({
      ok: false,
      reason: "backup_artifact_invalid",
      message:
        "Backup artifact manifest could not be validated. Create a new backup and retry restore.",
      backup: {
        id: backup.id,
        status: "failed",
        restoredAt: null,
      },
    });
    expect(restoredAgents).toHaveLength(0);
    expect(restoredEvents).toHaveLength(0);
    expect(failedBackup).toMatchObject({ status: "failed", restoredAt: null });
    expect(JSON.stringify(result)).not.toContain("sk-unsafe-restore-secret");
    expect(JSON.stringify(failedBackup)).not.toContain("sk-unsafe-restore-secret");
  });

  it("fails safely before inserting config when artifact schedule metadata is invalid", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      { name: "Invalid Schedule Source", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const invalidScheduleManifest = validManifest({
      config: {
        ...validManifest().config,
        scheduleMode: "cron",
        scheduleCron: null,
      },
    });
    const backup = await seedReadyBackup({
      connection,
      storage,
      agentId: original.agent.id,
      userId: original.agent.userId,
      manifest: validManifest(),
    });
    await storage.upload({
      key: backupArtifactKey(original.agent.userId, original.agent.id, backup.id),
      body: new TextEncoder().encode(JSON.stringify(invalidScheduleManifest, null, 2)),
      contentType: "application/vnd.agentbay.backup-manifest+json",
    });

    const result = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: backup.id },
      { createConnection: () => connection, storage },
    );

    const restoredAgents = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));
    const [failedBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, backup.id));

    expect(result).toMatchObject({
      ok: false,
      reason: "backup_artifact_invalid",
      message:
        "Backup artifact manifest could not be validated. Create a new backup and retry restore.",
      backup: {
        id: backup.id,
        status: "failed",
        restoredAt: null,
      },
    });
    expect(restoredAgents).toHaveLength(0);
    expect(failedBackup).toMatchObject({ status: "failed", restoredAt: null });
  });

  it("fails safely before restoring when artifact cron or timezone metadata is invalid", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");

    for (const manifest of [
      validManifest({
        config: {
          ...validManifest().config,
          scheduleMode: "cron",
          scheduleCron: "not cron",
        },
      }),
      validManifest({
        config: {
          ...validManifest().config,
          timezone: "Mars/Nope",
        },
      }),
    ]) {
      await resetRestoreTables(connection);
      const recreated = await createAgentForDevelopmentUser(
        { name: "Invalid Time Source", templateKey: "research_agent" },
        { createConnection: () => connection },
      );
      const backup = await seedReadyBackup({
        connection,
        storage,
        agentId: recreated.agent.id,
        userId: recreated.agent.userId,
        manifest: validManifest(),
      });
      await storage.upload({
        key: backupArtifactKey(recreated.agent.userId, recreated.agent.id, backup.id),
        body: new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
        contentType: "application/vnd.agentbay.backup-manifest+json",
      });

      const result = await restoreBackupForDevelopmentUser(
        { agentId: recreated.agent.id, backupId: backup.id },
        { createConnection: () => connection, storage },
      );
      const restoredAgents = await connection.db
        .select()
        .from(agents)
        .where(ne(agents.id, recreated.agent.id));
      const [failedBackup] = await connection.db
        .select()
        .from(backups)
        .where(eq(backups.id, backup.id));

      expect(result).toMatchObject({
        ok: false,
        reason: "backup_artifact_invalid",
        backup: {
          id: backup.id,
          status: "failed",
          restoredAt: null,
        },
      });
      expect(restoredAgents).toHaveLength(0);
      expect(failedBackup).toMatchObject({ status: "failed", restoredAt: null });
    }
  });
});

async function resetRestoreTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table backups, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}

async function seedReadyBackup(input: {
  connection: DatabaseConnection;
  storage: FakeBackupObjectStorage;
  agentId: string;
  userId: string;
  manifest: BackupManifest;
}): Promise<typeof backups.$inferSelect> {
  const [backup] = await input.connection.db
    .insert(backups)
    .values({
      agentId: input.agentId,
      runnerId: null,
      status: "ready",
      storageUri: null,
      manifestJson: input.manifest,
      createdBy: input.userId,
    })
    .returning();

  if (!backup) {
    throw new Error("Expected backup seed to return a row.");
  }

  const upload = await input.storage.upload({
    key: backupArtifactKey(input.userId, input.agentId, backup.id),
    body: new TextEncoder().encode(JSON.stringify(input.manifest, null, 2)),
    contentType: "application/vnd.agentbay.backup-manifest+json",
  });

  if (!upload.ok) {
    throw new Error("Expected test backup artifact upload to succeed.");
  }

  const [updatedBackup] = await input.connection.db
    .update(backups)
    .set({ storageUri: upload.storageUri })
    .where(eq(backups.id, backup.id))
    .returning();

  if (!updatedBackup) {
    throw new Error("Expected backup storage URI update to return a row.");
  }

  return updatedBackup;
}

function backupArtifactKey(userId: string, agentId: string, backupId: string): string {
  return `users/${userId}/agents/${agentId}/backups/${backupId}.json`;
}

function validManifest(
  overrides: Partial<Record<keyof BackupManifest, unknown>> = {},
): BackupManifest {
  const snapshot = getAgentTemplateSnapshot("research_agent");

  return {
    schemaVersion: 1,
    agent: {
      id: "00000000-0000-4000-8000-000000000166",
      name: "Restorable Agent",
      status: "stopped",
      templateKey: "research_agent",
      templateVersion: snapshot.version,
      createdAt: "2026-07-06T04:00:00.000Z",
      updatedAt: "2026-07-06T04:10:00.000Z",
    },
    config: {
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual",
      timezone: "UTC",
      maxDailySpendCents: 0,
      scheduleCron: null,
    },
    templateSnapshot: snapshot,
    systemPrompt: "Gather relevant information and keep source notes.",
    skills: { folderPath: ".agent/skills", files: [] },
    memory: { files: [] },
    logs: { included: false, entries: [] },
    ...overrides,
  } as BackupManifest;
}
