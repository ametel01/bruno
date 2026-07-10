import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import DashboardPage from "@/app/dashboard/page";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createManualBackupForUser } from "@/src/server/backups/create-backup";
import { getCostEstimatesForUser } from "@/src/server/costs/cost-estimates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentApprovals,
  agentConfigs,
  agentEvents,
  agentLogs,
  agents,
  backups,
  runners,
  users,
} from "@/src/server/db/schema";

const USER_A_ID = "00000000-0000-4000-8000-000000000a11";
const USER_B_ID = "00000000-0000-4000-8000-000000000b11";
const AGENT_A_ID = "00000000-0000-4000-8000-000000000a12";
const AGENT_B_ID = "00000000-0000-4000-8000-000000000b12";
const MANUAL_RUNNER_A_ID = "00000000-0000-4000-8000-000000000a13";
const MANUAL_RUNNER_B_ID = "00000000-0000-4000-8000-000000000b13";
const CLOUD_RUNNER_A_ID = "00000000-0000-4000-8000-000000000a14";
const CLOUD_RUNNER_B_ID = "00000000-0000-4000-8000-000000000b14";
const APPROVAL_A_ID = "00000000-0000-4000-8000-000000000a15";
const APPROVAL_B_ID = "00000000-0000-4000-8000-000000000b15";
const LOG_A_ID = "00000000-0000-4000-8000-000000000a16";
const LOG_B_ID = "00000000-0000-4000-8000-000000000b16";
const MISSING_AGENT_ID = "00000000-0000-4000-8000-000000000404";

const requestIdentity = vi.hoisted(() => ({
  userId: "00000000-0000-4000-8000-000000000a11",
}));

vi.mock("@/src/server/users/operational-application-user", () => ({
  requireOperationalApplicationUser: async () => ({
    ok: true as const,
    userId: requestIdentity.userId,
  }),
}));

vi.mock("next/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/navigation")>();

  return {
    ...actual,
    useRouter: () => ({ refresh: vi.fn() }),
  };
});

describe("operational page user isolation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetOperationalTables(connection);
    await seedOperationalPageUsers(connection);
  });

  afterEach(async () => {
    await resetOperationalTables(connection);
    await connection.close();
  });

  it("renders each user's dashboard and detail without the other user's leak strings", async () => {
    for (const expected of [
      {
        userId: USER_A_ID,
        agentId: AGENT_A_ID,
        ownPrefix: "A-ONLY",
        foreignPrefix: "B-ONLY",
      },
      {
        userId: USER_B_ID,
        agentId: AGENT_B_ID,
        ownPrefix: "B-ONLY",
        foreignPrefix: "A-ONLY",
      },
    ]) {
      requestIdentity.userId = expected.userId;
      const dashboardHtml = renderToStaticMarkup(await DashboardPage());
      const detailHtml = renderToStaticMarkup(
        await AgentDetailPage({ params: Promise.resolve({ agentId: expected.agentId }) }),
      );
      const costJson = JSON.stringify(await getCostEstimatesForUser(expected.userId));

      for (const suffix of ["AGENT", "APPROVAL", "ACTIVITY", "MANUAL-RUNNER", "PROCESS-LOG"]) {
        expect(dashboardHtml).toContain(`${expected.ownPrefix}-${suffix}`);
        expect(dashboardHtml).not.toContain(`${expected.foreignPrefix}-${suffix}`);
      }
      expect(dashboardHtml).toContain(`${expected.ownPrefix}-CLOUD-RUNNER`);
      expect(dashboardHtml).not.toContain(`${expected.foreignPrefix}-CLOUD-RUNNER`);

      for (const suffix of ["AGENT", "PROMPT", "APPROVAL", "ACTIVITY", "MANUAL-RUNNER"]) {
        expect(detailHtml).toContain(`${expected.ownPrefix}-${suffix}`);
        expect(detailHtml).not.toContain(`${expected.foreignPrefix}-${suffix}`);
      }
      expect(detailHtml).toContain("1 listed");
      expect(detailHtml).not.toContain(`${expected.foreignPrefix}-PROCESS-LOG`);
      expect(costJson).toContain(`${expected.ownPrefix}-MANUAL-RUNNER`);
      expect(costJson).toContain(`${expected.ownPrefix}-CLOUD-RUNNER`);
      expect(costJson).not.toContain(`${expected.foreignPrefix}-MANUAL-RUNNER`);
      expect(costJson).not.toContain(`${expected.foreignPrefix}-CLOUD-RUNNER`);
    }
  });

  it("makes foreign and missing detail selections indistinguishable with zero database writes", async () => {
    requestIdentity.userId = USER_A_ID;
    const before = await captureOperationalState(connection);
    const [foreign, missing] = await Promise.allSettled([
      AgentDetailPage({ params: Promise.resolve({ agentId: AGENT_B_ID }) }),
      AgentDetailPage({ params: Promise.resolve({ agentId: MISSING_AGENT_ID }) }),
    ]);

    expect(foreign.status).toBe("rejected");
    expect(missing.status).toBe("rejected");
    if (foreign.status !== "rejected" || missing.status !== "rejected") {
      throw new Error("Expected both concealed detail lookups to reject with notFound.");
    }
    expect(notFoundDigest(foreign.reason)).toBe(notFoundDigest(missing.reason));
    expect(String(foreign.reason)).not.toContain(AGENT_B_ID);
    expect(String(foreign.reason)).not.toContain("B-ONLY");
    await expect(captureOperationalState(connection)).resolves.toEqual(before);
  });
});

function notFoundDigest(error: unknown): string {
  if (typeof error === "object" && error !== null && "digest" in error) {
    return String(error.digest);
  }

  return String(error);
}

async function seedOperationalPageUsers(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(users).values([
    { id: USER_A_ID, clerkUserId: "page_user_a" },
    { id: USER_B_ID, clerkUserId: "page_user_b" },
  ]);
  await connection.db
    .insert(runners)
    .values([
      manualRunner(USER_A_ID, MANUAL_RUNNER_A_ID, "A-ONLY"),
      manualRunner(USER_B_ID, MANUAL_RUNNER_B_ID, "B-ONLY"),
      cloudRunner(USER_A_ID, CLOUD_RUNNER_A_ID, "A-ONLY"),
      cloudRunner(USER_B_ID, CLOUD_RUNNER_B_ID, "B-ONLY"),
    ]);
  await connection.db.insert(agents).values([
    {
      id: AGENT_A_ID,
      userId: USER_A_ID,
      runnerId: MANUAL_RUNNER_A_ID,
      name: "A-ONLY-AGENT",
      templateKey: "research_agent",
      status: "stopped",
    },
    {
      id: AGENT_B_ID,
      userId: USER_B_ID,
      runnerId: MANUAL_RUNNER_B_ID,
      name: "B-ONLY-AGENT",
      templateKey: "research_agent",
      status: "stopped",
    },
  ]);
  await connection.db
    .insert(agentConfigs)
    .values([agentConfig(AGENT_A_ID, "A-ONLY-PROMPT"), agentConfig(AGENT_B_ID, "B-ONLY-PROMPT")]);
  await connection.db
    .insert(agentApprovals)
    .values([
      approval(APPROVAL_A_ID, AGENT_A_ID, "A-ONLY"),
      approval(APPROVAL_B_ID, AGENT_B_ID, "B-ONLY"),
    ]);
  await connection.db
    .insert(agentEvents)
    .values([
      event(USER_A_ID, AGENT_A_ID, "A-ONLY-ACTIVITY"),
      event(USER_B_ID, AGENT_B_ID, "B-ONLY-ACTIVITY"),
    ]);
  await connection.db
    .insert(agentLogs)
    .values([
      processLog(LOG_A_ID, AGENT_A_ID, MANUAL_RUNNER_A_ID, "A-ONLY-PROCESS-LOG"),
      processLog(LOG_B_ID, AGENT_B_ID, MANUAL_RUNNER_B_ID, "B-ONLY-PROCESS-LOG"),
    ]);

  const storage = new FakeBackupObjectStorage("agentbay-page-isolation");
  for (const input of [
    { userId: USER_A_ID, agentId: AGENT_A_ID },
    { userId: USER_B_ID, agentId: AGENT_B_ID },
  ]) {
    const result = await createManualBackupForUser(input, {
      createConnection: () => connection,
      storage,
    });
    if (!result.ok) {
      throw new Error(`Failed to seed ${input.userId} backup: ${result.reason}`);
    }
  }
}

function manualRunner(userId: string, id: string, prefix: string) {
  return {
    id,
    userId,
    name: `${prefix}-MANUAL-RUNNER`,
    kind: "manual_vps",
    endpointUrl: `https://${prefix.toLowerCase()}-runner.example.test`,
    status: "offline",
  };
}

function cloudRunner(userId: string, id: string, prefix: string) {
  const startedAt = new Date("2026-07-10T00:00:00.000Z");
  return {
    id,
    userId,
    name: `${prefix}-CLOUD-RUNNER`,
    kind: "digitalocean",
    status: "offline",
    provider: "digitalocean",
    providerResourceId: `${prefix}-RESOURCE`,
    region: "sgp1",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    provisioningStatus: "ready",
    provisioningStartedAt: startedAt,
    provisioningCompletedAt: startedAt,
  };
}

function agentConfig(agentId: string, prompt: string) {
  return {
    agentId,
    systemPrompt: prompt,
    modelProvider: "not_configured",
    modelName: "not_configured",
    scheduleMode: "manual" as const,
    timezone: "UTC",
  };
}

function approval(id: string, agentId: string, prefix: string) {
  return {
    id,
    agentId,
    title: `${prefix}-APPROVAL`,
    description: `${prefix}-APPROVAL-DESCRIPTION`,
    payloadJson: { source: "isolation", preview: { summary: `${prefix}-PAYLOAD` } },
    requestedBy: `${prefix}-RUNNER`,
  };
}

function event(actorUserId: string, agentId: string, message: string) {
  return {
    actorUserId,
    agentId,
    type: "agent.isolation_test",
    message,
    metadata: { marker: message },
  };
}

function processLog(id: string, agentId: string, runnerId: string, message: string) {
  return {
    id,
    agentId,
    runnerId,
    source: "manual_runner",
    stream: "stdout",
    level: "info",
    message,
    sequence: 1,
  };
}

async function captureOperationalState(connection: DatabaseConnection) {
  const [agentRows, approvalRows, backupRows, eventRows, runnerRows] = await Promise.all([
    connection.db.select().from(agents),
    connection.db.select().from(agentApprovals),
    connection.db.select().from(backups),
    connection.db.select().from(agentEvents),
    connection.db.select().from(runners),
  ]);

  return { agentRows, approvalRows, backupRows, eventRows, runnerRows };
}

async function resetOperationalTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
