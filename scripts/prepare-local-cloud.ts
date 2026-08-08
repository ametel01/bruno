import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { runners } from "@/src/server/db/schema";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";

if (process.env.BRUNO_DIGITALOCEAN_PROVIDER_MODE !== "local_docker") {
  console.log(
    JSON.stringify({
      event: "local_cloud_prepare_skipped",
      reason: "provider_mode_not_local_docker",
    }),
  );
  process.exit(0);
}

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required for local cloud preparation.");
}

const client = postgres(databaseUrl, {
  connect_timeout: 5,
  idle_timeout: 5,
  max: 1,
});
const db = drizzle(client);
const now = new Date();

try {
  const updatedRunners = await db
    .update(runners)
    .set({
      status: "deleted",
      provisioningStatus: "deleted",
      provisioningCompletedAt: now,
      deletedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(runners.provider, "digitalocean"),
        eq(runners.providerResourceId, LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID),
        isNull(runners.deletedAt),
      ),
    )
    .returning({ id: runners.id });

  console.log(
    JSON.stringify({
      event: "local_cloud_stale_runners_soft_deleted",
      deletedCount: updatedRunners.length,
      runnerIds: updatedRunners.map((runner) => runner.id),
    }),
  );
} finally {
  await client.end({ timeout: 5 });
}
