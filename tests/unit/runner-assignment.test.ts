import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentRuntimeReconciliations,
  agents,
  appMetadata,
  runnerHeartbeats,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  listAssignableRunnersForDevelopmentUser,
  listAssignableRunnersForUser,
} from "@/src/server/runners/runner-assignment";
import {
  assignRunnerToActiveAgentForDevelopmentUser,
  getAssignedRunnerForActiveAgentForUser,
} from "@/src/server/runners/manual-runner-persistence";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";

describe.sequential("runner assignment list", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("includes online DigitalOcean runners as assignable runners", async () => {
    const userId = await seedDevelopmentUser(connection);
    await connection.db.insert(runners).values([
      {
        userId,
        name: "Manual Runner",
        kind: "manual_vps",
        status: "online",
        endpointUrl: "https://manual-runner.example.com",
        updatedAt: new Date("2026-07-06T08:00:00.000Z"),
      },
      {
        userId,
        name: "DigitalOcean Runner",
        kind: "digitalocean",
        status: "online",
        endpointUrl: "https://203-0-113-77.sslip.io",
        provider: "digitalocean",
        providerResourceId: "123456",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningStartedAt: new Date("2026-07-06T07:55:00.000Z"),
        provisioningCompletedAt: new Date("2026-07-06T08:00:00.000Z"),
        updatedAt: new Date("2026-07-06T08:01:00.000Z"),
      },
    ]);

    const assignable = await listAssignableRunnersForDevelopmentUser({
      createConnection: () => connection,
    });

    expect(assignable).toEqual([
      {
        id: expect.any(String),
        name: "DigitalOcean Runner",
        kind: "digitalocean",
        status: "online",
        detail: "203-0-113-77.sslip.io",
      },
      {
        id: expect.any(String),
        name: "Manual Runner",
        kind: "manual_vps",
        status: "online",
        detail: "manual-runner.example.com",
      },
    ]);
  });

  it("keeps assignable and assigned runner reads within the explicit user", async () => {
    const [owner, foreignUser] = await connection.db
      .insert(users)
      .values([{}, {}])
      .returning({ id: users.id });

    if (!owner || !foreignUser) {
      throw new Error("User inserts returned no rows.");
    }

    const [ownedRunner, foreignRunner] = await connection.db
      .insert(runners)
      .values([
        {
          userId: owner.id,
          name: "Owned Runner",
          kind: "manual_vps",
          status: "online",
          endpointUrl: "https://owned-runner.example.com",
        },
        {
          userId: foreignUser.id,
          name: "Foreign Runner",
          kind: "manual_vps",
          status: "online",
          endpointUrl: "https://foreign-runner.example.com",
        },
      ])
      .returning({ id: runners.id });

    if (!ownedRunner || !foreignRunner) {
      throw new Error("Runner inserts returned no rows.");
    }

    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId: owner.id,
        runnerId: ownedRunner.id,
        name: "Owned Agent",
        templateKey: "research_agent",
        status: "running",
      })
      .returning({ id: agents.id });

    if (!agent) {
      throw new Error("Agent insert returned no rows.");
    }

    const assignable = await listAssignableRunnersForUser(owner.id, {
      createConnection: () => connection,
    });
    const assigned = await getAssignedRunnerForActiveAgentForUser(owner.id, agent.id, {
      createConnection: () => connection,
    });
    const foreignRead = await getAssignedRunnerForActiveAgentForUser(foreignUser.id, agent.id, {
      createConnection: () => connection,
    });

    expect(assignable.map((runner) => runner.id)).toEqual([ownedRunner.id]);
    expect(assigned).toMatchObject({ id: ownedRunner.id, userId: owner.id });
    expect(foreignRead).toBeNull();
  });

  it("fails closed instead of reassigning a managed-ready runtime", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [currentRunner, replacementRunner] = await connection.db
      .insert(runners)
      .values([
        {
          userId,
          name: "Current Runner",
          kind: "manual_vps",
          status: "online",
          endpointUrl: "https://current-runner.example.com",
        },
        {
          userId,
          name: "Replacement Runner",
          kind: "manual_vps",
          status: "online",
          endpointUrl: "https://replacement-runner.example.com",
        },
      ])
      .returning({ id: runners.id });
    const [agent] = await connection.db
      .insert(agents)
      .values({
        userId,
        runnerId: currentRunner?.id,
        name: "Managed Ready Agent",
        templateKey: "research_agent",
        status: "running",
        desiredStatus: "running",
      })
      .returning({ id: agents.id });
    const operationId = "00000000-0000-4000-8000-000000000931";
    const now = new Date("2026-08-03T14:00:00.000Z");
    await connection.db.insert(agentDeployments).values({
      agentId: agent?.id ?? "",
      userId,
      stage: "ready",
      configRevision: "cfg-runner-assignment-0",
      idempotencyKey: "Managed-Runner-Assignment-001",
      runnerOperationId: operationId,
      runnerAcceptedAt: now,
      canaryState: "passed",
      canaryAttemptedAt: now,
      canaryCompletedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await connection.db.insert(agentRuntimeReconciliations).values({
      agentId: agent?.id ?? "",
      userId,
      state: "observing",
      configRevision: "cfg-runner-assignment-0",
      operationId,
      lastObservedAt: now,
      lastReadyAt: now,
      nextAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const result = await assignRunnerToActiveAgentForDevelopmentUser(
      { agentId: agent?.id ?? "", runnerId: replacementRunner?.id ?? "" },
      { createConnection: () => connection, now: () => now },
    );

    expect(result).toEqual({ ok: false, reason: "runner_not_found" });
    const [persistedAgent] = await connection.db.select().from(agents);
    const [runtime] = await connection.db.select().from(agentRuntimeReconciliations);
    expect(persistedAgent?.runnerId).toBe(currentRunner?.id);
    expect(runtime).toMatchObject({ generation: 0, configRevision: "cfg-runner-assignment-0" });
  });

  it("fails closed when assigning a desired-running manual agent to a full max-one runner", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [targetRunner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Full Target Runner",
        kind: "manual_vps",
        status: "online",
        endpointUrl: "https://full-target-runner.example.com",
      })
      .returning({ id: runners.id });
    if (!targetRunner) {
      throw new Error("Runner insert returned no rows.");
    }
    await seedRunnerHeartbeat(connection, targetRunner.id, 1);
    const [currentAgent, sibling] = await connection.db
      .insert(agents)
      .values([
        {
          userId,
          name: "Desired Running Reassignment Agent",
          templateKey: "research_agent",
          status: "error",
          desiredStatus: "running",
        },
        {
          userId,
          runnerId: targetRunner.id,
          name: "Target Capacity Sibling",
          templateKey: "github_issue_agent",
          status: "running",
          desiredStatus: "running",
        },
      ])
      .returning({ id: agents.id });
    if (!currentAgent || !sibling) {
      throw new Error("Agent inserts returned no rows.");
    }

    const result = await assignRunnerToActiveAgentForDevelopmentUser(
      { agentId: currentAgent.id, runnerId: targetRunner.id },
      { createConnection: () => connection },
    );
    const assigned = await connection.db
      .select({ id: agents.id, runnerId: agents.runnerId })
      .from(agents);

    expect(result).toEqual({ ok: false, reason: "runner_capacity_reached" });
    expect(assigned.find((agent) => agent.id === currentAgent.id)?.runnerId).toBeNull();
    expect(assigned.find((agent) => agent.id === sibling.id)?.runnerId).toBe(targetRunner.id);
  });

  it("serializes concurrent desired-running manual assignments to one max-one runner", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [targetRunner] = await connection.db
      .insert(runners)
      .values({
        userId,
        name: "Concurrent Assignment Runner",
        kind: "manual_vps",
        status: "online",
        endpointUrl: "https://concurrent-assignment-runner.example.com",
      })
      .returning({ id: runners.id });
    if (!targetRunner) {
      throw new Error("Runner insert returned no rows.");
    }
    await seedRunnerHeartbeat(connection, targetRunner.id, 1);
    const [agentA, agentB] = await connection.db
      .insert(agents)
      .values([
        {
          userId,
          name: "Concurrent Assignment A",
          templateKey: "research_agent",
          status: "error",
          desiredStatus: "running",
        },
        {
          userId,
          name: "Concurrent Assignment B",
          templateKey: "github_issue_agent",
          status: "error",
          desiredStatus: "running",
        },
      ])
      .returning({ id: agents.id });
    if (!agentA || !agentB) {
      throw new Error("Agent inserts returned no rows.");
    }
    const secondConnection = createDatabaseConnection();

    try {
      const results = await Promise.all([
        assignRunnerToActiveAgentForDevelopmentUser(
          { agentId: agentA.id, runnerId: targetRunner.id },
          { createConnection: () => connection },
        ),
        assignRunnerToActiveAgentForDevelopmentUser(
          { agentId: agentB.id, runnerId: targetRunner.id },
          { createConnection: () => secondConnection },
        ),
      ]);
      const assigned = await connection.db
        .select({ id: agents.id, runnerId: agents.runnerId, desiredStatus: agents.desiredStatus })
        .from(agents)
        .where(eq(agents.runnerId, targetRunner.id));

      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ok: true }),
          { ok: false, reason: "runner_capacity_reached" },
        ]),
      );
      expect(assigned).toHaveLength(1);
      expect(assigned[0]?.desiredStatus).toBe("running");
    } finally {
      await secondConnection.close();
    }
  });
});

async function seedDevelopmentUser(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("User insert returned no rows.");
  }

  await connection.db.insert(appMetadata).values({
    key: DEVELOPMENT_USER_METADATA_KEY,
    value: user.id,
  });

  return user.id;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.db.execute(sql`
    truncate table
      runner_heartbeats,
      runner_credentials,
      runner_registration_tokens,
      runner_provisioning_events,
      agents,
      runners,
      app_metadata,
      users
    restart identity cascade
  `);
}

async function seedRunnerHeartbeat(
  connection: DatabaseConnection,
  runnerId: string,
  maxAgents: number,
): Promise<void> {
  await connection.db.insert(runnerHeartbeats).values({
    runnerId,
    status: "online",
    metadata: { metrics: { maxAgents, runningAgents: 0 } },
    observedAt: new Date("2099-01-01T00:00:00.000Z"),
    createdAt: new Date("2099-01-01T00:00:00.000Z"),
  });
}
