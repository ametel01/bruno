import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  acquireAgentActionRequestLatch,
  releaseAgentActionRequestLatch,
} from "@/app/agents/_components/agent-action-request-latch";
import {
  AgentLifecycleControls,
  buildAgentLifecycleActionPlan,
} from "@/app/agents/_components/agent-lifecycle-controls";
import {
  buildDeploymentPresentation,
  type PublicAgentDeployment,
} from "@/src/shared/agent-deployment-presentation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const AGENT_ID = "00000000-0000-4000-8000-000000000801";

describe("agent lifecycle action matrix", () => {
  it("shows only Stop and Restart lifecycle actions for a ready running agent", () => {
    const html = renderControls({
      deployment: deploymentDto({
        completedAt: "2026-08-03T06:00:00.000Z",
        stage: "ready",
      }),
      desiredStatus: "running",
      status: "running",
    });

    expect(buttonLabels(html)).toContain("Stop");
    expect(buttonLabels(html)).toContain("Restart");
    expect(buttonLabels(html)).toContain("Delete");
    expect(buttonLabels(html)).not.toContain("Start");
    expect(buttonLabels(html)).not.toContain("Running");
  });

  it.each([
    "starting",
    "running",
    "restarting",
    "stopped",
  ] as const)("offers Stop setup and Delete while managed setup is active from %s", (status) => {
    const html = renderControls({
      deployment: deploymentDto(),
      desiredStatus: "running",
      status,
    });

    expect(buttonLabels(html)).toContain("Stop setup");
    expect(buttonLabels(html)).toContain("Delete");
    expect(buttonLabels(html)).not.toContain("Start");
  });

  it("does not offer an unaccepted Stop setup request from an error state", () => {
    const html = renderControls({
      deployment: deploymentDto(),
      desiredStatus: "running",
      status: "error",
    });

    expect(buttonLabels(html)).not.toContain("Stop setup");
    expect(buttonLabels(html)).toContain("Delete");
  });

  it("does not treat a terminal ready snapshot awaiting observed status as cancellable setup", () => {
    const html = renderControls({
      deployment: deploymentDto({
        completedAt: "2026-08-03T06:00:00.000Z",
        stage: "ready",
      }),
      desiredStatus: "running",
      status: "stopped",
    });

    expect(buttonLabels(html)).not.toContain("Stop setup");
    expect(buttonLabels(html)).toContain("Delete");
  });

  it("offers Retry and Stop instead of Start for failed desired-running setup", () => {
    const html = renderControls({
      agentId: "agent/id",
      deployment: deploymentDto({
        error: { code: "telegram_not_connected" },
        failedAt: "2026-08-03T06:00:00.000Z",
        stage: "failed",
      }),
      desiredStatus: "running",
      status: "error",
    });

    expect(html).toContain('href="/agents/agent%2Fid"');
    expect(html).toContain(">Retry</a>");
    expect(buttonLabels(html)).toContain("Stop");
    expect(buttonLabels(html)).not.toContain("Start");
    expect(buttonLabels(html)).toContain("Delete");
  });

  it("uses Start for manual agents and Resume for intentionally stopped managed agents", () => {
    const manual = renderControls({
      deployment: null,
      desiredStatus: "stopped",
      status: "stopped",
    });
    const managedStopped = renderControls({
      deployment: deploymentDto({
        completedAt: "2026-08-03T06:00:00.000Z",
        stage: "ready",
      }),
      desiredStatus: "stopped",
      status: "stopped",
    });

    expect(buttonLabels(manual)).toContain("Start");
    expect(buttonLabels(managedStopped)).toContain("Resume");
    expect(buttonLabels(managedStopped)).not.toContain("Restart");
  });

  it("fails closed for unavailable and deleting lifecycle states", () => {
    const presentation = buildDeploymentPresentation({
      deployment: null,
      desiredStatus: "running",
      observedStatus: "deleting",
    });

    expect(
      buildAgentLifecycleActionPlan({
        hasDeployment: false,
        presentation,
        status: "deleting",
      }),
    ).toMatchObject({
      showDelete: false,
      showRestart: false,
      showRetryDetail: false,
      showStart: false,
      showStop: false,
      showStopSetup: false,
    });
  });
});

describe("agent lifecycle request latches", () => {
  it("rejects a same-tick duplicate until the current request releases", () => {
    const latch = { current: false };

    expect(acquireAgentActionRequestLatch(latch)).toBe(true);
    expect(acquireAgentActionRequestLatch(latch)).toBe(false);
    expect(latch.current).toBe(true);

    releaseAgentActionRequestLatch(latch);

    expect(acquireAgentActionRequestLatch(latch)).toBe(true);
  });

  it.each([
    "start-agent-button.tsx",
    "stop-agent-button.tsx",
    "delete-agent-button.tsx",
    "restart-agent-button.tsx",
  ])("acquires the synchronous latch before the first fetch in %s", (fileName) => {
    const source = readFileSync(
      new URL(`../../app/agents/_components/${fileName}`, import.meta.url),
      "utf8",
    );

    expect(source.indexOf("acquireAgentActionRequestLatch(requestLatchRef)")).toBeGreaterThan(-1);
    expect(source.indexOf("acquireAgentActionRequestLatch(requestLatchRef)")).toBeLessThan(
      source.indexOf("await fetch("),
    );
    expect(source).toContain("encodeURIComponent(agentId)");
    expect(source).toContain('credentials: "same-origin"');
  });

  it("does not announce a successful Stop before requesting an authoritative refresh", () => {
    const source = readFileSync(
      new URL("../../app/agents/_components/stop-agent-button.tsx", import.meta.url),
      "utf8",
    );
    const refreshingState = source.indexOf('setState({ status: "refreshing" });');
    const refresh = source.indexOf("router.refresh();", refreshingState);

    expect(refreshingState).toBeGreaterThan(-1);
    expect(refresh).toBeGreaterThan(refreshingState);
    expect(source).not.toContain("Stop requested.");
    expect(source).not.toContain("Agent stopped.");
  });
});

function renderControls(input: {
  agentId?: string;
  deployment: PublicAgentDeployment | null;
  desiredStatus: "running" | "stopped";
  status: "idle" | "starting" | "running" | "stopped" | "restarting" | "error" | "deleting";
}): string {
  return renderToStaticMarkup(
    createElement(AgentLifecycleControls, {
      agentId: input.agentId ?? AGENT_ID,
      deployment: input.deployment,
      desiredStatus: input.desiredStatus,
      status: input.status,
    }),
  );
}

function buttonLabels(html: string): string[] {
  return Array.from(html.matchAll(/<button[^>]*>([^<]+)<\/button>/g), (match) => match[1] ?? "");
}

function deploymentDto(
  overrides: Partial<
    Pick<PublicAgentDeployment, "stage" | "error" | "completedAt" | "failedAt">
  > = {},
): PublicAgentDeployment {
  return {
    id: "00000000-0000-4000-8000-000000000802",
    agentId: AGENT_ID,
    stage: "pending",
    configRevision: "cfg-1784000000000",
    attemptCount: 0,
    error: null,
    nextAttemptAt: null,
    recovery: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: "2026-08-03T05:00:00.000Z",
    updatedAt: "2026-08-03T05:00:00.000Z",
    ...overrides,
  };
}
