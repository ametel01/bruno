import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildAgentDeploymentLatencyReport,
  type AgentDeploymentLatencyDeploymentEvidence,
} from "@/src/server/agents/agent-deployment-latency";
import { recordColdDeploymentSloEvaluation } from "@/src/server/agents/cold-deployment-slo-evaluation";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { coldDeploymentSloEvaluations } from "@/src/server/db/schema";
import { verifyColdDeploymentSloEvaluation } from "@/src/server/agents/cold-deployment-slo-evaluation";

describe("continuous production Cold-Deployment SLO evidence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client`truncate table cold_deployment_slo_evaluations restart identity cascade`;
  });

  afterEach(async () => {
    await connection.client`truncate table cold_deployment_slo_evaluations restart identity cascade`;
    await connection.close();
  });

  it("retains signed proof and opens an internal incident when a later latest-100 regresses", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signing = {
      keyId: "cold-slo-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    };
    const passing = buildAgentDeploymentLatencyReport({
      deployments: deployments(100, 100),
      generatedAt: new Date("2026-08-11T01:00:00.000Z"),
    });
    const first = await recordColdDeploymentSloEvaluation(connection, { report: passing, signing });
    expect(first).toMatchObject({ proven: true, incidentOpened: false, eligibleCount: 100 });

    const regressed = buildAgentDeploymentLatencyReport({
      deployments: deployments(100, 94),
      generatedAt: new Date("2026-08-11T02:00:00.000Z"),
    });
    const second = await recordColdDeploymentSloEvaluation(connection, {
      report: regressed,
      signing,
    });
    expect(second).toMatchObject({ proven: false, incidentOpened: true, readyWithinObjective: 94 });

    const rows = await connection.db.select().from(coldDeploymentSloEvaluations);
    expect(rows).toHaveLength(2);
    const firstRow = rows[0];
    if (!firstRow) throw new Error("Expected retained SLO evidence.");
    expect(rows[0]).toMatchObject({ proven: true, incidentOpened: false });
    expect(rows[1]).toMatchObject({ proven: false, incidentOpened: true });
    expect(rows.map((row) => row.reportDigest)).toEqual([
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    ]);
    expect(
      verifyColdDeploymentSloEvaluation({
        reportBytes: firstRow.reportBytes,
        reportDigest: firstRow.reportDigest,
        signature: firstRow.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
    ).toBe(true);
    await expect(
      connection.client`update cold_deployment_slo_evaluations set proven = false where id = ${firstRow.id}`,
    ).rejects.toThrow("append-only");
    expect(JSON.stringify(rows)).not.toMatch(/privateKey|credential|token/i);
  });

  it("remains unproven before 100 eligible observations", async () => {
    const keys = generateKeyPairSync("ed25519");
    const report = buildAgentDeploymentLatencyReport({
      deployments: deployments(99, 99),
      generatedAt: new Date("2026-08-11T03:00:00.000Z"),
    });
    await expect(
      recordColdDeploymentSloEvaluation(connection, {
        report,
        signing: {
          keyId: "cold-slo-current",
          privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
        },
      }),
    ).resolves.toMatchObject({ proven: false, eligibleCount: 99, incidentOpened: false });
  });

  it("rejects signed evidence whose summary disagrees with its embedded latest-100 runs", async () => {
    const keys = generateKeyPairSync("ed25519");
    const signing = {
      keyId: "cold-slo-current",
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    };
    const report = buildAgentDeploymentLatencyReport({
      deployments: deployments(100, 95),
      generatedAt: new Date("2026-08-11T04:00:00.000Z"),
    });
    await expect(
      recordColdDeploymentSloEvaluation(connection, {
        report: { ...report, slo: { ...report.slo, readyWithinObjective: 100 } },
        signing,
      }),
    ).rejects.toThrow("disagrees with its immutable runs");

    const retained = await recordColdDeploymentSloEvaluation(connection, { report, signing });
    const [row] = await connection.db.select().from(coldDeploymentSloEvaluations);
    if (!row) throw new Error("Expected retained SLO evidence.");
    const artifact = JSON.parse(row.reportBytes) as Record<string, unknown>;
    const embeddedReport = artifact.report as Record<string, unknown>;
    const embeddedSlo = embeddedReport.slo as Record<string, unknown>;
    embeddedSlo.readyWithinObjective = 100;
    const inconsistentBytes = canonicalJson(artifact);
    const digest = `sha256:${createHash("sha256").update(inconsistentBytes).digest("hex")}`;
    const signature = sign(null, Buffer.from(inconsistentBytes), signing.privateKeyPem).toString(
      "base64url",
    );
    expect(retained.proven).toBe(true);
    expect(
      verifyColdDeploymentSloEvaluation({
        reportBytes: inconsistentBytes,
        reportDigest: digest,
        signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
    ).toBe(false);
  });
});

function deployments(
  total: number,
  readyWithinObjective: number,
): AgentDeploymentLatencyDeploymentEvidence[] {
  return Array.from({ length: total }, (_, index) => {
    const acceptedAt = new Date(Date.UTC(2026, 7, 10, 0, index, 0));
    const passes = index < readyWithinObjective;
    return {
      id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      runnerId: null,
      cohort: "cold_deployment",
      origin: "owner_request",
      deploymentEnvironment: "production",
      rolloutConfigurationGeneration: index < total / 2 ? 1 : 2,
      requiresRunnerEvidence: false,
      acceptedAt,
      createdAt: acceptedAt,
      completedAt: passes ? new Date(acceptedAt.getTime() + 30_000) : null,
      failedAt: passes ? null : new Date(acceptedAt.getTime() + 45_000),
      agentStageEvents: [],
      runnerEvents: [],
    };
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
