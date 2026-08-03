import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import { classifyManagedRuntimeForUpdate } from "@/src/server/agents/agent-runtime-lifecycle";
import { agents } from "@/src/server/db/schema";
import {
  lockRunnerPlacementCapacityInTransaction,
  selectRunnerPlacementForUserInTransaction,
} from "@/src/server/runners/runner-placement";

export type HermesSetupRunnerAssignmentResult =
  | { ok: true; runnerId: string }
  | {
      ok: false;
      reason: "agent_not_found" | "no_online_runner" | "runner_capacity_reached";
    };

export async function assignRunnerForHermesSetup(
  connection: DatabaseConnection,
  input: { agentId: string; userId: string },
): Promise<HermesSetupRunnerAssignmentResult> {
  return await connection.db.transaction(async (tx) => {
    const [agent] = await tx
      .select({ id: agents.id, runnerId: agents.runnerId })
      .from(agents)
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);

    if (!agent) {
      return { ok: false, reason: "agent_not_found" } as const;
    }

    if (agent.runnerId) {
      return { ok: true, runnerId: agent.runnerId } as const;
    }

    const runtimeClassification = await classifyManagedRuntimeForUpdate(tx, input);

    if (
      runtimeClassification.kind === "managed_ready" ||
      runtimeClassification.kind === "managed_unavailable"
    ) {
      return { ok: false, reason: "agent_not_found" } as const;
    }

    const placement = await selectRunnerPlacementForUserInTransaction(tx, input.userId);

    if (!placement.ok) {
      return {
        ok: false,
        reason:
          placement.reason === "runner_capacity_reached"
            ? "runner_capacity_reached"
            : "no_online_runner",
      } as const;
    }

    await lockRunnerPlacementCapacityInTransaction(tx, placement.runner.id);
    const confirmed = await selectRunnerPlacementForUserInTransaction(tx, input.userId, {
      runnerId: placement.runner.id,
    });

    if (!confirmed.ok) {
      return {
        ok: false,
        reason:
          confirmed.reason === "runner_capacity_reached"
            ? "runner_capacity_reached"
            : "no_online_runner",
      } as const;
    }

    const [assigned] = await tx
      .update(agents)
      .set({ runnerId: confirmed.runner.id, updatedAt: new Date() })
      .where(
        and(
          eq(agents.id, input.agentId),
          eq(agents.userId, input.userId),
          isNull(agents.runnerId),
          isNull(agents.deletedAt),
        ),
      )
      .returning({ runnerId: agents.runnerId });

    return assigned?.runnerId
      ? { ok: true, runnerId: assigned.runnerId }
      : { ok: false, reason: "agent_not_found" };
  });
}
