import { describe, expect, it } from "vitest";
import {
  buildAgentCreationLatencyReport,
  buildAgentCreationLatencyReportForDatabase,
  resolveAgentCreationRunnerCorrelation,
} from "@/src/server/agents/agent-creation-latency";
import { createDatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agents,
  runnerProvisioningEvents,
  runners,
  users,
} from "@/src/server/db/schema";

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
      evidenceStatus: "invalid",
    });
    expect(report.runs[0]?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "agent:pending", durationMs: 5_000 }),
        expect.objectContaining({ name: "agent:connecting_telegram", durationMs: 50_000 }),
        expect.objectContaining({ name: "runner:creating", durationMs: 10_000 }),
        expect.objectContaining({
          name: "bootstrap:runner_container_start",
          issues: ["missing_started", "missing_terminal"],
        }),
      ]),
    );
    expect(report.runs[2]).toMatchObject({
      outcome: "incomplete",
      totalDurationMs: null,
      evidenceStatus: "invalid",
      issueCounts: { unknown_terminal: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("dop_v1_not_allowed_in_report");
    expect(JSON.stringify(report)).not.toContain("providerResourceId");
  });

  it("reports cold and existing-runner latency cohorts separately", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "cold-slow",
          runnerId: "runner-cold",
          cohort: "cold_droplet",
          requiresRunnerEvidence: true,
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:02:00.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [],
        },
        {
          id: "reuse-fast",
          runnerId: "runner-reuse",
          cohort: "existing_same_user_runner",
          createdAt: "2026-08-07T00:00:10.000Z",
          completedAt: "2026-08-07T00:00:25.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [],
        },
      ],
    });

    expect(report.cohorts.cold_droplet).toMatchObject({
      total: 1,
      ready: 1,
      readyLatency: { p50Ms: 120_000, p95Ms: 120_000, maxMs: 120_000 },
    });
    expect(report.cohorts.existing_same_user_runner).toMatchObject({
      total: 1,
      ready: 1,
      readyLatency: { p50Ms: 15_000, p95Ms: 15_000, maxMs: 15_000 },
    });
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
      issues: ["missing_started", "missing_terminal"],
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
    });
    expect(report.runs[0]?.issueCounts.duplicate_started).toBe(1);
    expect(report.runs[0]?.issueCounts.reversed_timestamp).toBe(1);
    expect(report.runs[0]?.issueCounts.missing_terminal).toBeGreaterThanOrEqual(1);
  });

  it("surfaces entirely absent required runner and bootstrap stages as missing evidence", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-missing-runner-evidence",
          runnerId: "runner-missing",
          cohort: "cold_droplet",
          requiresRunnerEvidence: true,
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:01:00.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [],
        },
      ],
    });

    expect(report.runs[0]).toMatchObject({
      evidenceStatus: "invalid",
      totalDurationMs: 60_000,
    });
    expect(report.runs[0]?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "runner:creating",
          status: "invalid",
          issues: ["missing_started", "missing_terminal"],
        }),
        expect.objectContaining({
          name: "runner:ready",
          status: "invalid",
          issues: ["missing_started", "missing_terminal"],
        }),
        expect.objectContaining({
          name: "bootstrap:package_install",
          status: "invalid",
          issues: ["missing_started", "missing_terminal"],
        }),
        expect.objectContaining({
          name: "bootstrap:authenticated_readiness",
          status: "invalid",
          issues: ["missing_started", "missing_terminal"],
        }),
      ]),
    );
  });

  it("rejects zero-duration runner evidence as synthetic invalid timing", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-zero-runner-evidence",
          runnerId: "runner-zero",
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:01:00.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [
            event("creating", "started", "2026-08-07T00:00:10.000Z"),
            event("creating", "completed", "2026-08-07T00:00:10.000Z"),
          ],
        },
      ],
    });

    const creating = report.runs[0]?.stages.find((stage) => stage.name === "runner:creating");

    expect(creating).toMatchObject({
      status: "invalid",
      durationMs: null,
      issues: ["non_positive_duration"],
    });
    expect(report.runs[0]).toMatchObject({
      evidenceStatus: "invalid",
    });
    expect(report.runs[0]?.issueCounts.non_positive_duration).toBe(1);
  });

  it("accepts the integrated production runner/bootstrap event sequence without duplicate or zero-duration synthetic evidence", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-complete-runner-evidence",
          runnerId: "runner-complete",
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:01:20.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [
            event("creating", "started", "2026-08-07T00:00:01.000Z"),
            event("creating", "completed", "2026-08-07T00:00:05.000Z"),
            event("tagging", "started", "2026-08-07T00:00:05.000Z"),
            event("tagging", "completed", "2026-08-07T00:00:07.000Z"),
            event("firewall_configuring", "started", "2026-08-07T00:00:07.000Z"),
            event("firewall_configuring", "completed", "2026-08-07T00:00:10.000Z"),
            event("bootstrapping", "started", "2026-08-07T00:00:10.000Z"),
            event("bootstrapping", "started", "2026-08-07T00:00:12.000Z", {
              step: "bootstrap_started",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:13.000Z", {
              step: "package_install",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:20.000Z", {
              step: "package_install",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:20.500Z", {
              step: "caddy_configured",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:20.750Z", {
              step: "hermes_state_root",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:21.000Z", {
              step: "docker_pull",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:27.000Z", {
              step: "docker_pull",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:28.000Z", {
              step: "agent_image_pull",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:33.000Z", {
              step: "agent_image_pull",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:34.000Z", {
              step: "hermes_image_pull",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:40.000Z", {
              step: "hermes_image_pull",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:41.000Z", {
              step: "runner_container_start",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:00:45.000Z", {
              step: "runner_container_start",
            }),
            event("waiting_for_runner", "started", "2026-08-07T00:00:45.000Z", {
              step: "runner_registration",
            }),
            event("waiting_for_runner", "started", "2026-08-07T00:00:46.000Z"),
            event("bootstrapping", "completed", "2026-08-07T00:00:55.000Z"),
            event("bootstrapping", "completed", "2026-08-07T00:00:55.000Z", {
              step: "bootstrap_started",
            }),
            event("waiting_for_runner", "completed", "2026-08-07T00:00:55.000Z"),
            event("waiting_for_runner", "completed", "2026-08-07T00:00:55.000Z", {
              step: "runner_registration",
            }),
            event("bootstrapping", "started", "2026-08-07T00:00:50.000Z", {
              step: "boot_validation",
            }),
            event("bootstrapping", "completed", "2026-08-07T00:01:05.000Z", {
              step: "boot_validation",
            }),
            event("ready", "started", "2026-08-07T00:01:06.000Z"),
            event("ready", "started", "2026-08-07T00:01:06.000Z", {
              step: "authenticated_readiness",
            }),
            event("ready", "completed", "2026-08-07T00:01:09.000Z"),
            event("ready", "completed", "2026-08-07T00:01:09.000Z", {
              step: "authenticated_readiness",
            }),
          ],
        },
      ],
    });
    const run = report.runs[0];

    expect(run).toMatchObject({
      outcome: "ready",
      evidenceStatus: "valid",
      issueCounts: {},
    });
    expect(run?.stages).toEqual(
      expect.arrayContaining([
        completeStage("runner:creating", 4_000),
        completeStage("runner:tagging", 2_000),
        completeStage("runner:firewall_configuring", 3_000),
        completeStage("runner:bootstrapping", 45_000),
        completeStage("runner:waiting_for_runner", 9_000),
        completeStage("runner:ready", 3_000),
        completeStage("bootstrap:bootstrap_started", 43_000),
        completeStage("bootstrap:package_install", 7_000),
        completeStage("bootstrap:docker_pull", 6_000),
        completeStage("bootstrap:agent_image_pull", 5_000),
        completeStage("bootstrap:hermes_image_pull", 6_000),
        completeStage("bootstrap:runner_container_start", 4_000),
        completeStage("bootstrap:runner_registration", 10_000),
        completeStage("bootstrap:boot_validation", 15_000),
        completeStage("bootstrap:authenticated_readiness", 3_000),
      ]),
    );
    expect(
      run?.stages.filter((stage) => stage.source === "runner_provisioning_event"),
    ).toHaveLength(15);
    expect(
      run?.stages
        .filter((stage) => stage.source === "runner_provisioning_event")
        .every((stage) => stage.issues.length === 0 && (stage.durationMs ?? 0) > 0),
    ).toBe(true);
  });

  it("ignores hostile bootstrap step labels without projecting them into runner evidence", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-hostile-runner",
          runnerId: "runner-hostile",
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:00:10.000Z",
          failedAt: null,
          agentStageEvents: [],
          runnerEvents: [
            {
              phase: "bootstrapping",
              status: "started",
              createdAt: "not-a-date",
              metadata: {
                step: "dop_v1_secret_endpoint_https_example_com",
                detail: "https://runner-secret.example.com/dop_v1_secret",
              },
            },
            {
              phase: "bootstrapping",
              status: "completed",
              createdAt: "2026-08-07T00:00:05.000Z",
              metadata: {
                step: "dop_v1_secret_endpoint_https_example_com",
              },
            },
          ],
        },
      ],
    });
    const serialized = JSON.stringify(report);

    expect(report.runs[0]?.stages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bootstrap:unrecognized_step",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          issues: expect.arrayContaining(["invalid_timestamp", "missing_terminal"]),
        }),
      ]),
    );
    expect(report.runs[0]).toMatchObject({
      evidenceStatus: "invalid",
    });
    expect(report.runs[0]?.issueCounts.invalid_timestamp).toBe(1);
    expect(report.runs[0]?.issueCounts.missing_started).toBeGreaterThanOrEqual(1);
    expect(report.runs[0]?.issueCounts.missing_terminal).toBeGreaterThanOrEqual(1);
    expect(serialized).toContain("bootstrap:unrecognized_step");
    expect(serialized).toContain("invalid_timestamp");
    expect(serialized).not.toContain("dop_v1_secret");
    expect(serialized).not.toContain("https_example_com");
    expect(serialized).not.toContain("runner-secret.example.com");
    expect(serialized).not.toContain("bootstrap:dop");
  });

  it("surfaces invalid agent-stage timestamps instead of dropping the stage", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-invalid-agent-stage",
          runnerId: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:00:10.000Z",
          failedAt: null,
          agentStageEvents: [
            {
              fromStage: "pending",
              toStage: "configuring_hermes",
              createdAt: "not-a-date",
            },
          ],
          runnerEvents: [],
        },
      ],
    });

    expect(report.runs[0]?.stages).toEqual([
      expect.objectContaining({
        name: "agent:pending",
        startedAt: "2026-08-07T00:00:00.000Z",
        completedAt: null,
        durationMs: null,
        issues: ["invalid_timestamp"],
      }),
    ]);
    expect(report.runs[0]).toMatchObject({
      evidenceStatus: "invalid",
      issueCounts: { invalid_timestamp: 1 },
    });
  });

  it("attributes agent-stage intervals to the stage being exited", () => {
    const report = buildAgentCreationLatencyReport({
      generatedAt: "2026-08-07T00:00:00.000Z",
      deployments: [
        {
          id: "deployment-agent-stages",
          runnerId: null,
          createdAt: "2026-08-07T00:00:00.000Z",
          completedAt: "2026-08-07T00:00:50.000Z",
          failedAt: null,
          agentStageEvents: [
            {
              fromStage: "pending",
              toStage: "provisioning_runner",
              createdAt: "2026-08-07T00:00:05.000Z",
            },
            {
              fromStage: "provisioning_runner",
              toStage: "connecting_telegram",
              createdAt: "2026-08-07T00:00:35.000Z",
            },
            {
              fromStage: "connecting_telegram",
              toStage: "ready",
              createdAt: "2026-08-07T00:00:50.000Z",
            },
          ],
          runnerEvents: [],
        },
      ],
    });

    expect(report.runs[0]?.stages).toEqual([
      expect.objectContaining({ name: "agent:connecting_telegram", durationMs: 15_000 }),
      expect.objectContaining({ name: "agent:pending", durationMs: 5_000 }),
      expect.objectContaining({ name: "agent:provisioning_runner", durationMs: 30_000 }),
    ]);
    expect(report.runs[0]?.stages.some((stage) => stage.name === "agent:ready")).toBe(false);
  });

  it("classifies cold and reuse runner correlations without falling back to historical events", () => {
    expect(
      resolveAgentCreationRunnerCorrelation({
        runnerOperationId: "00000000-0000-4000-8000-000000000263",
        operationRunnerId: "00000000-0000-4000-8000-000000000998",
        assignedRunnerId: "00000000-0000-4000-8000-000000000999",
      }),
    ).toEqual({
      reportRunnerId: "00000000-0000-4000-8000-000000000998",
      eventRunnerId: "00000000-0000-4000-8000-000000000998",
      eventRunnerOperationId: "00000000-0000-4000-8000-000000000263",
      cohort: "cold_droplet",
      mode: "operation_key",
    });

    expect(
      resolveAgentCreationRunnerCorrelation({
        runnerOperationId: "00000000-0000-4000-8000-000000000263",
        operationRunnerId: null,
        assignedRunnerId: "00000000-0000-4000-8000-000000000999",
      }),
    ).toEqual({
      reportRunnerId: "00000000-0000-4000-8000-000000000999",
      eventRunnerId: null,
      eventRunnerOperationId: null,
      cohort: "existing_same_user_runner",
      mode: "assigned_runner_reuse",
    });

    expect(
      resolveAgentCreationRunnerCorrelation({
        runnerOperationId: null,
        operationRunnerId: null,
        assignedRunnerId: "00000000-0000-4000-8000-000000000999",
      }),
    ).toEqual({
      reportRunnerId: "00000000-0000-4000-8000-000000000999",
      eventRunnerId: null,
      eventRunnerOperationId: null,
      cohort: "existing_same_user_runner",
      mode: "assigned_runner_reuse",
    });
  });

  it("does not attribute same-owner historical runner events when an operation key is authoritative", async () => {
    const connection = createDatabaseConnection();
    try {
      await resetLatencyFixtureTables(connection);
      const now = new Date("2026-08-07T00:00:00.000Z");
      const runnerOperationId = "00000000-0000-4000-8000-000000000263";
      const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

      if (!user) throw new Error("Expected user fixture.");

      const [historicalRunner] = await connection.db
        .insert(runners)
        .values({
          userId: user.id,
          name: "Assigned Historical Runner",
          kind: "digitalocean",
          status: "online",
          provider: "digitalocean",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          provisioningStatus: "ready",
          provisioningStartedAt: now,
          provisioningCompletedAt: new Date("2026-08-07T00:00:10.000Z"),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: runners.id });

      if (!historicalRunner) throw new Error("Expected runner fixture.");

      const [agent] = await connection.db
        .insert(agents)
        .values({
          userId: user.id,
          runnerId: historicalRunner.id,
          name: "Agent",
          templateKey: "research_agent",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: agents.id });

      if (!agent) throw new Error("Expected agent fixture.");

      const [deployment] = await connection.db
        .insert(agentDeployments)
        .values({
          agentId: agent.id,
          userId: user.id,
          stage: "ready",
          configRevision: "cfg-issue-263",
          idempotencyKey: "issue-263-operation-authority",
          runnerOperationId,
          runnerAcceptedAt: new Date("2026-08-07T00:00:03.000Z"),
          canaryState: "skipped",
          completedAt: new Date("2026-08-07T00:00:30.000Z"),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: agentDeployments.id });

      if (!deployment) throw new Error("Expected deployment fixture.");

      await connection.db.insert(runnerProvisioningEvents).values([
        {
          runnerId: historicalRunner.id,
          phase: "creating",
          status: "started",
          message: "Historical creation started.",
          createdAt: new Date("2026-08-07T00:00:01.000Z"),
        },
        {
          runnerId: historicalRunner.id,
          phase: "creating",
          status: "completed",
          message: "Historical creation completed.",
          createdAt: new Date("2026-08-07T00:00:02.000Z"),
        },
      ]);

      const report = await buildAgentCreationLatencyReportForDatabase(connection, {
        deploymentId: deployment.id,
        generatedAt: new Date("2026-08-07T00:01:00.000Z"),
      });
      const run = report.runs[0];
      const creating = run?.stages.find((stage) => stage.name === "runner:creating");

      expect(run).toMatchObject({
        deploymentId: deployment.id,
        runnerId: historicalRunner.id,
        cohort: "existing_same_user_runner",
        evidenceStatus: "valid",
        totalDurationMs: 30_000,
      });
      expect(creating).toBeUndefined();
      expect(report.cohorts.existing_same_user_runner.readyLatency).toEqual({
        p50Ms: 30_000,
        p95Ms: 30_000,
        maxMs: 30_000,
      });
      expect(report.cohorts.cold_droplet.readyLatency).toEqual({
        p50Ms: null,
        p95Ms: null,
        maxMs: null,
      });
      expect(JSON.stringify(report)).not.toContain("Historical creation completed.");
    } finally {
      await resetLatencyFixtureTables(connection);
      await connection.close();
    }
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

async function resetLatencyFixtureTables(
  connection: ReturnType<typeof createDatabaseConnection>,
): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, agent_deployments, agents, runner_credentials, runner_heartbeats, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}

function event(
  phase: string,
  status: "started" | "completed" | "failed",
  createdAt: string,
  metadata?: Record<string, unknown>,
) {
  return {
    phase,
    status,
    createdAt,
    ...(metadata ? { metadata } : {}),
  };
}

function completeStage(name: string, durationMs: number) {
  return expect.objectContaining({
    name,
    status: "complete",
    durationMs,
    issues: [],
  });
}
