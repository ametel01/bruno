import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, appMetadata, runners, users } from "@/src/server/db/schema";
import {
  listAssignableRunnersForDevelopmentUser,
  listAssignableRunnersForUser,
} from "@/src/server/runners/runner-assignment";
import { getAssignedRunnerForActiveAgentForUser } from "@/src/server/runners/manual-runner-persistence";
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
