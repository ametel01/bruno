import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { appMetadata, users } from "@/src/server/db/schema";
import { resolveHermesStagingOwner } from "@/src/server/staging/hermes-staging-product-observer";
import {
  DEVELOPMENT_USER_METADATA_KEY,
  getOrCreateDevelopmentUserId,
  HERMES_STAGING_OWNER_METADATA_KEY,
} from "@/src/server/users/development-user";

const ROLLBACK = Symbol("rollback development staging isolation test");

describe.sequential("development and Hermes staging owner isolation", () => {
  let connection: DatabaseConnection;

  beforeAll(() => {
    connection = createDatabaseConnection();
  });

  afterAll(async () => {
    await connection.close();
  });

  it("does not adopt the staging owner when staging resolves first", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      await clearOwnerPointers(tx);
      const staging = await resolveHermesStagingOwner(tx);
      if (!staging.ok) throw new Error("Expected staging owner creation.");

      await tx
        .update(users)
        .set({ createdAt: new Date("1900-01-01T00:00:00.000Z") })
        .where(eq(users.id, staging.userId));

      const developmentUserId = await getOrCreateDevelopmentUserId(tx);
      expect(developmentUserId).not.toBe(staging.userId);
    });
  });

  it("keeps an explicit development owner when development resolves first", async () => {
    await inRollbackTransaction(connection, async (tx) => {
      await clearOwnerPointers(tx);
      const [oldestUser] = await tx
        .insert(users)
        .values({
          clerkUserId: null,
          createdAt: new Date("1900-01-01T00:00:00.000Z"),
          updatedAt: new Date("1900-01-01T00:00:00.000Z"),
        })
        .returning({ id: users.id });
      if (!oldestUser) throw new Error("Expected development owner candidate.");

      const developmentUserId = await getOrCreateDevelopmentUserId(tx);
      expect(developmentUserId).toBe(oldestUser.id);

      const staging = await resolveHermesStagingOwner(tx);
      if (!staging.ok) throw new Error("Expected staging owner creation.");
      expect(staging.userId).not.toBe(developmentUserId);
      await expect(getOrCreateDevelopmentUserId(tx)).resolves.toBe(developmentUserId);
    });
  });

  it("serializes concurrent development fallback without ever selecting the staging owner", async () => {
    const secondConnection = createDatabaseConnection();
    const stagingUserId = randomUUID();
    const fallbackUserId = randomUUID();
    const priorPointers = await connection.db
      .select()
      .from(appMetadata)
      .where(
        inArray(appMetadata.key, [
          DEVELOPMENT_USER_METADATA_KEY,
          HERMES_STAGING_OWNER_METADATA_KEY,
        ]),
      );

    try {
      await connection.db.transaction(async (tx) => {
        await clearOwnerPointers(tx);
        await tx.insert(users).values([
          {
            id: stagingUserId,
            clerkUserId: null,
            createdAt: new Date("1900-01-01T00:00:00.000Z"),
            updatedAt: new Date("1900-01-01T00:00:00.000Z"),
          },
          {
            id: fallbackUserId,
            clerkUserId: null,
            createdAt: new Date("1900-01-02T00:00:00.000Z"),
            updatedAt: new Date("1900-01-02T00:00:00.000Z"),
          },
        ]);
        await tx.insert(appMetadata).values({
          key: HERMES_STAGING_OWNER_METADATA_KEY,
          value: stagingUserId,
        });
      });

      const [first, second] = await Promise.all([
        connection.db.transaction((tx) => getOrCreateDevelopmentUserId(tx)),
        secondConnection.db.transaction((tx) => getOrCreateDevelopmentUserId(tx)),
      ]);

      expect(first).toBe(second);
      expect(first).not.toBe(stagingUserId);
    } finally {
      await secondConnection.close();
      await connection.db.transaction(async (tx) => {
        await clearOwnerPointers(tx);
        if (priorPointers.length > 0) {
          await tx.insert(appMetadata).values(priorPointers);
        }
        await tx.delete(users).where(inArray(users.id, [stagingUserId, fallbackUserId]));
      });
    }
  });
});

type TestTransaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

async function clearOwnerPointers(tx: TestTransaction): Promise<void> {
  await tx
    .delete(appMetadata)
    .where(
      inArray(appMetadata.key, [DEVELOPMENT_USER_METADATA_KEY, HERMES_STAGING_OWNER_METADATA_KEY]),
    );
}

async function inRollbackTransaction(
  connection: DatabaseConnection,
  callback: (tx: TestTransaction) => Promise<void>,
): Promise<void> {
  try {
    await connection.db.transaction(async (tx) => {
      await callback(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}
