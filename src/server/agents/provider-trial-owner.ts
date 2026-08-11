import "server-only";

import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { appMetadata, users } from "@/src/server/db/schema";
import {
  DEVELOPMENT_USER_METADATA_KEY,
  HERMES_STAGING_OWNER_METADATA_KEY,
  PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY,
} from "@/src/server/users/development-user";

export { PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY };

type Transaction = Parameters<Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]>[0];

export async function resolveProviderTrialBenchmarkOwner(
  tx: Transaction,
): Promise<{ userId: string; created: boolean }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY}, 0))`,
  );
  const [pointer] = await tx
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY))
    .limit(1);
  if (pointer) {
    await assertIsolatedOwner(tx, pointer.value);
    return { userId: pointer.value, created: false };
  }

  const [created] = await tx
    .insert(users)
    .values({ clerkUserId: null })
    .returning({ id: users.id });
  if (!created) throw new Error("Provider Trial benchmark Owner insert returned no row.");
  await tx.insert(appMetadata).values({
    key: PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY,
    value: created.id,
  });
  return { userId: created.id, created: true };
}

export async function readProviderTrialBenchmarkOwner(tx: Transaction): Promise<string | null> {
  const [pointer] = await tx
    .select({ value: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, PROVIDER_TRIAL_BENCHMARK_OWNER_METADATA_KEY))
    .limit(1);
  if (!pointer) return null;
  await assertIsolatedOwner(tx, pointer.value);
  return pointer.value;
}

async function assertIsolatedOwner(tx: Transaction, userId: string): Promise<void> {
  const [owner] = await tx
    .select({ id: users.id, clerkUserId: users.clerkUserId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!owner || owner.clerkUserId !== null) {
    throw new Error("Provider Trial benchmark Owner is not an isolated Bruno principal.");
  }
  const shared = await tx
    .select({ key: appMetadata.key })
    .from(appMetadata)
    .where(
      sql`${appMetadata.value} = ${userId} and ${appMetadata.key} in (${sql.join(
        [DEVELOPMENT_USER_METADATA_KEY, HERMES_STAGING_OWNER_METADATA_KEY].map(
          (key) => sql`${key}`,
        ),
        sql`, `,
      )})`,
    )
    .limit(1);
  if (shared[0]) throw new Error("Provider Trial benchmark Owner is shared with another role.");
}
