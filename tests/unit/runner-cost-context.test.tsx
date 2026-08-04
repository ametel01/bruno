import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { RunnerCostContext } from "@/app/_components/runner-cost-context";
import { AssignedRunnerPanel } from "@/app/agents/_components/assigned-runner-panel";
import type { CostEstimate, RunnerCostEstimateDto } from "@/src/server/costs/cost-estimates";
import type { CloudRunnerProvisioningSummary } from "@/src/server/runners/cloud-runner-provisioning";
import type { AssignedManualRunnerStatusSummary } from "@/src/server/runners/manual-runner-status";

const RUNNER_ID = "00000000-0000-4000-8000-000000000226";

describe("runner cost context", () => {
  it("renders labeled estimates and active-agent allocation without exposing runner identifiers", () => {
    const html = renderToStaticMarkup(
      createElement(RunnerCostContext, {
        result: { ok: true, estimate: pricedEstimate() },
      }),
    );

    expect(html).toContain("Estimated monthly runner cost");
    expect(html).toContain("$6.00 estimated");
    expect(html).toContain("Estimated 30-day infrastructure cost");
    expect(html).toContain("$3.00 estimated");
    expect(html).toContain("Estimated 30-day cost per active agent");
    expect(html).toContain("$1.50 estimated");
    expect(html).toContain("Running now");
    expect(html).toContain(">1<");
    expect(html).toContain("Active in window");
    expect(html).toContain(">2<");
    expect(html).toContain(
      "A plan can cost more because it may also include orchestration, monitoring, backups, support, and margin.",
    );
    expect(html).not.toContain(RUNNER_ID);
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("registrationToken");
  });

  it.each([
    [
      "manual runner",
      "manual_vps",
      unavailable("manual_runner", "Manual runner pricing is unavailable."),
    ],
    [
      "unknown cloud size",
      "digitalocean",
      unavailable("unsupported_size", "No supported price is known for this runner size."),
    ],
  ])("renders %s estimates as unavailable, never zero", (_label, runnerKind, cost) => {
    const estimate = pricedEstimate({
      runnerKind,
      runnerMonthlyCost: cost,
      estimatedInfrastructureCost: cost,
      estimatedInfrastructureCostPerAgent: cost,
    });
    const html = renderToStaticMarkup(
      createElement(RunnerCostContext, { result: { ok: true, estimate } }),
    );

    expect(html).toContain("Unavailable");
    expect(html).toContain(cost.explanation);
    expect(html).not.toContain("$0");
    expect(html).not.toContain("0.00");
  });

  it("keeps health and capacity usable when the independent cost load fails", () => {
    const html = renderToStaticMarkup(
      createElement(AssignedRunnerPanel, {
        result: { ok: true, runner: assignedRunner() },
        costResult: { ok: false },
      }),
    );

    expect(html).toContain("online");
    expect(html).toContain("2 / 5 agents running");
    expect(html).toContain("37%");
    expect(html).toContain("512 / 2,048 MB");
    expect(html).toContain("No runner capacity blocker");
    expect(html).toContain("Cost estimate could not be loaded");
    expect(html).toContain("Health and capacity remain available above.");
    expect(html).not.toContain(RUNNER_ID);
    expect(html).not.toContain("token=stored-for-downstream");
  });

  it("keeps runner evidence closed and suppresses its alert during automatic recovery", () => {
    const runner = {
      ...assignedRunner(),
      status: "degraded" as const,
      alertState: "degraded" as const,
      alertMessage: "Private endpoint and source-draining detail must not appear.",
    };
    const html = renderToStaticMarkup(
      createElement(AssignedRunnerPanel, {
        result: { ok: true, runner },
        costResult: { ok: false },
        suppressAlert: true,
      }),
    );

    expect(html).toContain("<details");
    expect(html).not.toContain(" open");
    expect(html).toContain("Assigned runner details");
    expect(html).toContain("Advanced operational evidence");
    expect(html).toContain(">recovering<");
    expect(html).not.toContain("Private endpoint");
    expect(html).not.toContain("source-draining");
  });

  it("adds the estimate to an existing cloud runner card without replacing readiness details", () => {
    const runner = cloudRunner();
    const html = renderToStaticMarkup(
      createElement(CloudRunnerProvisioningPanel, {
        title: "Cloud runners",
        titleId: "cloud-runners",
        result: { ok: true, runners: [runner] },
        costResult: { ok: true, runners: [pricedEstimate()] },
      }),
    );

    expect(html).toContain("Cloud Runner 226");
    expect(html).toContain("Runner heartbeat is online and ready for work.");
    expect(html).toContain("s-1vcpu-1gb");
    expect(html).toContain("Latest heartbeat");
    expect(html).toContain("Estimated monthly runner cost");
    expect(html).toContain("$6.00 estimated");
    expect(html).not.toContain("token=stored-for-downstream");
  });
});

function pricedEstimate(overrides: Partial<RunnerCostEstimateDto> = {}): RunnerCostEstimateDto {
  return {
    runnerId: RUNNER_ID,
    runnerName: "Cloud Runner 226",
    runnerKind: "digitalocean",
    sizeSlug: "s-1vcpu-1gb",
    uptimeMs: 15 * 24 * 60 * 60 * 1_000,
    runningAgentCount: 1,
    windowActiveAgentCount: 2,
    runnerMonthlyCost: available(600),
    estimatedInfrastructureCost: available(300),
    estimatedInfrastructureCostPerAgent: available(150),
    ...overrides,
  };
}

function available(cents: number): CostEstimate {
  return {
    available: true,
    cents,
    currency: "USD",
    label: "Estimated raw infrastructure cost",
    explanation:
      "Raw compute estimate only; plans may also include orchestration, monitoring, backups, support, and margin.",
  };
}

function unavailable(
  reason: "manual_runner" | "unsupported_size",
  explanation: string,
): CostEstimate {
  return {
    available: false,
    reason,
    label: "Estimate unavailable",
    explanation,
  };
}

function assignedRunner(): AssignedManualRunnerStatusSummary {
  return {
    name: "Cloud Runner 226",
    kind: "digitalocean",
    endpointHost: "runner.example.com",
    status: "online",
    capacity: {
      runningAgents: 2,
      maxAgents: 5,
      cpuUsedPercent: 37,
      memoryUsedMb: 512,
      memoryTotalMb: 2048,
      diskUsedMb: null,
      diskTotalMb: null,
      blocker: null,
    },
    version: "agentbay-runner/2.2.6",
    lastSeenAt: "2026-07-10T01:00:00.000Z",
    updatedAt: "2026-07-10T01:00:00.000Z",
    provisioningStatus: "ready",
    assignmentNotice: "This agent is assigned to Cloud Runner 226.",
    alertState: null,
    alertMessage: null,
  };
}

function cloudRunner(): CloudRunnerProvisioningSummary {
  return {
    id: RUNNER_ID,
    name: "Cloud Runner 226",
    kind: "digitalocean",
    status: "active",
    readinessStatus: "online",
    provider: "digitalocean",
    providerResourceId: "do-226",
    region: "sgp1",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    latestHeartbeatAt: "2026-07-10T01:00:00.000Z",
    provisioning: {
      status: "ready",
      error: null,
      startedAt: "2026-07-10T00:00:00.000Z",
      completedAt: "2026-07-10T00:05:00.000Z",
      phases: [
        {
          name: "ready",
          status: "completed",
          startedAt: "2026-07-10T00:04:00.000Z",
          completedAt: "2026-07-10T00:05:00.000Z",
        },
      ],
    },
  };
}
