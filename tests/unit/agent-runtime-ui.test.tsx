import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { AgentRuntimeStatus } from "@/app/agents/_components/agent-runtime-status";
import { DeploymentStatusLabel } from "@/app/agents/_components/deployment-status-label";
import type { PublicAgentDeployment } from "@/src/shared/agent-deployment-presentation";
import type { PublicAgentRuntimePresentation } from "@/src/shared/agent-runtime-presentation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const AGENT_ID = "00000000-0000-4000-8000-000000009201";

describe("Step 9 runtime status UI", () => {
  it.each([
    ["healthy", ["Stop", "Restart", "Delete"], ["Start", "Resume"]],
    ["recovering", ["Stop", "Delete"], ["Start", "Restart", "Resume"]],
    ["stopping", ["Delete"], ["Start", "Stop", "Restart", "Resume"]],
    ["intentionally_stopped", ["Resume", "Delete"], ["Start", "Stop", "Restart"]],
    ["attention_required", ["Restart", "Stop", "Delete"], ["Start", "Resume"]],
    ["unavailable", ["Stop", "Delete"], ["Start", "Restart", "Resume"]],
  ] as const)("renders the %s lifecycle matrix", (kind, present, absent) => {
    const html = renderToStaticMarkup(
      createElement(AgentLifecycleControls, {
        agentId: AGENT_ID,
        deployment: readyDeployment(),
        desiredStatus: kind === "intentionally_stopped" ? "stopped" : "running",
        runtime: runtime(kind),
        status:
          kind === "healthy"
            ? "running"
            : kind === "attention_required" || kind === "unavailable"
              ? "error"
              : kind === "intentionally_stopped"
                ? "running"
                : "restarting",
      }),
    );

    for (const label of present) {
      expect(html).toMatch(new RegExp(`>${label}<`));
    }
    for (const label of absent) {
      expect(html).not.toMatch(new RegExp(`>${label}<`));
    }
  });

  it("overrides historical ready on compact and detail surfaces with safe runtime copy", () => {
    const attention = runtime("attention_required");
    const compact = renderToStaticMarkup(
      createElement(DeploymentStatusLabel, {
        deployment: readyDeployment(),
        desiredStatus: "running",
        observedStatus: "running",
        runtime: attention,
      }),
    );
    const detail = renderToStaticMarkup(
      createElement(AgentRuntimeStatus, { agentId: AGENT_ID, initialRuntime: attention }),
    );

    for (const html of [compact, detail]) {
      expect(html).toContain("Attention required");
      expect(html).not.toContain("runtime_recovery_exhausted");
      expect(html).not.toMatch(/generation|operationId|configRevision|restartCount/);
    }
    expect(detail).toContain("Remove it, then restart this agent.");
    expect(compact).not.toMatch(/>Ready</);
    expect(detail).toContain('aria-live="polite"');
  });

  it("keeps polling detail-only, bounded, single-flight, visibility-aware, and read-only", async () => {
    const [runtimeStatus, inventory, dashboard, mobile] = await Promise.all([
      readFile("app/agents/_components/agent-runtime-status.tsx", "utf8"),
      readFile("app/agents/page.tsx", "utf8"),
      readFile("app/dashboard/page.tsx", "utf8"),
      readFile("app/agents/_components/mobile-agent-list.tsx", "utf8"),
    ]);

    expect(runtimeStatus).toContain("new AbortController()");
    expect(runtimeStatus).toContain("requestRef.current !== null");
    expect(runtimeStatus).toContain("RUNTIME_POLL_FOREGROUND_LIMIT_MS");
    expect(runtimeStatus).toContain('document.addEventListener("visibilitychange"');
    expect(runtimeStatus).toContain('window.addEventListener("offline"');
    expect(runtimeStatus).toContain("/runtime`");
    expect(runtimeStatus).toContain('credentials: "same-origin"');
    expect(runtimeStatus).toContain('cache: "no-store"');
    expect(runtimeStatus).not.toContain('method: "POST"');
    for (const source of [inventory, dashboard, mobile]) {
      expect(source).not.toContain("AgentRuntimeStatus");
      expect(source).not.toContain("/runtime`");
    }
  });
});

function runtime(kind: PublicAgentRuntimePresentation["kind"]): PublicAgentRuntimePresentation {
  const copy = {
    healthy: ["none", "Ready", "Hermes gateway is ready."],
    recovering: ["wait", "Recovering", "The managed gateway is converging to ready."],
    stopping: ["wait", "Stopping", "The managed gateway is being stopped and verified."],
    intentionally_stopped: [
      "start",
      "Intentionally stopped",
      "This agent will remain stopped until you start it.",
    ],
    attention_required: [
      "restart",
      "Attention required",
      "Telegram has another webhook configured. Remove it, then restart this agent.",
    ],
    unavailable: ["wait", "Unavailable", "Runtime state could not be verified safely."],
  } as const;
  const [action, label, message] = copy[kind];
  return { kind, action, label, message };
}

function readyDeployment(): PublicAgentDeployment {
  return {
    id: "00000000-0000-4000-8000-000000009202",
    agentId: AGENT_ID,
    stage: "ready",
    configRevision: "deployment-history-v1",
    attemptCount: 0,
    error: null,
    nextAttemptAt: null,
    recovery: null,
    startedAt: "2026-08-03T00:00:00.000Z",
    completedAt: "2026-08-03T00:01:00.000Z",
    failedAt: null,
    createdAt: "2026-08-03T00:00:00.000Z",
    updatedAt: "2026-08-03T00:01:00.000Z",
  };
}
import { readFile } from "node:fs/promises";
