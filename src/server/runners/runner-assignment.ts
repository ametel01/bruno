import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runners } from "@/src/server/db/schema";
import { MANUAL_RUNNER_KIND } from "@/src/server/runners/manual-runner-persistence";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

const ASSIGNABLE_RUNNER_STATUS = "online";

export type AssignableRunnerSummary = {
  id: string;
  name: string;
  kind: typeof MANUAL_RUNNER_KIND;
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
    return await connection.db.transaction(async (tx) => {
      const userId = await getDevelopmentUserId(tx);

      if (!userId) {
        return [];
      }

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
            eq(runners.kind, MANUAL_RUNNER_KIND),
            eq(runners.status, ASSIGNABLE_RUNNER_STATUS),
            isNotNull(runners.endpointUrl),
          ),
        )
        .orderBy(desc(runners.updatedAt), desc(runners.createdAt))
        .limit(10);

      return rows.map((row) => ({
        id: row.id,
        name: summarizeOperationalText(row.name, "Runner"),
        kind: MANUAL_RUNNER_KIND,
        status: ASSIGNABLE_RUNNER_STATUS,
        detail: manualRunnerDetail(row.endpointUrl),
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

function manualRunnerDetail(endpointUrl: string | null): string {
  if (!endpointUrl) {
    return "Manual runner";
  }

  try {
    return new URL(endpointUrl).host || "Manual runner";
  } catch {
    return "Manual runner";
  }
}
