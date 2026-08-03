import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AgentDeploymentProgress } from "@/app/agents/_components/agent-deployment-progress";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { DeploymentStatusLabel } from "@/app/agents/_components/deployment-status-label";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import type {
  PublicAgentDeployment,
  PublicAgentDeploymentStage,
} from "@/src/shared/agent-deployment-presentation";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: vi.fn(),
  }),
}));

const AGENT_ID = "00000000-0000-4000-8000-000000008201";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000008202";

describe("Step 8 no-JavaScript deployment snapshots", () => {
  it.each([
    ["pending", "Preparing deployment"],
    ["provisioning_runner", "Provisioning runner"],
    ["configuring_hermes", "Configuring Hermes"],
    ["starting_gateway", "Starting gateway"],
    ["verifying_model", "Verifying model"],
    ["connecting_telegram", "Connecting Telegram"],
    ["ready", "Ready"],
    ["failed", "Setup failed"],
  ] as const)("renders the exact %s label on inventory, dashboard-card, and detail projections", (stage, label) => {
    const deployment = deploymentDto(stage);
    const observedStatus = stage === "ready" ? "running" : "stopped";
    const compactHtml = renderToStaticMarkup(
      createElement(DeploymentStatusLabel, {
        deployment,
        desiredStatus: "running",
        observedStatus,
      }),
    );
    const mobileHtml = renderToStaticMarkup(
      createElement(MobileAgentList, {
        agents: [
          {
            id: AGENT_ID,
            name: "Managed agent",
            templateKey: "research_agent",
            templateVersion: "1.0.0",
            templateLabel: "Research Agent",
            status: observedStatus,
            desiredStatus: "running",
            latestDeployment: deployment,
            href: `/agents/${AGENT_ID}`,
            createdAt: "2026-08-03T11:00:00.000Z",
          },
        ],
      }),
    );
    const detailHtml = renderToStaticMarkup(
      createElement(AgentDeploymentProgress, {
        agentId: AGENT_ID,
        desiredStatus: "running",
        initialDeployment: deployment,
        observedStatus,
      }),
    );

    for (const html of [compactHtml, mobileHtml, detailHtml]) {
      expect(html).toContain(label);
      expect(html).not.toContain("percent");
      expect(html).not.toContain("ETA");
    }
  });

  it("requires authoritative desired/deployment projection data on every list surface", async () => {
    const [uiTypes, inventory, dashboard, mobile] = await Promise.all([
      readFile("src/shared/agent-ui-types.ts", "utf8"),
      readFile("app/agents/page.tsx", "utf8"),
      readFile("app/dashboard/page.tsx", "utf8"),
      readFile("app/agents/_components/mobile-agent-list.tsx", "utf8"),
    ]);

    expect(uiTypes).toContain('desiredStatus: "stopped" | "running"');
    expect(uiTypes).toContain("latestDeployment: PublicAgentDeployment | null");
    expect(uiTypes).not.toContain("desiredStatus?:");
    expect(uiTypes).not.toContain("latestDeployment?:");
    for (const surface of [inventory, dashboard, mobile]) {
      expect(surface).not.toContain('desiredStatus ?? "stopped"');
      expect(surface).not.toContain("latestDeployment ?? null");
    }
  });

  it("renders stopped/manual-null and inconsistent/consistent ready snapshots conservatively", () => {
    const manual = statusLabelHtml(null, "stopped", "stopped");
    const intentionallyStopped = statusLabelHtml(deploymentDto("failed"), "stopped", "stopped");
    const managedNull = statusLabelHtml(null, "running", "stopped");
    const updating = statusLabelHtml(deploymentDto("ready"), "running", "stopped");
    const ready = statusLabelHtml(deploymentDto("ready"), "running", "running");

    expect(manual).toContain("Manual setup");
    expect(intentionallyStopped).toContain("Intentionally stopped");
    expect(managedNull).toContain("Progress unavailable");
    expect(managedNull).not.toContain("Manual setup");
    expect(updating).toContain("Final status updating");
    expect(updating).not.toMatch(/>Ready</);
    expect(ready).toMatch(/>Ready</);
  });
});

describe("Step 8 lifecycle controls", () => {
  it("shows Stop setup without Start while a managed deployment is active", () => {
    const html = lifecycleHtml({ deployment: deploymentDto("configuring_hermes") });

    expect(html).toMatch(/>Stop setup</);
    expect(html).not.toMatch(/>Start</);
    expect(html).not.toMatch(/>Retry</);
    expect(html).toMatch(/>Delete</);
  });

  it("shows Retry without Start or Stop setup for failed desired-running setup", () => {
    const html = lifecycleHtml({ deployment: deploymentDto("failed"), status: "error" });

    expect(html).toMatch(/>Retry</);
    expect(html).not.toMatch(/>Start</);
    expect(html).not.toMatch(/>Stop setup</);
    expect(html).toMatch(/>Delete</);
  });

  it("shows only Stop, Restart, and Delete lifecycle actions for ready/running", () => {
    const html = lifecycleHtml({ deployment: deploymentDto("ready"), status: "running" });

    expect(html).toMatch(/>Stop</);
    expect(html).toMatch(/>Restart</);
    expect(html).toMatch(/>Delete</);
    expect(html).not.toMatch(/>Start</);
    expect(html).not.toMatch(/>Running</);
  });

  it("preserves explicit Start and Delete for a stopped manual agent", () => {
    const html = lifecycleHtml({ deployment: null, desiredStatus: "stopped", status: "stopped" });

    expect(html).toMatch(/>Start</);
    expect(html).toMatch(/>Delete</);
    expect(html).not.toMatch(/>Retry</);
    expect(html).not.toMatch(/>Stop setup</);
  });
});

describe("Step 8 progress accessibility and responsive CSS", () => {
  it("renders ordered textual stages, one current step, one polite live region, and busy state", () => {
    const html = renderToStaticMarkup(
      createElement(AgentDeploymentProgress, {
        agentId: AGENT_ID,
        desiredStatus: "running",
        initialDeployment: deploymentDto("verifying_model"),
        observedStatus: "stopped",
      }),
    );
    const labels = [
      "Preparing deployment",
      "Provisioning runner",
      "Configuring Hermes",
      "Starting gateway",
      "Verifying model",
      "Connecting Telegram",
      "Ready",
    ];

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('<ol class="deployment-stage-list"');
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1);
    expect(html).toContain('aria-atomic="true"');
    const orderedListHtml = html.slice(html.indexOf('<ol class="deployment-stage-list"'));
    for (let index = 1; index < labels.length; index += 1) {
      expect(orderedListHtml.indexOf(labels[index - 1] ?? "")).toBeLessThan(
        orderedListHtml.indexOf(labels[index] ?? ""),
      );
    }
  });

  it("renders a focusable terminal alert and never hydrates raw error detail", () => {
    const unsafe = {
      ...deploymentDto("failed"),
      error: {
        code: "telegram_not_connected",
        detail: "STEP8-RAW-DTO-ERROR-DETAIL",
      },
    } as unknown as PublicAgentDeployment;
    const html = renderToStaticMarkup(
      createElement(AgentDeploymentProgress, {
        agentId: AGENT_ID,
        desiredStatus: "running",
        initialDeployment: unsafe,
        observedStatus: "error",
      }),
    );

    expect(html).toContain('role="alert" tabindex="-1"');
    expect(html).toContain("Automatic setup could not finish. Retry or stop this agent.");
    expect(html).not.toContain("STEP8-RAW-DTO-ERROR-DETAIL");
  });

  it("keeps the 320px progress/card contract wrapping and motion-independent", async () => {
    const css = await readFile("app/globals.css", "utf8");
    const progressCss = css.slice(css.indexOf(".agent-deployment-progress-card"));

    expect(css).toMatch(/@media \(max-width: (?:4[0-9]{2}|3[2-9][0-9])px\)/);
    expect(css).toMatch(/\.agent-deployment-progress-card\s*\{[^}]*min-width:\s*0[^}]*\}/);
    expect(css).toMatch(/\.agent-deployment-progress-header\s*\{[^}]*flex-wrap:\s*wrap[^}]*\}/);
    expect(css).toMatch(/\.deployment-stage-list li\s*\{[^}]*min-width:\s*0[^}]*\}/);
    expect(css).toMatch(/\.primary-button,\s*\.secondary-button\s*\{[^}]*min-height:\s*42px/);
    expect(progressCss).not.toMatch(/animation(?:-name)?:/);
  });

  it("keeps polling confined to detail and inventory/dashboard snapshots server-rendered", async () => {
    const [agentsPage, dashboardPage, mobileList, detailProgress] = await Promise.all([
      readFile("app/agents/page.tsx", "utf8"),
      readFile("app/dashboard/page.tsx", "utf8"),
      readFile("app/agents/_components/mobile-agent-list.tsx", "utf8"),
      readFile("app/agents/_components/agent-deployment-progress.tsx", "utf8"),
    ]);

    for (const source of [agentsPage, dashboardPage, mobileList]) {
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain("setInterval(");
      expect(source).not.toContain("setTimeout(");
      expect(source).not.toContain("AgentDeploymentProgress");
    }
    expect(detailProgress).toContain("fetch(`/api/agents/");
    expect(detailProgress).toContain("encodeURIComponent(agentId)");
    expect(detailProgress).toContain("/deployment`");
    expect(detailProgress).toContain('cache: "no-store"');
    expect(detailProgress).toContain('credentials: "same-origin"');
  });
});

function statusLabelHtml(
  deployment: PublicAgentDeployment | null,
  desiredStatus: "running" | "stopped",
  observedStatus: "running" | "stopped",
) {
  return renderToStaticMarkup(
    createElement(DeploymentStatusLabel, { deployment, desiredStatus, observedStatus }),
  );
}

function lifecycleHtml({
  deployment,
  desiredStatus = "running",
  status = "stopped",
}: {
  deployment: PublicAgentDeployment | null;
  desiredStatus?: "running" | "stopped";
  status?: "stopped" | "running" | "error";
}) {
  return renderToStaticMarkup(
    createElement(AgentLifecycleControls, {
      agentId: AGENT_ID,
      deployment,
      desiredStatus,
      status,
    }),
  );
}

function deploymentDto(stage: PublicAgentDeploymentStage): PublicAgentDeployment {
  const terminalAt = "2026-08-03T11:05:00.000Z";

  return {
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    stage,
    configRevision: "cfg-step8-ui",
    attemptCount: 0,
    error: stage === "failed" ? { code: "telegram_not_connected" } : null,
    nextAttemptAt: null,
    startedAt: stage === "pending" ? null : "2026-08-03T11:01:00.000Z",
    completedAt: stage === "ready" ? terminalAt : null,
    failedAt: stage === "failed" ? terminalAt : null,
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: stage === "pending" ? "2026-08-03T11:00:00.000Z" : terminalAt,
  };
}
