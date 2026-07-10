import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, ne } from "drizzle-orm";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import {
  BACKUP_CREATED_EVENT_TYPE,
  createManualBackupForDevelopmentUser,
} from "@/src/server/backups/create-backup";
import { listAgentBackupsForDevelopmentUser } from "@/src/server/backups/list-backups";
import {
  BACKUP_RESTORED_EVENT_TYPE,
  restoreBackupForDevelopmentUser,
} from "@/src/server/backups/restore-backup";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, agentEvents, agentLogs, agents, backups } from "@/src/server/db/schema";
import { listAgentEventFeed } from "@/src/server/events/agent-events";

const RAW_CONFIG_SECRET = "sk-finalacceptance-secret-12345";
const RAW_LOG_SECRET = "sk-finalacceptancelog-secret-12345";

describe("Milestone 15 backup restore acceptance evidence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetAcceptanceTables(connection);
  });

  afterEach(async () => {
    await resetAcceptanceTables(connection);
    await connection.close();
  });

  it("creates, lists, restores, records timeline events, and excludes raw secrets from backup surfaces", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const original = await createAgentForDevelopmentUser(
      {
        name: "Acceptance Backup Agent",
        templateKey: "research_agent",
      },
      { createConnection: () => connection },
    );

    await connection.db
      .update(agentConfigs)
      .set({
        systemPrompt: `Use ${RAW_CONFIG_SECRET} only through configured references.`,
        modelProvider: "openai",
        modelName: "gpt-5",
        scheduleMode: "cron",
        scheduleCron: "30 6 * * *",
        timezone: "Asia/Manila",
        maxDailySpendCents: 9876,
      })
      .where(eq(agentConfigs.agentId, original.agent.id));
    await connection.db.insert(agentLogs).values([
      backupLog(original.agent.id, 1, {
        message: `runtime output contained ${RAW_LOG_SECRET} and must not be copied`,
      }),
    ]);

    const createResult = await createManualBackupForDevelopmentUser(
      { agentId: original.agent.id },
      { createConnection: () => connection, storage },
    );

    expect(createResult.ok).toBe(true);

    if (!createResult.ok) {
      throw new Error("Expected manual backup creation to pass.");
    }

    const backupSummaryBeforeRestore = await listAgentBackupsForDevelopmentUser(original.agent.id, {
      createConnection: () => connection,
    });
    const artifactKey = `users/${original.agent.userId}/agents/${original.agent.id}/backups/${createResult.backup.id}.json`;
    const artifact = await storage.download({ key: artifactKey });

    expect(backupSummaryBeforeRestore).toEqual([
      expect.objectContaining({
        id: createResult.backup.id,
        agentId: original.agent.id,
        status: "ready",
        restoredAt: null,
        canRestore: true,
      }),
    ]);
    expect(artifact.ok).toBe(true);

    if (!artifact.ok) {
      throw new Error("Expected backup artifact to be downloadable.");
    }

    const artifactText = new TextDecoder().decode(artifact.body);
    const [readyBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, createResult.backup.id));

    expect(readyBackup?.manifestJson).toMatchObject({
      config: {
        modelProvider: "openai",
        modelName: "gpt-5",
        scheduleMode: "cron",
        scheduleCron: "30 6 * * *",
        timezone: "Asia/Manila",
        maxDailySpendCents: 9876,
      },
      systemPrompt: "Use [redacted] only through configured references.",
      logs: {
        included: false,
        entries: [
          {
            source: "manual_runner",
            stream: "stdout",
            level: "info",
            sequenceFrom: 1,
            sequenceTo: 1,
            entryCount: 1,
          },
        ],
      },
    });

    const restoreResult = await restoreBackupForDevelopmentUser(
      { agentId: original.agent.id, backupId: createResult.backup.id },
      { createConnection: () => connection, storage, now: () => new Date("2026-07-06T06:30:00Z") },
    );

    expect(restoreResult.ok).toBe(true);

    if (!restoreResult.ok) {
      throw new Error("Expected backup restore to pass.");
    }

    const [restoredAgent] = await connection.db
      .select()
      .from(agents)
      .where(ne(agents.id, original.agent.id));
    const [restoredConfig] = await connection.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.agentId, restoreResult.restoredAgent.id));
    const backupSummaryAfterRestore = await listAgentBackupsForDevelopmentUser(original.agent.id, {
      createConnection: () => connection,
    });
    const originalTimeline = await listAgentEventFeed({
      db: connection.db,
      agentId: original.agent.id,
    });
    const restoredTimeline = await listAgentEventFeed({
      db: connection.db,
      agentId: restoreResult.restoredAgent.id,
    });
    const persistedEvents = await connection.db.select().from(agentEvents);
    const persistedLogCount = await connection.db.select().from(agentLogs);

    expect(restoredAgent).toMatchObject({
      id: restoreResult.restoredAgent.id,
      name: "Acceptance Backup Agent (restored)",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      status: "stopped",
    });
    expect(restoredConfig).toMatchObject({
      agentId: restoreResult.restoredAgent.id,
      systemPrompt: "Use [redacted] only through configured references.",
      modelProvider: "openai",
      modelName: "gpt-5",
      scheduleMode: "cron",
      scheduleCron: "30 6 * * *",
      timezone: "Asia/Manila",
      maxDailySpendCents: 9876,
    });
    expect(backupSummaryAfterRestore).toEqual([
      expect.objectContaining({
        id: createResult.backup.id,
        status: "restored",
        restoredAt: "2026-07-06T06:30:00.000Z",
        canRestore: false,
      }),
    ]);
    expect(originalTimeline).toMatchObject({
      ok: true,
      page: {
        events: expect.arrayContaining([
          expect.objectContaining({
            type: BACKUP_CREATED_EVENT_TYPE,
            metadata: {
              backupId: createResult.backup.id,
              status: "ready",
            },
          }),
        ]),
      },
    });
    expect(restoredTimeline).toMatchObject({
      ok: true,
      page: {
        events: expect.arrayContaining([
          expect.objectContaining({
            type: BACKUP_RESTORED_EVENT_TYPE,
            metadata: {
              backupId: createResult.backup.id,
              sourceAgentId: original.agent.id,
              status: "restored",
            },
          }),
        ]),
      },
    });
    expect(persistedLogCount).toHaveLength(1);

    const persistedBackupAndTimelineSurfaces = JSON.stringify({
      manifest: readyBackup?.manifestJson,
      artifactText,
      events: persistedEvents,
      originalTimeline,
      restoredTimeline,
      backupSummaryBeforeRestore,
      backupSummaryAfterRestore,
    });
    expect(persistedBackupAndTimelineSurfaces).not.toContain(RAW_CONFIG_SECRET);
    expect(persistedBackupAndTimelineSurfaces).not.toContain(RAW_LOG_SECRET);
    expect(persistedBackupAndTimelineSurfaces).not.toContain("storageUri");
    expect(persistedBackupAndTimelineSurfaces).not.toContain("s3://");
    expect(persistedBackupAndTimelineSurfaces).not.toContain("agentbay-backups");
  });
});

async function resetAcceptanceTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table backups, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}

function backupLog(
  agentId: string,
  sequence: number,
  overrides: {
    message: string;
  },
): typeof agentLogs.$inferInsert {
  return {
    agentId,
    sequence,
    source: "manual_runner",
    stream: "stdout",
    level: "info",
    message: overrides.message,
    metadata: {},
  };
}
