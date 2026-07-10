import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  BACKUP_CREATED_EVENT_TYPE,
  createManualBackupForDevelopmentUser,
} from "@/src/server/backups/create-backup";
import type {
  BackupObjectStorage,
  BackupStorageDownloadInput,
  BackupStorageDownloadResult,
  BackupStorageUploadInput,
  BackupStorageUploadResult,
} from "@/src/server/backups/backup-storage";
import { FakeBackupObjectStorage, backupStorageFailure } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentEvents, agentLogs, backups } from "@/src/server/db/schema";

describe("manual agent backup creation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetBackupTables(connection);
  });

  afterEach(async () => {
    await resetBackupTables(connection);
    await connection.close();
  });

  it("uploads a sanitized manual backup manifest, records a ready backup, and writes backup.created", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const created = await createAgentForDevelopmentUser(
      {
        name: "Manual Backup Agent",
        templateKey: "research_agent",
      },
      { createConnection: () => connection },
    );

    await connection.db
      .update(agentConfigs)
      .set({
        systemPrompt: "Use sk-secret-value-12345 only through configured references.",
        modelProvider: "openai",
        modelName: "gpt-5",
      })
      .where(eq(agentConfigs.agentId, created.agent.id));
    await connection.db.insert(agentLogs).values([
      backupLog(created.agent.id, 1, {
        source: "manual_runner",
        stream: "stdout",
        level: "info",
        message: "contains sk-secret-log-value-12345 but must not be backed up",
      }),
      backupLog(created.agent.id, 2, {
        source: "manual_runner",
        stream: "stdout",
        level: "info",
        message: "safe message",
      }),
      backupLog(created.agent.id, 3, {
        source: "manual_runner",
        stream: "stderr",
        level: "error",
        message: "error details",
      }),
    ]);

    const result = await createManualBackupForDevelopmentUser(
      { agentId: created.agent.id },
      { createConnection: () => connection, storage },
    );

    expect(result).toMatchObject({
      ok: true,
      backup: {
        agentId: created.agent.id,
        status: "ready",
        storageUri: expect.stringMatching(
          /^s3:\/\/agentbay-backups\/users\/.+\/agents\/.+\/backups\/.+\.json$/,
        ),
      },
      event: { type: BACKUP_CREATED_EVENT_TYPE },
    });

    if (!result.ok) {
      throw new Error("Expected backup creation to succeed.");
    }

    const persistedBackups = await connection.db.select().from(backups);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, BACKUP_CREATED_EVENT_TYPE));
    const manifest = persistedBackups[0]?.manifestJson;
    const artifactKey = `users/${created.agent.userId}/agents/${created.agent.id}/backups/${result.backup.id}.json`;
    const artifact = await storage.download({ key: artifactKey });

    expect(persistedBackups).toHaveLength(1);
    expect(persistedBackups[0]).toMatchObject({
      id: result.backup.id,
      agentId: created.agent.id,
      status: "ready",
      storageUri: result.backup.storageUri,
    });
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]).toMatchObject({
      agentId: created.agent.id,
      type: BACKUP_CREATED_EVENT_TYPE,
      metadata: {
        backupId: result.backup.id,
        status: "ready",
      },
    });
    expect(JSON.stringify(persistedEvents)).not.toContain("storageUri");
    expect(JSON.stringify(persistedEvents)).not.toContain(result.backup.storageUri);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      agent: {
        id: created.agent.id,
        name: "Manual Backup Agent",
        templateKey: "research_agent",
      },
      config: {
        modelProvider: "openai",
        modelName: "gpt-5",
        scheduleMode: "manual",
      },
      systemPrompt: "Use [redacted] only through configured references.",
      skills: { folderPath: ".agent/skills", files: [] },
      memory: { files: [] },
      logs: {
        included: false,
        entries: [
          {
            source: "manual_runner",
            stream: "stdout",
            level: "info",
            sequenceFrom: 1,
            sequenceTo: 2,
            entryCount: 2,
          },
          {
            source: "manual_runner",
            stream: "stderr",
            level: "error",
            sequenceFrom: 3,
            sequenceTo: 3,
            entryCount: 1,
          },
        ],
      },
    });
    expect(JSON.stringify(manifest)).not.toContain("sk-secret-value");
    expect(JSON.stringify(manifest)).not.toContain("sk-secret-log-value");
    expect(JSON.stringify(manifest)).not.toContain("safe message");
    expect(artifact).toMatchObject({
      ok: true,
      storageUri: result.backup.storageUri,
      contentType: "application/vnd.agentbay.backup-manifest+json",
    });

    if (!artifact.ok) {
      throw new Error("Expected backup artifact to be downloadable.");
    }

    expect(new TextDecoder().decode(artifact.body)).toContain('"schemaVersion": 1');
    expect(new TextDecoder().decode(artifact.body)).not.toContain("sk-secret");
  });

  it("returns not found without creating a backup for a missing agent", async () => {
    const result = await createManualBackupForDevelopmentUser(
      { agentId: "00000000-0000-4000-8000-000000000165" },
      { createConnection: () => connection, storage: new FakeBackupObjectStorage() },
    );

    const persistedBackups = await connection.db.select().from(backups);

    expect(result).toEqual({
      ok: false,
      reason: "agent_not_found",
      message: "Agent could not be found.",
    });
    expect(persistedBackups).toHaveLength(0);
  });

  it("leaves a safe failed backup row when artifact upload fails", async () => {
    const created = await createAgentForDevelopmentUser(
      {
        name: "Upload Failure Agent",
        templateKey: "research_agent",
      },
      { createConnection: () => connection },
    );
    const storage = new FailingBackupObjectStorage();

    const result = await createManualBackupForDevelopmentUser(
      { agentId: created.agent.id },
      { createConnection: () => connection, storage },
    );

    const persistedBackups = await connection.db.select().from(backups);
    const persistedEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, BACKUP_CREATED_EVENT_TYPE));

    expect(result).toMatchObject({
      ok: false,
      reason: "backup_storage_failed",
      message:
        "Backup artifact upload failed. Check object storage configuration, credentials, permissions, and bucket availability.",
      backup: {
        agentId: created.agent.id,
        status: "failed",
        storageUri: null,
      },
    });
    expect(persistedBackups).toHaveLength(1);
    expect(persistedBackups[0]).toMatchObject({
      agentId: created.agent.id,
      status: "failed",
      storageUri: null,
    });
    expect(persistedEvents).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain("AKIA");
    expect(JSON.stringify(persistedBackups[0]?.manifestJson)).not.toContain("AKIA");
  });
});

class FailingBackupObjectStorage implements BackupObjectStorage {
  async upload(_input: BackupStorageUploadInput): Promise<BackupStorageUploadResult> {
    return backupStorageFailure("upload");
  }

  async download(_input: BackupStorageDownloadInput): Promise<BackupStorageDownloadResult> {
    return backupStorageFailure("download");
  }
}

async function resetBackupTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table backups, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}

function backupLog(
  agentId: string,
  sequence: number,
  overrides: {
    source: string;
    stream: "stdout" | "stderr";
    level: string;
    message: string;
  },
): typeof agentLogs.$inferInsert {
  return {
    agentId,
    sequence,
    source: overrides.source,
    stream: overrides.stream,
    level: overrides.level,
    message: overrides.message,
    metadata: {},
  };
}
