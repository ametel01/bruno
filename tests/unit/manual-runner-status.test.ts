import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, appMetadata, runnerHeartbeats, runners, users } from "@/src/server/db/schema";
import { RUNNER_HEARTBEAT_STALE_THRESHOLD_MS } from "@/src/server/runners/runner-heartbeat";
import {
  getAssignedManualRunnerStatusForDevelopmentUserAgent,
  listManualRunnerStatusSummariesForDevelopmentUser,
  listSettingsRunnerManagementSummariesForDevelopmentUser,
  type ManualRunnerCapacitySummary,
  toAssignedManualRunnerStatusSummary,
  toManualRunnerStatusSummary,
  toSettingsRunnerManagementSummary,
} from "@/src/server/runners/manual-runner-status";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";

function capacity(
  overrides: Partial<ManualRunnerCapacitySummary> = {},
): ManualRunnerCapacitySummary {
  return {
    runningAgents: 0,
    maxAgents: 1,
    cpuUsedPercent: null,
    memoryUsedMb: null,
    memoryTotalMb: null,
    diskUsedMb: null,
    diskTotalMb: null,
    blocker: null,
    ...overrides,
  };
}

describe("manual runner status summaries", () => {
  it("exposes only safe runner fields and endpoint host", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Manual Runner",
      kind: "manual_vps",
      endpointUrl: "https://user:password@runner.example.com:8443/runner/v1?token=hidden",
      status: "active",
      updatedAt: new Date("2026-07-05T01:00:00.000Z"),
    });

    expect(summary).toEqual({
      name: "Manual Runner",
      kind: "manual_vps",
      endpointHost: "runner.example.com:8443",
      status: "unknown",
      capacity: capacity(),
      version: null,
      lastSeenAt: null,
      updatedAt: "2026-07-05T01:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("password");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("/runner/v1");
  });

  it("redacts unsafe names and maps inactive assignments to offline alerts", () => {
    const assigned = toAssignedManualRunnerStatusSummary({
      name: "TOKEN=stored-for-downstream",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "inactive",
      updatedAt: "2026-07-05T01:30:00.000Z",
    });

    expect(assigned).toMatchObject({
      name: "Sensitive details omitted.",
      endpointHost: "runner.example.com",
      status: "offline",
      capacity: capacity(),
      alertState: "offline",
      alertMessage:
        "Assigned runner is inactive or unreachable. Check the runner host and service before restarting work.",
    });
    expect(JSON.stringify(assigned)).not.toContain("stored-for-downstream");
    expect(JSON.stringify(assigned)).not.toContain("runnerId");
    expect(JSON.stringify(assigned)).not.toContain("runner_id");
  });

  it("uses latest heartbeat status, version, capacity, and last-seen fields without unsafe metadata", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Online Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "active",
      updatedAt: "2026-07-05T02:00:00.000Z",
      assignedRunningAgents: 3,
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.2.3",
          metrics: {
            maxAgents: 5,
            runningAgents: 2,
            cpuPercent: 37,
            memoryUsedMb: 512,
            memoryTotalMb: 2048,
            diskUsedMb: 4096,
            diskTotalMb: 8192,
            apiToken: "must-not-render",
          },
        },
        observedAt: "2026-07-05T02:01:00.000Z",
      },
    });

    expect(summary).toEqual({
      name: "Online Runner",
      kind: "manual_vps",
      endpointHost: "runner.example.com",
      status: "online",
      capacity: capacity({
        runningAgents: 3,
        maxAgents: 5,
        cpuUsedPercent: 37,
        memoryUsedMb: 512,
        memoryTotalMb: 2048,
        diskUsedMb: 4096,
        diskTotalMb: 8192,
      }),
      version: "agentbay-runner/1.2.3",
      lastSeenAt: "2026-07-05T02:01:00.000Z",
      updatedAt: "2026-07-05T02:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("metrics");
    expect(JSON.stringify(summary)).not.toContain("cpuPercent");
    expect(JSON.stringify(summary)).not.toContain("apiToken");
    expect(JSON.stringify(summary)).not.toContain("must-not-render");
  });

  it("keeps reconciled offline runner state ahead of a stale online heartbeat", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Stale Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "offline",
      updatedAt: "2026-07-05T08:02:00.000Z",
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.0.0",
        },
        observedAt: "2026-07-05T08:00:29.999Z",
      },
    });
    const assigned = toAssignedManualRunnerStatusSummary({
      name: "Assigned Stale Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "offline",
      updatedAt: "2026-07-05T08:02:00.000Z",
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.0.0",
        },
        observedAt: "2026-07-05T08:00:29.999Z",
      },
    });

    expect(summary).toMatchObject({
      status: "offline",
      capacity: capacity(),
      version: "agentbay-runner/1.0.0",
      lastSeenAt: "2026-07-05T08:00:29.999Z",
    });
    expect(assigned).toMatchObject({
      status: "offline",
      alertState: "offline",
      alertMessage:
        "Assigned runner is inactive or unreachable. Check the runner host and service before restarting work.",
    });
  });

  it("redacts secret-looking heartbeat versions", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Degraded Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "degraded",
      updatedAt: "2026-07-05T02:00:00.000Z",
      latestHeartbeat: {
        status: "degraded",
        metadata: {
          version: "token=stored-for-downstream",
        },
        observedAt: "2026-07-05T02:01:00.000Z",
      },
    });

    expect(summary.version).toBe("Sensitive details omitted.");
    expect(JSON.stringify(summary)).not.toContain("stored-for-downstream");
  });

  it("adds a settings-only management id without adding secret or hash fields", () => {
    const summary = toSettingsRunnerManagementSummary({
      id: "00000000-0000-4000-8000-000000000133",
      name: "Settings Runner",
      kind: "manual_vps",
      endpointUrl: "https://user:password@runner-settings.example.com:8443/runner/v1?token=hidden",
      status: "online",
      updatedAt: "2026-07-05T03:01:00.000Z",
    });

    expect(summary).toEqual({
      managementId: "00000000-0000-4000-8000-000000000133",
      name: "Settings Runner",
      kind: "manual_vps",
      endpointHost: "runner-settings.example.com:8443",
      status: "online",
      capacity: capacity(),
      version: null,
      lastSeenAt: null,
      updatedAt: "2026-07-05T03:01:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("password");
    expect(JSON.stringify(summary)).not.toContain("token=hidden");
    expect(JSON.stringify(summary)).not.toContain("credentialHash");
    expect(JSON.stringify(summary)).not.toContain("tokenHash");
  });
});

describe.sequential("manual runner status stale heartbeat reconciliation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("reconciles stale online runners before dashboard status summaries", async () => {
    const now = new Date("2026-07-05T08:02:00.000Z");
    const { runner } = await seedStaleManualRunner(connection, now);

    const summaries = await listManualRunnerStatusSummariesForDevelopmentUser({
      createConnection: () => connection,
      now: () => now,
    });
    const [persistedRunner] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      status: "offline",
      lastSeenAt: "2026-07-05T08:00:29.999Z",
      updatedAt: "2026-07-05T08:02:00.000Z",
    });
    expect(persistedRunner).toEqual({ status: "offline", updatedAt: now });
  });

  it("reconciles stale online runners before settings management summaries", async () => {
    const now = new Date("2026-07-05T08:02:00.000Z");
    const { runner } = await seedStaleManualRunner(connection, now);

    const summaries = await listSettingsRunnerManagementSummariesForDevelopmentUser({
      createConnection: () => connection,
      now: () => now,
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      managementId: runner.id,
      status: "offline",
      lastSeenAt: "2026-07-05T08:00:29.999Z",
    });
  });

  it("reconciles stale online runners before assigned runner summaries", async () => {
    const now = new Date("2026-07-05T08:02:00.000Z");
    const { agent, runner } = await seedStaleManualRunner(connection, now, {
      assignAgent: true,
    });

    const summary = await getAssignedManualRunnerStatusForDevelopmentUserAgent(agent.id, {
      createConnection: () => connection,
      now: () => now,
    });
    const [persistedRunner] = await connection.db
      .select({ status: runners.status, updatedAt: runners.updatedAt })
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);

    expect(summary).toMatchObject({
      status: "offline",
      alertState: "offline",
      lastSeenAt: "2026-07-05T08:00:29.999Z",
    });
    expect(persistedRunner).toEqual({ status: "offline", updatedAt: now });
  });
});

async function seedStaleManualRunner(
  connection: DatabaseConnection,
  now: Date,
  input: { assignAgent?: boolean } = {},
): Promise<{ agent: { id: string }; runner: { id: string } }> {
  const staleObservedAt = new Date(now.getTime() - RUNNER_HEARTBEAT_STALE_THRESHOLD_MS - 1);
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("User insert returned no rows.");
  }

  await connection.db.insert(appMetadata).values({
    key: DEVELOPMENT_USER_METADATA_KEY,
    value: user.id,
  });

  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: user.id,
      name: "Stale Manual Runner",
      kind: "manual_vps",
      endpointUrl: "https://stale-manual-runner.example.com",
      status: "online",
      createdAt: new Date("2026-07-05T08:00:00.000Z"),
      updatedAt: new Date("2026-07-05T08:00:00.000Z"),
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Runner insert returned no rows.");
  }

  await connection.db.insert(runnerHeartbeats).values({
    runnerId: runner.id,
    status: "online",
    metadata: { version: "agentbay-runner/1.0.0" },
    observedAt: staleObservedAt,
    createdAt: staleObservedAt,
  });

  if (!input.assignAgent) {
    return { agent: { id: "" }, runner };
  }

  const [agent] = await connection.db
    .insert(agents)
    .values({
      userId: user.id,
      runnerId: runner.id,
      name: "Assigned Stale Runner Agent",
      templateKey: "research_agent",
      status: "stopped",
    })
    .returning({ id: agents.id });

  if (!agent) {
    throw new Error("Agent insert returned no rows.");
  }

  return { agent, runner };
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
