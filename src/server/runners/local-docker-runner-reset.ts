import { and, eq, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runners } from "@/src/server/db/schema";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";

export async function softDeleteLocalDockerCloudRunners(
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<{ deletedCount: number; runnerIds: string[] }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    const updatedRunners = await connection.db
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
          eq(runners.provider, DIGITALOCEAN_PROVIDER),
          eq(runners.providerResourceId, LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });

    return {
      deletedCount: updatedRunners.length,
      runnerIds: updatedRunners.map((runner) => runner.id),
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}
