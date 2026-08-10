import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentDeploymentApiAcceptanceSummary } from "@/src/server/agents/agent-deployment-api-acceptance";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeploymentApiAttemptEvents } from "@/src/server/db/schema";

const ATTEMPTS = [
  "00000000-0000-4000-8000-000000003101",
  "00000000-0000-4000-8000-000000003102",
  "00000000-0000-4000-8000-000000003103",
] as const;

describe("production Agent Deployment API-acceptance ledger", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client`truncate table agent_deployment_api_attempt_events restart identity cascade`;
  });

  afterEach(async () => {
    await connection.client`truncate table agent_deployment_api_attempt_events restart identity cascade`;
    await connection.close();
  });

  it("reports the failure-inclusive latest attempts separately from deployment readiness", async () => {
    const startedAt = new Date("2026-08-11T00:00:00.000Z");
    await connection.db.insert(agentDeploymentApiAttemptEvents).values(
      ATTEMPTS.map((attemptId, index) => ({
        attemptId,
        requestKind: index === 0 ? "create_ready" : "start",
        phase: "started",
        createdAt: new Date(startedAt.getTime() + index * 1_000),
      })),
    );
    await connection.db.insert(agentDeploymentApiAttemptEvents).values([
      {
        attemptId: ATTEMPTS[0],
        requestKind: "create_ready",
        phase: "accepted",
        createdAt: new Date(startedAt.getTime() + 3_000),
      },
      {
        attemptId: ATTEMPTS[1],
        requestKind: "start",
        phase: "rejected",
        safeCode: "request_validation_failed",
        createdAt: new Date(startedAt.getTime() + 4_000),
      },
    ]);

    await expect(
      buildAgentDeploymentApiAcceptanceSummary(connection, {
        generatedAt: new Date(startedAt.getTime() + 5_000),
      }),
    ).resolves.toEqual({
      sampleSize: 3,
      accepted: 1,
      rejected: 1,
      outcomeUnknown: 0,
      pending: 1,
      availability: 1 / 3,
    });
    await expect(
      connection.client`update agent_deployment_api_attempt_events set phase = 'accepted' where attempt_id = ${ATTEMPTS[1]}::uuid`,
    ).rejects.toThrow("append-only");
    await expect(
      connection.db.insert(agentDeploymentApiAttemptEvents).values({
        attemptId: ATTEMPTS[0],
        requestKind: "create_ready",
        phase: "rejected",
        safeCode: "request_failed",
      }),
    ).rejects.toThrow();
    expect(
      JSON.stringify(await connection.db.select().from(agentDeploymentApiAttemptEvents)),
    ).not.toMatch(/user|owner|token|credential|telegram/i);
  });

  it("rejects terminal evidence without a matching started event", async () => {
    await expect(
      connection.db.insert(agentDeploymentApiAttemptEvents).values({
        attemptId: ATTEMPTS[0],
        requestKind: "create_ready",
        phase: "accepted",
      }),
    ).rejects.toThrow();
  });

  it("rejects terminal evidence whose request kind differs from its start", async () => {
    await connection.db.insert(agentDeploymentApiAttemptEvents).values({
      attemptId: ATTEMPTS[0],
      requestKind: "create_ready",
      phase: "started",
    });
    await expect(
      connection.db.insert(agentDeploymentApiAttemptEvents).values({
        attemptId: ATTEMPTS[0],
        requestKind: "start",
        phase: "rejected",
        safeCode: "request_failed",
      }),
    ).rejects.toThrow();
  });
});
