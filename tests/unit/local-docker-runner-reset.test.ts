import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runners, users } from "@/src/server/db/schema";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";
import { softDeleteLocalDockerCloudRunners } from "@/src/server/runners/local-docker-runner-reset";

describe("local Docker runner reset", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("soft-deletes only active local Docker cloud runner rows", async () => {
    const now = new Date("2026-07-08T00:00:00.000Z");
    const userId = await seedUser(connection);
    const localRunnerId = await seedDigitalOceanRunner(connection, {
      userId,
      providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID,
      endpointUrl: "http://host.docker.internal:3045",
      status: "online",
      provisioningStatus: "ready",
    });
    const realRunnerId = await seedDigitalOceanRunner(connection, {
      userId,
      providerResourceId: "582996271",
      endpointUrl: "https://146-190-124-28.sslip.io",
      status: "online",
      provisioningStatus: "ready",
    });

    const result = await softDeleteLocalDockerCloudRunners({
      createConnection: () => connection,
      now: () => now,
    });
    const persistedRunners = await connection.db
      .select({
        id: runners.id,
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        deletedAt: runners.deletedAt,
      })
      .from(runners)
      .where(eq(runners.userId, userId));

    expect(result).toEqual({
      deletedCount: 1,
      runnerIds: [localRunnerId],
    });
    expect(persistedRunners).toEqual(
      expect.arrayContaining([
        {
          id: localRunnerId,
          status: "deleted",
          provisioningStatus: "deleted",
          deletedAt: now,
        },
        {
          id: realRunnerId,
          status: "online",
          provisioningStatus: "ready",
          deletedAt: null,
        },
      ]),
    );
  });
});

async function seedUser(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("User insert returned no rows.");
  }

  return user.id;
}

async function seedDigitalOceanRunner(
  connection: DatabaseConnection,
  input: {
    endpointUrl: string;
    providerResourceId: string;
    provisioningStatus: string;
    status: string;
    userId: string;
  },
): Promise<string> {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: input.userId,
      name: "bruno Cloud Runner",
      kind: "digitalocean",
      endpointUrl: input.endpointUrl,
      status: input.status,
      provider: DIGITALOCEAN_PROVIDER,
      providerResourceId: input.providerResourceId,
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: input.provisioningStatus,
      provisioningStartedAt: new Date("2026-07-07T23:58:00.000Z"),
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Runner insert returned no rows.");
  }

  return runner.id;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_heartbeats, runners, users restart identity cascade`;
}
