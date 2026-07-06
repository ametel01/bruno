import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { appMetadata, runners, users } from "@/src/server/db/schema";
import { listAssignableRunnersForDevelopmentUser } from "@/src/server/runners/runner-assignment";
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
      runners,
      app_metadata,
      users
    restart identity cascade
  `);
}
