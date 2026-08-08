import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import type { BackupManifest } from "@/src/server/backups/backup-manifest";
import { listAgentBackupsForDevelopmentUser } from "@/src/server/backups/list-backups";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentConfigs, backups } from "@/src/server/db/schema";

describe("agent backup summaries", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetBackupSummaryTables(connection);
  });

  afterEach(async () => {
    await connection.close();
  });

  it("lists safe backup status summaries without storage or manifest internals", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Backup Summary Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const createdAtReady = new Date("2026-07-06T05:10:00.000Z");
    const createdAtFailed = new Date("2026-07-06T05:11:00.000Z");
    const createdAtRestored = new Date("2026-07-06T05:12:00.000Z");
    const restoredAt = new Date("2026-07-06T05:13:00.000Z");

    await connection.db.insert(backups).values([
      {
        agentId: created.agent.id,
        runnerId: null,
        status: "ready",
        storageUri: `s3://bruno-backups/agents/${created.agent.id}/backups/ready.json`,
        manifestJson: validManifest({ agentId: created.agent.id, name: created.agent.name }),
        createdBy: created.agent.userId,
        createdAt: createdAtReady,
      },
      {
        agentId: created.agent.id,
        runnerId: null,
        status: "failed",
        manifestJson: validManifest({ agentId: created.agent.id, name: created.agent.name }),
        createdBy: created.agent.userId,
        createdAt: createdAtFailed,
      },
      {
        agentId: created.agent.id,
        runnerId: null,
        status: "restored",
        storageUri: `s3://bruno-backups/agents/${created.agent.id}/backups/restored.json`,
        manifestJson: validManifest({ agentId: created.agent.id, name: created.agent.name }),
        createdBy: created.agent.userId,
        createdAt: createdAtRestored,
        restoredAt,
      },
    ]);

    const summaries = await listAgentBackupsForDevelopmentUser(created.agent.id, {
      createConnection: () => connection,
    });

    expect(summaries).toEqual([
      {
        id: expect.any(String),
        agentId: created.agent.id,
        status: "restored",
        createdAt: "2026-07-06T05:12:00.000Z",
        restoredAt: "2026-07-06T05:13:00.000Z",
        canRestore: false,
      },
      {
        id: expect.any(String),
        agentId: created.agent.id,
        status: "failed",
        createdAt: "2026-07-06T05:11:00.000Z",
        restoredAt: null,
        canRestore: false,
      },
      {
        id: expect.any(String),
        agentId: created.agent.id,
        status: "ready",
        createdAt: "2026-07-06T05:10:00.000Z",
        restoredAt: null,
        canRestore: true,
      },
    ]);
    expect(JSON.stringify(summaries)).not.toContain("s3://");
    expect(JSON.stringify(summaries)).not.toContain("bruno-backups");
    expect(JSON.stringify(summaries)).not.toContain("manifestJson");
    expect(JSON.stringify(summaries)).not.toContain("storageUri");
    expect(JSON.stringify(summaries)).not.toContain("sk-");
  });

  it("returns no summaries for deleted agents", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Deleted Backup Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    await connection.db
      .update(agentConfigs)
      .set({ systemPrompt: "Retain safe config." })
      .where(eq(agentConfigs.agentId, created.agent.id));
    await connection.db.insert(backups).values({
      agentId: created.agent.id,
      status: "ready",
      storageUri: `s3://bruno-backups/agents/${created.agent.id}/backups/ready.json`,
      manifestJson: validManifest({ agentId: created.agent.id, name: created.agent.name }),
      createdBy: created.agent.userId,
    });
    await connection.client`update agents set deleted_at = now() where id = ${created.agent.id}`;

    await expect(
      listAgentBackupsForDevelopmentUser(created.agent.id, {
        createConnection: () => connection,
      }),
    ).resolves.toEqual([]);
  });
});

async function resetBackupSummaryTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table backups, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_heartbeats, runners, app_metadata, users restart identity cascade`;
}

function validManifest(input: { agentId: string; name: string }): BackupManifest {
  return {
    schemaVersion: 1,
    agent: {
      id: input.agentId,
      name: input.name,
      status: "stopped",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      createdAt: "2026-07-06T05:00:00.000Z",
      updatedAt: "2026-07-06T05:00:00.000Z",
    },
    config: {
      modelProvider: "openai",
      modelName: "gpt-4.1-mini",
      scheduleMode: "manual",
      timezone: "UTC",
      maxDailySpendCents: 0,
      scheduleCron: null,
    },
    templateSnapshot: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      description: "Research template",
      defaultTools: ["Web search"],
      defaultSchedule: "Manual",
      defaultSystemPrompt: "Gather notes.",
      requiredIntegrations: [],
    },
    systemPrompt: "Gather notes.",
    skills: {
      folderPath: ".agent/skills",
      files: [],
    },
    memory: {
      files: [],
    },
    logs: {
      included: true,
      entries: [],
    },
  };
}
