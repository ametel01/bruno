import { asc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { appMetadata, users } from "@/src/server/db/schema";

export const DEVELOPMENT_USER_METADATA_KEY = "local_development_user_id";

type DevelopmentUserTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export async function getDevelopmentUserId(tx: DevelopmentUserTransaction): Promise<string | null> {
  const [developmentUserPointer] = await tx
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, DEVELOPMENT_USER_METADATA_KEY))
    .limit(1);

  if (developmentUserPointer) {
    const [metadataUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, developmentUserPointer.value))
      .limit(1);

    if (metadataUser) {
      return metadataUser.id;
    }
  }

  const [existingUser] = await tx
    .select({ id: users.id })
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);

  return existingUser?.id ?? null;
}

export async function getOrCreateDevelopmentUserId(
  tx: DevelopmentUserTransaction,
): Promise<string> {
  const existingUserId = await getDevelopmentUserId(tx);

  if (existingUserId) {
    await rememberDevelopmentUserId(tx, existingUserId);
    return existingUserId;
  }

  const [createdUser] = await tx.insert(users).values({}).returning({ id: users.id });

  if (!createdUser) {
    throw new Error("Development user insert returned no rows.");
  }

  await rememberDevelopmentUserId(tx, createdUser.id);
  return createdUser.id;
}

async function rememberDevelopmentUserId(
  tx: DevelopmentUserTransaction,
  userId: string,
): Promise<void> {
  await tx
    .insert(appMetadata)
    .values({
      key: DEVELOPMENT_USER_METADATA_KEY,
      value: userId,
    })
    .onConflictDoUpdate({
      target: appMetadata.key,
      set: {
        value: userId,
        updatedAt: new Date(),
      },
    });
}
