import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderProductContractScenarioExecutions,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";
import { createFounderProductContractScenarioLedger } from "@/src/testing/founder-product-contract/ledger";
import type { FounderProductContractScenarioResult } from "@/src/testing/founder-product-contract/types";
import type { FounderLifecycleOutcome } from "./lifecycle";

type ScenarioExecutionIdentity = {
  runId: string;
  userId: string;
  sourceRevision: string;
  runtimeRevision: string;
  scenarioId: FounderLifecycleOutcome["action"];
  observedAt: Date;
  createConnection?: () => DatabaseConnection;
};

export async function claimFounderProductContractScenarioExecution(
  input: ScenarioExecutionIdentity,
): Promise<void> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const [claim] = await connection.db
      .insert(founderProductContractScenarioExecutions)
      .values({
        runId: input.runId,
        userId: input.userId,
        scenarioId: input.scenarioId,
        sourceRevision: input.sourceRevision,
        runtimeRevision: input.runtimeRevision,
        status: "in_progress",
        attempts: 1,
        resourcesBefore: 0,
        resourcesAfter: 0,
        cleanupVerified: false,
        observedAt: input.observedAt,
        createdAt: input.observedAt,
        updatedAt: input.observedAt,
      })
      .onConflictDoUpdate({
        target: [
          founderProductContractScenarioExecutions.runId,
          founderProductContractScenarioExecutions.userId,
          founderProductContractScenarioExecutions.scenarioId,
        ],
        set: {
          status: "failed",
          attempts: sql`${founderProductContractScenarioExecutions.attempts} + 1`,
          cleanupVerified: false,
          updatedAt: input.observedAt,
        },
      })
      .returning({ attempts: founderProductContractScenarioExecutions.attempts });
    if (claim?.attempts !== 1) {
      throw new Error("Founder Product Contract scenario execution was retried.");
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function completeFounderProductContractScenarioExecution(input: {
  identity: ScenarioExecutionIdentity;
  outcome: FounderLifecycleOutcome;
}): Promise<void> {
  const connection = input.identity.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.identity.createConnection;
  const observedAt = new Date(input.outcome.cleanup.observedAt);
  try {
    const [completed] = await connection.db
      .update(founderProductContractScenarioExecutions)
      .set({
        status: "passed",
        resourcesBefore: input.outcome.cleanup.resourcesBefore,
        resourcesAfter: input.outcome.cleanup.resourcesAfter,
        cleanupVerified: input.outcome.cleanup.verified,
        observedAt,
        updatedAt: observedAt,
      })
      .where(
        and(
          eq(founderProductContractScenarioExecutions.runId, input.identity.runId),
          eq(founderProductContractScenarioExecutions.userId, input.identity.userId),
          eq(founderProductContractScenarioExecutions.scenarioId, input.identity.scenarioId),
          eq(
            founderProductContractScenarioExecutions.sourceRevision,
            input.identity.sourceRevision,
          ),
          eq(
            founderProductContractScenarioExecutions.runtimeRevision,
            input.identity.runtimeRevision,
          ),
          eq(founderProductContractScenarioExecutions.status, "in_progress"),
          eq(founderProductContractScenarioExecutions.attempts, 1),
        ),
      )
      .returning({ id: founderProductContractScenarioExecutions.id });
    if (!completed) throw new Error("Founder Product Contract scenario claim was not finalizable.");
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function failFounderProductContractScenarioExecution(
  input: ScenarioExecutionIdentity,
): Promise<void> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    await connection.db
      .update(founderProductContractScenarioExecutions)
      .set({ status: "failed", cleanupVerified: false, updatedAt: input.observedAt })
      .where(
        and(
          eq(founderProductContractScenarioExecutions.runId, input.runId),
          eq(founderProductContractScenarioExecutions.userId, input.userId),
          eq(founderProductContractScenarioExecutions.scenarioId, input.scenarioId),
          eq(founderProductContractScenarioExecutions.sourceRevision, input.sourceRevision),
          eq(founderProductContractScenarioExecutions.runtimeRevision, input.runtimeRevision),
        ),
      );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function issueFounderProductContractScenarioLedger(input: {
  runId: string;
  userId: string;
  sourceRevision: string;
  runtimeRevision: string;
  observedAt: string;
  signingSecret: string;
  createConnection?: () => DatabaseConnection;
}) {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const runtimeRows = await connection.db
      .select({ runtimeRevision: operatorRuntimes.configRevision })
      .from(operatorRuntimes)
      .innerJoin(operators, eq(operators.id, operatorRuntimes.operatorId))
      .where(eq(operators.userId, input.userId));
    const exercisedRuntimeRevisions = new Set(
      runtimeRows.map(({ runtimeRevision }) => runtimeRevision),
    );
    if (
      exercisedRuntimeRevisions.size !== 1 ||
      !exercisedRuntimeRevisions.has(input.runtimeRevision)
    ) {
      throw new Error("The persisted lifecycle runtime revision does not match the candidate.");
    }
    const rows = await connection.db
      .select()
      .from(founderProductContractScenarioExecutions)
      .where(eq(founderProductContractScenarioExecutions.runId, input.runId));
    if (
      rows.some(
        (row) =>
          row.sourceRevision !== input.sourceRevision ||
          row.runtimeRevision !== input.runtimeRevision ||
          row.userId !== input.userId ||
          row.status !== "passed" ||
          row.attempts !== 1 ||
          !row.cleanupVerified,
      )
    ) {
      throw new Error("The exact candidate contains a failed lifecycle scenario.");
    }
    const byScenario = new Map(rows.map((row) => [row.scenarioId, row]));
    const results: FounderProductContractScenarioResult[] =
      FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((scenarioId) => {
        const row = byScenario.get(scenarioId);
        if (!row) throw new Error(`Persisted lifecycle scenario ${scenarioId} is missing.`);
        if (row.status !== "passed" || row.attempts !== 1 || !row.cleanupVerified) {
          throw new Error(
            `Persisted lifecycle scenario ${scenarioId} did not execute exactly once.`,
          );
        }
        return {
          id: scenarioId,
          status: row.status === "passed" ? "passed" : "failed",
          attempts: row.attempts,
          sourceRevision: row.sourceRevision,
          runtimeRevision: row.runtimeRevision,
          observedAt: row.observedAt.toISOString(),
          cleanup: {
            status: row.status === "passed" ? "passed" : "failed",
            verified: row.cleanupVerified,
            resourcesBefore: row.resourcesBefore,
            resourcesAfter: row.resourcesAfter,
            observedAt: row.observedAt.toISOString(),
          },
        };
      });
    return createFounderProductContractScenarioLedger({
      sourceRevision: input.sourceRevision,
      runtimeRevision: input.runtimeRevision,
      runId: input.runId,
      observedAt: input.observedAt,
      results,
      signingSecret: input.signingSecret,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}
