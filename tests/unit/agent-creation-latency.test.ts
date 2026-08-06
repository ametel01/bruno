import { describe, expect, it } from "vitest";
import { buildAgentCreationLatencyReport } from "@/src/server/agents/agent-creation-latency";

describe("agent creation latency report", () => {
  it("summarizes ready, failed, and nonterminal deployments with deterministic ordering", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-c",
          runnerId: null,
          createdAt: "2026-08-07T00:00:20.000Z",
          completedAt: null,
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [],
        },
        {
          id: "deployment-a",
          runnerId: "runner-a",
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:00:55.000Z",
          failedAt: null,
          agentStageEvents: [
            {
              fromStage: "pending",
              toStage: "provisioning_runner",
              createdAt: "2026-08-07T00:00:05.000Z",
            },
            {
              fromStage: "connecting_telegram",
              toStage: "ready",
              createdAt: "2026-08-07T00:00:55.000Z",
            },
          ],
          runnerEvents: [
            {
              phase: "creating",
              status: "started",
              createdAt: "2026-08-07T00:00:06.000Z",
              metadata: {
                providerResourceId: "582965909",
                token: "dop_v1_not_allowed_in_report",
              },
            },
            {
              phase: "creating",
              status: "completed",
              createdAt: "2026-08-07T00:00:16.000Z",
            },
          ],
        },
        {
          id: "deployment-b",
          runnerId: "runner-b",
          createdAt: "2026-08-07T00:00:10.000Z",
          completedAt: null,
          failedAt: "2026-08-07T00:00:50.000Z",
          agentStageEvents: [
            {
              fromStage: "pending",
              toStage: "provisioning_runner",
              createdAt: "2026-08-07T00:00:15.000Z",
            },
          ],
          runnerEvents: [],
        },
      ],
    });

    expect(report.summary).toMatchObject({
      total: 3,
      ready: 1,
      failed: 1,
      incomplete: 1,
      successRate: 1 / 3,
      readyLatency: { p50Ms: 55_000, p95Ms: 55_000, maxMs: 55_000 },
      failedTerminalLatency: { p50Ms: 40_000, p95Ms: 40_000, maxMs: 40_000 },
    });
    expect(report.runs.map((run) => run.deploymentId)).toEqual([
      "deployment-a",
      "deployment-b",
      "deployment-c",
    ]);
    expect(report.runs[0]).toMatchObject({
      outcome: "ready",
      totalDurationMs: 55_000,
      evidenceStatus: "valid",
    });
    expect(report.runs[2]).toMatchObject({
      outcome: "incomplete",
      totalDurationMs: null,
      evidenceStatus: "invalid",
      issueCounts: { unknown_terminal: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("dop_v1_not_allowed_in_report");
    expect(JSON.stringify(report)).not.toContain("providerResourceId");
  });

  it("uses nearest-rank percentiles for ready latencies", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: Array.from({ length: 20 }, (_, index) => ({
        id: `deployment-${String(index).padStart(2, "0")}`,
        runnerId: null,
        createdAt: `2026-08-07T00:00:${String(index).padStart(2, "0")}.000Z`,
        completedAt: `2026-08-07T00:01:${String(index).padStart(2, "0")}.000Z`,
        failedAt: null,
        agentStageEvents: [],
        runnerEvents: [],
      })),
    });

    expect(report.summary.readyLatency).toEqual({
      p50Ms: 60_000,
      p95Ms: 60_000,
      maxMs: 60_000,
    });
  });

  it("surfaces missing, duplicate, and reversed runner evidence instead of zero durations", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-invalid",
          runnerId: "runner-invalid",
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:01:00.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [
            {
              phase: "bootstrapping",
              status: "started",
              createdAt: "2026-08-07T00:00:20.000Z",
              metadata: { step: "docker_package_install" },
            },
            {
              phase: "bootstrapping",
              status: "started",
              createdAt: "2026-08-07T00:00:21.000Z",
              metadata: { step: "docker_package_install" },
            },
            {
              phase: "bootstrapping",
              status: "completed",
              createdAt: "2026-08-07T00:00:19.000Z",
              metadata: { step: "docker_package_install" },
            },
            {
              phase: "waiting_for_runner",
              status: "started",
              createdAt: "2026-08-07T00:00:30.000Z",
            },
          ],
        },
      ],
    });

    const bootstrapping = report.runs[0]?.stages.find(
      (stage) => stage.name === "runner:bootstrapping",
    );
    const waiting = report.runs[0]?.stages.find(
      (stage) => stage.name === "runner:waiting_for_runner",
    );
    const step = report.runs[0]?.stages.find(
      (stage) => stage.name === "bootstrap:docker_package_install",
    );

    expect(bootstrapping).toMatchObject({
      durationMs: null,
      issues: ["duplicate_started", "reversed_timestamp"],
    });
    expect(step).toMatchObject({
      durationMs: null,
      issues: ["duplicate_started", "reversed_timestamp"],
    });
    expect(waiting).toMatchObject({
      durationMs: null,
      issues: ["missing_terminal"],
    });
    expect(report.runs[0]).toMatchObject({
      evidenceStatus: "invalid",
      issueCounts: {
        duplicate_started: 2,
        reversed_timestamp: 2,
        missing_terminal: 1,
      },
    });
  });

  it("keeps ambiguous terminal timestamps invalid", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-ambiguous",
          runnerId: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:00:30.000Z",
          failedAt: "2026-08-07T00:00:45.000Z",
          agentStageEvents: [],
          runnerEvents: [],
        },
      ],
    });

    expect(report.runs[0]).toMatchObject({
      outcome: "failed",
      terminalAt: "2026-08-07T00:00:45.000Z",
      totalDurationMs: null,
      evidenceStatus: "invalid",
      issueCounts: { ambiguous_terminal: 1 },
    });
  });

  it("normalizes PostgreSQL timestamp strings before computing terminal latency", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-postgres",
          runnerId: "runner-postgres",
          createdAt: "2026-08-06 21:05:10.679+00",
          completedAt: "2026-08-06 21:06:38.908+00",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [],
        },
      ],
    });

    expect(report.summary).toMatchObject({
      total: 1,
      ready: 1,
      failed: 0,
      incomplete: 0,
      readyLatency: { p50Ms: 88_229, p95Ms: 88_229, maxMs: 88_229 },
    });
    expect(report.runs[0]).toMatchObject({
      outcome: "ready",
      createdAt: "2026-08-06T21:05:10.679Z",
      terminalAt: "2026-08-06T21:06:38.908Z",
      totalDurationMs: 88_229,
    });
  });
});
