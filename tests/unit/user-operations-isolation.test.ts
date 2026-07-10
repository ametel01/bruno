import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as createBackupRoute } from "@/app/api/agents/[agentId]/backups/route";
import { POST as restoreBackupRoute } from "@/app/api/agents/[agentId]/backups/[backupId]/restore/route";
import { GET as agentEventsRoute } from "@/app/api/agents/[agentId]/events/route";
import { POST as approveApprovalRoute } from "@/app/api/approvals/[approvalId]/approve/route";
import { POST as denyApprovalRoute } from "@/app/api/approvals/[approvalId]/deny/route";
import {
  APPROVAL_APPROVED_EVENT_TYPE,
  APPROVAL_DENIED_EVENT_TYPE,
  approvePendingApprovalForUser,
  denyApprovalForUser,
  listPendingApprovalsForUser,
} from "@/src/server/approvals/agent-approvals";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createManualBackupForUser } from "@/src/server/backups/create-backup";
import { restoreBackupForUser } from "@/src/server/backups/restore-backup";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentApprovals,
  agentConfigs,
  agentEvents,
  agents,
  backups,
  users,
} from "@/src/server/db/schema";
import {
  listAgentEventFeedForUser,
  listLatestAgentActivityForUser,
} from "@/src/server/events/agent-events";

const USER_A_ID = "00000000-0000-4000-8000-000000000a01";
const USER_B_ID = "00000000-0000-4000-8000-000000000b01";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000a02";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000b02";
const APPROVAL_A_ID = "00000000-0000-4000-8000-000000000a03";
const APPROVAL_B_ID = "00000000-0000-4000-8000-000000000b03";
const MISSING_ID = "00000000-0000-4000-8000-000000000404";

describe("signed-in user operations isolation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetOperationalTables(connection);
    await seedTwoUsers(connection);
  });

  afterEach(async () => {
    await resetOperationalTables(connection);
    await connection.close();
  });

  it("returns identical 404s for foreign and missing approvals with no audit side effects", async () => {
    const foreignResponse = await approveApprovalRoute(
      new Request(`http://localhost/api/approvals/${APPROVAL_B_ID}/approve`),
      { params: Promise.resolve({ approvalId: APPROVAL_B_ID }) },
      routeUser(USER_A_ID),
    );
    const missingResponse = await approveApprovalRoute(
      new Request(`http://localhost/api/approvals/${MISSING_ID}/approve`),
      { params: Promise.resolve({ approvalId: MISSING_ID }) },
      routeUser(USER_A_ID),
    );
    const foreignBody = await foreignResponse.json();
    const missingBody = await missingResponse.json();

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(foreignBody).toEqual(missingBody);
    expect(JSON.stringify(foreignBody)).not.toContain(USER_B_ID);
    expect(JSON.stringify(foreignBody)).not.toContain("User B Agent");

    const [foreignApproval] = await connection.db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, APPROVAL_B_ID));
    expect(foreignApproval).toMatchObject({ status: "pending", resolvedBy: null });
    await expect(
      connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.type, APPROVAL_APPROVED_EVENT_TYPE)),
    ).resolves.toHaveLength(0);

    const ownerResponse = await approveApprovalRoute(
      new Request(`http://localhost/api/approvals/${APPROVAL_A_ID}/approve`),
      { params: Promise.resolve({ approvalId: APPROVAL_A_ID }) },
      routeUser(USER_A_ID),
    );
    const ownerBody = await ownerResponse.json();
    const [decisionEvent] = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, APPROVAL_APPROVED_EVENT_TYPE));

    expect(ownerResponse.status).toBe(200);
    expect(ownerBody).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(JSON.stringify(ownerBody)).not.toContain("resolvedBy");
    expect(JSON.stringify(ownerBody)).not.toContain(USER_A_ID);
    expect(decisionEvent).toMatchObject({ agentId: AGENT_A_ID, actorUserId: USER_A_ID });
  });

  it("keeps an owner decision and a foreign concurrent decision isolated", async () => {
    const [ownerResult, foreignResult] = await Promise.all([
      approvePendingApprovalForUser(USER_A_ID, APPROVAL_A_ID),
      denyApprovalForUser(USER_B_ID, APPROVAL_A_ID),
    ]);

    expect(ownerResult).toMatchObject({ ok: true, approval: { status: "approved" } });
    expect(foreignResult).toEqual({ ok: false, reason: "approval_not_found" });
    expect(await listPendingApprovalsForUser(USER_A_ID)).toEqual([]);
    expect(await listPendingApprovalsForUser(USER_B_ID)).toEqual([
      expect.objectContaining({ id: APPROVAL_B_ID, agentId: AGENT_B_ID }),
    ]);

    const decisionEvents = await connection.db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.type, APPROVAL_APPROVED_EVENT_TYPE));
    expect(decisionEvents).toHaveLength(1);
    expect(decisionEvents[0]).toMatchObject({ agentId: AGENT_A_ID, actorUserId: USER_A_ID });
  });

  it("returns identical deny responses for foreign and missing approvals with no audit write", async () => {
    const foreignResponse = await denyApprovalRoute(
      new Request(`http://localhost/api/approvals/${APPROVAL_B_ID}/deny`),
      { params: Promise.resolve({ approvalId: APPROVAL_B_ID }) },
      routeUser(USER_A_ID),
    );
    const missingResponse = await denyApprovalRoute(
      new Request(`http://localhost/api/approvals/${MISSING_ID}/deny`),
      { params: Promise.resolve({ approvalId: MISSING_ID }) },
      routeUser(USER_A_ID),
    );
    const foreignBody = await foreignResponse.json();
    const missingBody = await missingResponse.json();

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(foreignBody).toEqual(missingBody);
    expect(JSON.stringify(foreignBody)).not.toContain(USER_B_ID);
    expect(JSON.stringify(foreignBody)).not.toContain("User B approval");

    const [foreignApproval] = await connection.db
      .select()
      .from(agentApprovals)
      .where(eq(agentApprovals.id, APPROVAL_B_ID));
    expect(foreignApproval).toMatchObject({ status: "pending", resolvedBy: null });
    await expect(
      connection.db
        .select()
        .from(agentEvents)
        .where(eq(agentEvents.type, APPROVAL_DENIED_EVENT_TYPE)),
    ).resolves.toHaveLength(0);
  });

  it("binds backup rows and object keys to the owner before any foreign storage access", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const download = vi.spyOn(storage, "download");
    const createResult = await createManualBackupForUser(
      { agentId: AGENT_A_ID, userId: USER_A_ID },
      { createConnection: () => connection, storage },
    );

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      throw new Error("Expected owner backup creation to succeed.");
    }
    expect(createResult.backup.storageUri).toContain(
      `users/${USER_A_ID}/agents/${AGENT_A_ID}/backups/${createResult.backup.id}.json`,
    );
    const foreignCreateResult = await createManualBackupForUser(
      { agentId: AGENT_B_ID, userId: USER_B_ID },
      { createConnection: () => connection, storage },
    );
    expect(foreignCreateResult.ok).toBe(true);
    if (!foreignCreateResult.ok) {
      throw new Error("Expected foreign owner backup creation to succeed.");
    }

    const foreignResult = await restoreBackupForUser(
      {
        userId: USER_B_ID,
        agentId: AGENT_A_ID,
        backupId: createResult.backup.id,
      },
      { createConnection: () => connection, storage },
    );
    expect(foreignResult).toEqual({
      ok: false,
      reason: "backup_not_found",
      message: "Backup could not be found.",
    });
    expect(download).not.toHaveBeenCalled();

    const missingResult = await restoreBackupForUser(
      {
        userId: USER_B_ID,
        agentId: AGENT_A_ID,
        backupId: MISSING_ID,
      },
      { createConnection: () => connection, storage },
    );
    const ownerAgentForeignBackupResult = await restoreBackupForUser(
      {
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        backupId: foreignCreateResult.backup.id,
      },
      { createConnection: () => connection, storage },
    );
    const foreignAgentOwnerBackupResult = await restoreBackupForUser(
      {
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
        backupId: createResult.backup.id,
      },
      { createConnection: () => connection, storage },
    );

    expect(foreignResult).toEqual(missingResult);
    expect(ownerAgentForeignBackupResult).toEqual(missingResult);
    expect(foreignAgentOwnerBackupResult).toEqual(missingResult);
    expect(download).not.toHaveBeenCalled();

    const foreignCreateResponse = await createBackupRoute(
      new Request(`http://localhost/api/agents/${AGENT_A_ID}/backups`),
      { params: Promise.resolve({ agentId: AGENT_A_ID }) },
      routeUser(USER_B_ID),
    );
    const foreignRestoreResponse = await restoreBackupRoute(
      new Request(
        `http://localhost/api/agents/${AGENT_A_ID}/backups/${createResult.backup.id}/restore`,
      ),
      {
        params: Promise.resolve({
          agentId: AGENT_A_ID,
          backupId: createResult.backup.id,
        }),
      },
      routeUser(USER_B_ID),
    );
    const missingRestoreResponse = await restoreBackupRoute(
      new Request(`http://localhost/api/agents/${AGENT_A_ID}/backups/${MISSING_ID}/restore`),
      {
        params: Promise.resolve({
          agentId: AGENT_A_ID,
          backupId: MISSING_ID,
        }),
      },
      routeUser(USER_B_ID),
    );
    expect(foreignCreateResponse.status).toBe(404);
    expect(foreignRestoreResponse.status).toBe(404);
    expect(await foreignCreateResponse.json()).toEqual({
      error: { code: "agent_not_found", message: "Agent could not be found." },
    });
    const foreignRestoreBody = await foreignRestoreResponse.json();
    const missingRestoreBody = await missingRestoreResponse.json();
    expect(foreignRestoreBody).toEqual({
      error: { code: "backup_not_found", message: "Backup could not be found." },
    });
    expect(missingRestoreResponse.status).toBe(404);
    expect(missingRestoreBody).toEqual(foreignRestoreBody);
    expect(JSON.stringify(foreignRestoreBody)).not.toContain(foreignCreateResult.backup.id);
    expect(download).not.toHaveBeenCalled();

    const [persistedBackup] = await connection.db
      .select()
      .from(backups)
      .where(eq(backups.id, createResult.backup.id));
    expect(persistedBackup).toMatchObject({
      agentId: AGENT_A_ID,
      createdBy: USER_A_ID,
      status: "ready",
    });
  });

  it("scopes latest and per-agent activity while foreign and missing routes stay identical", async () => {
    const latestForA = await listLatestAgentActivityForUser({
      db: connection.db,
      userId: USER_A_ID,
      limit: 10,
    });
    expect(latestForA.ok).toBe(true);
    if (!latestForA.ok) {
      throw new Error("Expected the owner activity feed to load.");
    }
    expect(latestForA.page.events).toHaveLength(1);
    expect(latestForA.page.events[0]).toMatchObject({
      agentId: AGENT_A_ID,
      message: "User A activity",
    });
    expect(JSON.stringify(latestForA)).not.toContain("User B activity");

    await expect(
      listAgentEventFeedForUser({
        db: connection.db,
        userId: USER_A_ID,
        agentId: AGENT_B_ID,
      }),
    ).resolves.toEqual({ ok: false, reason: "agent_not_found" });

    const foreignResponse = await agentEventsRoute(
      new Request(`http://localhost/api/agents/${AGENT_B_ID}/events`),
      { params: Promise.resolve({ agentId: AGENT_B_ID }) },
      routeUser(USER_A_ID),
    );
    const missingResponse = await agentEventsRoute(
      new Request(`http://localhost/api/agents/${MISSING_ID}/events`),
      { params: Promise.resolve({ agentId: MISSING_ID }) },
      routeUser(USER_A_ID),
    );
    const foreignBody = await foreignResponse.json();
    const missingBody = await missingResponse.json();

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(foreignBody).toEqual(missingBody);
    expect(JSON.stringify(foreignBody)).not.toContain(AGENT_B_ID);
    expect(JSON.stringify(foreignBody)).not.toContain("User B activity");
  });
});

function routeUser(userId: string) {
  return {
    requireApplicationUser: async () => ({ ok: true as const, userId }),
  };
}

async function seedTwoUsers(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([
    { id: USER_A_ID, clerkUserId: "user_a" },
    { id: USER_B_ID, clerkUserId: "user_b" },
  ]);
  await connection.db.insert(agents).values([
    {
      id: AGENT_A_ID,
      userId: USER_A_ID,
      name: "User A Agent",
      templateKey: "research_agent",
      status: "stopped",
    },
    {
      id: AGENT_B_ID,
      userId: USER_B_ID,
      name: "User B Agent",
      templateKey: "research_agent",
      status: "stopped",
    },
  ]);
  await connection.db.insert(agentConfigs).values([
    {
      agentId: AGENT_A_ID,
      systemPrompt: "User A prompt.",
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual",
      timezone: "UTC",
    },
    {
      agentId: AGENT_B_ID,
      systemPrompt: "User B prompt.",
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual",
      timezone: "UTC",
    },
  ]);
  await connection.db.insert(agentApprovals).values([
    {
      id: APPROVAL_A_ID,
      agentId: AGENT_A_ID,
      title: "User A approval",
      description: "Only user A can decide.",
      payloadJson: { source: "fake_runner", preview: { summary: "A private approval" } },
      requestedBy: "runner-a",
    },
    {
      id: APPROVAL_B_ID,
      agentId: AGENT_B_ID,
      title: "User B approval",
      description: "Only user B can decide.",
      payloadJson: { source: "fake_runner", preview: { summary: "B private approval" } },
      requestedBy: "runner-b",
    },
  ]);
  await connection.db.insert(agentEvents).values([
    {
      agentId: AGENT_A_ID,
      actorUserId: USER_A_ID,
      type: "agent.test",
      message: "User A activity",
      metadata: { visibility: "owner-a" },
    },
    {
      agentId: AGENT_B_ID,
      actorUserId: USER_B_ID,
      type: "agent.test",
      message: "User B activity",
      metadata: { visibility: "owner-b" },
    },
  ]);
}

async function resetOperationalTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
