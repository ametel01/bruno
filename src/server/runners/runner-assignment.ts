import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runners } from "@/src/server/db/schema";
import {
  DIGITALOCEAN_RUNNER_KIND,
  type DigitalOceanRunnerKind,
} from "@/src/server/runners/digitalocean-provider";
import { MANUAL_RUNNER_KIND } from "@/src/server/runners/manual-runner-persistence";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

const ASSIGNABLE_RUNNER_STATUS = "online";

export type AssignableRunnerSummary = {
  id: string;
  name: string;
  kind: typeof MANUAL_RUNNER_KIND | DigitalOceanRunnerKind;
  status: typeof ASSIGNABLE_RUNNER_STATUS;
  detail: string;
};

export class RunnerAssignmentPersistenceError extends Error {
  constructor() {
    super("Assignable runners could not be loaded.");
    this.name = "RunnerAssignmentPersistenceError";
  }
}

export async function listAssignableRunnersForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<AssignableRunnerSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const userId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    return userId
      ? await listAssignableRunnersForUser(userId, { createConnection: () => connection })
      : [];
  } catch {
    throw new RunnerAssignmentPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listAssignableRunnersForUser(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<AssignableRunnerSummary[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: runners.id,
          name: runners.name,
          kind: runners.kind,
          status: runners.status,
          endpointUrl: runners.endpointUrl,
        })
        .from(runners)
        .where(
          and(
            eq(runners.userId, userId),
            isNull(runners.deletedAt),
            eq(runners.status, ASSIGNABLE_RUNNER_STATUS),
            isNotNull(runners.endpointUrl),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      return rows.map((row) => ({
        id: row.id,
        name: summarizeOperationalText(row.name, "Runner"),
        kind: row.kind === DIGITALOCEAN_RUNNER_KIND ? DIGITALOCEAN_RUNNER_KIND : MANUAL_RUNNER_KIND,
        status: ASSIGNABLE_RUNNER_STATUS,
        detail: runnerDetail(row.endpointUrl, row.kind),
      }));
    });
  } catch {
    throw new RunnerAssignmentPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function runnerDetail(endpointUrl: string | null, kind: string): string {
  const fallback = kind === DIGITALOCEAN_RUNNER_KIND ? "DigitalOcean runner" : "Manual runner";

  if (!endpointUrl) {
    return fallback;
  }

  try {
    return new URL(endpointUrl).host || fallback;
  } catch {
    return fallback;
  }
}
