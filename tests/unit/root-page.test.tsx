import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import AgentsPage from "@/app/agents/page";
import DashboardPage, { DashboardContent } from "@/app/dashboard/page";
import Home from "@/app/page";
import SettingsPage from "@/app/settings/page";
import type { AgentBackupSummary } from "@/src/server/backups/list-backups";
import type {
  CostEstimate,
  CostEstimateWindowDto,
  DevelopmentUserCostEstimatesDto,
} from "@/src/server/costs/cost-estimates";
import type { AgentEventDto } from "@/src/server/events/agent-events";
import type { ManualRunnerCapacitySummary } from "@/src/server/runners/manual-runner-status";

const APPLICATION_USER_ID = "00000000-0000-4000-8000-000000000101";
const PAGE_AUTH_FAILURES = [
  { name: "unauthenticated", result: { ok: false, status: 401, code: "unauthenticated" } },
  {
    name: "unsafe auth configuration",
    result: { ok: false, status: 503, code: "development_auth_not_allowed" },
  },
] as const;

const mocks = vi.hoisted(() => ({
  closeDashboardConnection: vi.fn(),
  createDatabaseConnection: vi.fn(),
  getActiveAgentForUser: vi.fn(),
  getCostEstimatesForUser: vi.fn(),
  listAgentEventFeedForUser: vi.fn(),
  listLatestAgentActivityForUser: vi.fn(),
  listLatestActiveAgentProcessLogsForUser: vi.fn(),
  listActiveAgentsForUser: vi.fn(),
  listModelConnectionsForUser: vi.fn(),
  listCloudRunnerProvisioningSummariesForUser: vi.fn(),
  listAssignableRunnersForUser: vi.fn(),
  listManualRunnerStatusSummariesForUser: vi.fn(),
  listSettingsRunnerManagementSummariesForUser: vi.fn(),
  getAssignedManualRunnerStatusForUserAgent: vi.fn(),
  listAgentSecretStatusesForUser: vi.fn(),
  listAgentBackupsForUser: vi.fn(),
  listPendingApprovalsForUserAgent: vi.fn(),
  listPendingApprovalsForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/src/server/costs/cost-estimates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/costs/cost-estimates")>();

  return {
    ...actual,
    getCostEstimatesForUser: mocks.getCostEstimatesForUser,
  };
});

vi.mock("@/src/server/agents/list-agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/list-agents")>();

  return {
    ...actual,
    getActiveAgentForUser: mocks.getActiveAgentForUser,
    listActiveAgentsForUser: mocks.listActiveAgentsForUser,
    listActiveAgentsForDevelopmentUser: mocks.listActiveAgentsForUser,
  };
});

vi.mock("@/src/server/agents/model-connections", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/model-connections")>();

  return {
    ...actual,
    listModelConnectionsForUser: mocks.listModelConnectionsForUser,
  };
});

vi.mock("@/src/server/agents/agent-secrets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/agent-secrets")>();

  return {
    ...actual,
    listAgentSecretStatusesForUser: mocks.listAgentSecretStatusesForUser,
  };
});

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/approvals/agent-approvals", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/approvals/agent-approvals")>();

  return {
    ...actual,
    listPendingApprovalsForUserAgent: mocks.listPendingApprovalsForUserAgent,
    listPendingApprovalsForUser: mocks.listPendingApprovalsForUser,
  };
});

vi.mock("@/src/server/backups/list-backups", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/backups/list-backups")>();

  return {
    ...actual,
    listAgentBackupsForUser: mocks.listAgentBackupsForUser,
  };
});

vi.mock("@/src/server/events/agent-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/events/agent-events")>();

  return {
    ...actual,
    listAgentEventFeedForUser: mocks.listAgentEventFeedForUser,
    listLatestAgentActivityForUser: mocks.listLatestAgentActivityForUser,
  };
});

vi.mock("@/src/server/logs/agent-logs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/logs/agent-logs")>();

  return {
    ...actual,
    listLatestActiveAgentProcessLogsForUser: mocks.listLatestActiveAgentProcessLogsForUser,
  };
});

vi.mock("@/src/server/runners/manual-runner-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/runners/manual-runner-status")>();

  return {
    ...actual,
    getAssignedManualRunnerStatusForUserAgent: mocks.getAssignedManualRunnerStatusForUserAgent,
    listManualRunnerStatusSummariesForUser: mocks.listManualRunnerStatusSummariesForUser,
    listSettingsRunnerManagementSummariesForUser:
      mocks.listSettingsRunnerManagementSummariesForUser,
    listSettingsRunnerManagementSummariesForDevelopmentUser:
      mocks.listSettingsRunnerManagementSummariesForUser,
  };
});

vi.mock("@/src/server/runners/cloud-runner-provisioning", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/src/server/runners/cloud-runner-provisioning")>();

  return {
    ...actual,
    listCloudRunnerProvisioningSummariesForUser: mocks.listCloudRunnerProvisioningSummariesForUser,
    listCloudRunnerProvisioningSummariesForDevelopmentUser:
      mocks.listCloudRunnerProvisioningSummariesForUser,
  };
});

vi.mock("@/src/server/runners/runner-assignment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/runners/runner-assignment")>();

  return {
    ...actual,
    listAssignableRunnersForUser: mocks.listAssignableRunnersForUser,
  };
});

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

function capacity(
  overrides: Partial<ManualRunnerCapacitySummary> = {},
): ManualRunnerCapacitySummary {
  return {
    runningAgents: 0,
    maxAgents: 1,
    cpuUsedPercent: null,
    memoryUsedMb: null,
    memoryTotalMb: null,
    diskUsedMb: null,
    diskTotalMb: null,
    blocker: null,
    ...overrides,
  };
}

const ESTIMATE_EXPLANATION =
  "Raw compute estimate only; plans may also include orchestration, monitoring, backups, support, and margin.";

function availableCost(cents: number): CostEstimate {
  return {
    available: true,
    cents,
    currency: "USD",
    label: "Estimated raw infrastructure cost",
    explanation: ESTIMATE_EXPLANATION,
  };
}

function unavailableCost(
  explanation = "A total is unavailable because at least one runner does not have provider price metadata.",
): CostEstimate {
  return {
    available: false,
    reason: "incomplete_runner_prices",
    label: "Estimate unavailable",
    explanation,
  };
}

function costWindow(
  key: "daily" | "monthly",
  overrides: Partial<CostEstimateWindowDto> = {},
): CostEstimateWindowDto {
  const isDaily = key === "daily";

  return {
    key,
    startsAt: isDaily ? "2026-07-09T08:00:00.000Z" : "2026-06-10T08:00:00.000Z",
    endsAt: "2026-07-10T08:00:00.000Z",
    durationMs: (isDaily ? 1 : 30) * 24 * 60 * 60 * 1_000,
    runnerCount: 1,
    runningAgentCount: 2,
    windowActiveAgentCount: 2,
    runnerMonthlyCost: availableCost(600),
    estimatedInfrastructureCost: availableCost(isDaily ? 20 : 300),
    estimatedInfrastructureCostPerAgent: availableCost(isDaily ? 10 : 150),
    runners: [
      {
        runnerId: "00000000-0000-4000-8000-000000000225",
        runnerName: "dop_v1_secret-looking-runner-name",
        runnerKind: "digitalocean",
        sizeSlug: "s-1vcpu-1gb",
        uptimeMs: (isDaily ? 1 : 15) * 24 * 60 * 60 * 1_000,
        runningAgentCount: 2,
        windowActiveAgentCount: 2,
        runnerMonthlyCost: availableCost(600),
        estimatedInfrastructureCost: availableCost(isDaily ? 20 : 300),
        estimatedInfrastructureCostPerAgent: availableCost(isDaily ? 10 : 150),
      },
    ],
    ...overrides,
  };
}

function costEstimates(
  overrides: Partial<DevelopmentUserCostEstimatesDto> = {},
): DevelopmentUserCostEstimatesDto {
  return {
    generatedAt: "2026-07-10T08:00:00.000Z",
    daily: costWindow("daily"),
    monthly: costWindow("monthly"),
    ...overrides,
  };
}

describe("product shell routes", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({
      ok: true,
      userId: APPLICATION_USER_ID,
    });
    mocks.createDatabaseConnection.mockReturnValue({
      db: {},
      close: mocks.closeDashboardConnection,
    });
    mocks.closeDashboardConnection.mockResolvedValue(undefined);
    mocks.listLatestAgentActivityForUser.mockResolvedValue({
      ok: true,
      page: {
        events: [],
        nextCursor: null,
      },
    });
    mocks.listLatestActiveAgentProcessLogsForUser.mockResolvedValue([]);
    mocks.listManualRunnerStatusSummariesForUser.mockResolvedValue([]);
    mocks.listCloudRunnerProvisioningSummariesForUser.mockResolvedValue([]);
    mocks.listAssignableRunnersForUser.mockResolvedValue([]);
    mocks.listModelConnectionsForUser.mockResolvedValue([
      {
        assistant: "chatgpt",
        displayName: "ChatGPT",
        credentialLabel: "OpenAI API key",
        credentialHelpUrl: "https://platform.openai.com/api-keys",
        credentialBillingNote: "OpenAI API usage is billed separately.",
        status: "action_required",
      },
      {
        assistant: "claude",
        displayName: "Claude",
        credentialLabel: "Anthropic API key",
        credentialHelpUrl: "https://console.anthropic.com/settings/keys",
        credentialBillingNote: "Anthropic API usage is billed separately.",
        status: "action_required",
      },
    ]);
    mocks.getCostEstimatesForUser.mockResolvedValue(costEstimates());
    mocks.listSettingsRunnerManagementSummariesForUser.mockResolvedValue([]);
    mocks.getAssignedManualRunnerStatusForUserAgent.mockResolvedValue(null);
    mocks.listAgentSecretStatusesForUser.mockResolvedValue({
      ok: true,
      secrets: [],
    });
    mocks.listAgentBackupsForUser.mockResolvedValue([]);
    mocks.listPendingApprovalsForUser.mockResolvedValue([]);
    mocks.listPendingApprovalsForUserAgent.mockResolvedValue([]);
    mocks.listAgentEventFeedForUser.mockResolvedValue({
      ok: true,
      page: {
        events: [],
        nextCursor: null,
      },
    });
  });

  afterEach(() => {
    mocks.closeDashboardConnection.mockReset();
    mocks.createDatabaseConnection.mockReset();
    mocks.getActiveAgentForUser.mockReset();
    mocks.getCostEstimatesForUser.mockReset();
    mocks.listAgentEventFeedForUser.mockReset();
    mocks.listLatestAgentActivityForUser.mockReset();
    mocks.listLatestActiveAgentProcessLogsForUser.mockReset();
    mocks.listActiveAgentsForUser.mockReset();
    mocks.listModelConnectionsForUser.mockReset();
    mocks.listCloudRunnerProvisioningSummariesForUser.mockReset();
    mocks.listAssignableRunnersForUser.mockReset();
    mocks.listManualRunnerStatusSummariesForUser.mockReset();
    mocks.listSettingsRunnerManagementSummariesForUser.mockReset();
    mocks.getAssignedManualRunnerStatusForUserAgent.mockReset();
    mocks.listAgentSecretStatusesForUser.mockReset();
    mocks.listAgentBackupsForUser.mockReset();
    mocks.listPendingApprovalsForUserAgent.mockReset();
    mocks.listPendingApprovalsForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
    mocks.notFound.mockClear();
  });

  it("renders the root product dashboard shell", () => {
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("plingpling");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Operational dashboard");
    expect(html).toContain("No agent records");
  });

  it("renders the dashboard empty persisted-agent state without fake records", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([]);
    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No agent records");
    expect(html).toContain("No activity yet");
    expect(html).toContain("No pending approvals");
    expect(html).toContain("Cloud provisioning");
    expect(html).toContain("No cloud runners");
    expect(html).toContain('class="dashboard-page"');
    expect(html).toContain('class="dashboard-fleet-pulse"');
    expect(html).toContain("Fleet pulse");
    expect(html).toContain('class="dashboard-workbench"');
    expect(html).toContain('class="dashboard-work-queue"');
    expect(html).toContain('class="dashboard-activity-column"');
    expect(html).toContain('class="dashboard-infrastructure"');
    expect(html).toContain('class="dashboard-infrastructure-grid"');
    expect(html).toContain('class="dashboard-system-notes"');
    expect(html.indexOf("dashboard-fleet-pulse-title")).toBeLessThan(
      html.indexOf("dashboard-agents-title"),
    );
    expect(html.indexOf("dashboard-agents-title")).toBeLessThan(
      html.indexOf("dashboard-activity-title"),
    );
    expect(html.indexOf("dashboard-infrastructure-title")).toBeLessThan(
      html.indexOf("dashboard-cost-summary-title"),
    );
    expect(html).toContain("Active persisted records are read from the database.");
    expect(html).toContain(
      "Start, Stop, and Restart use the Docker runner adapter and existing controls.",
    );
    expect(html).toContain(
      "Full per-agent log streams and local-development config editing are present on agent detail pages.",
    );
    expect(html).not.toContain("lifecycle verification waits");
    expect(html).not.toContain("Delete controls wait");
    expect(html).not.toContain("config editing, and runner work wait");
    expect(html).not.toContain("approvals are absent");
    expect(html).toContain("Approval decisions are available from the queue");
    expect(html).toContain("Cloud runner provisioning status is visible");
    expect(html).toContain("production runners, billing, and secret storage wait");
    expect(html).not.toContain("Approval decisions, production runners");
    expect(html).not.toContain("Deny decisions, production runners");
    expect(html).not.toContain("Approvals, production runners");
    expect(html).not.toContain("No persisted agent table or records are queried");
    expect(mocks.listActiveAgentsForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.listManualRunnerStatusSummariesForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
    );
    expect(mocks.getCostEstimatesForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
  });

  it.each(PAGE_AUTH_FAILURES)("stops dashboard loading for $name configured-user results", async ({
    result,
  }) => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce(result);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("Authentication required");
    expect(html).toContain("Authentication is required.");
    expect(html).not.toContain(result.code);
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
    expect(mocks.listActiveAgentsForUser).not.toHaveBeenCalled();
    expect(mocks.listLatestAgentActivityForUser).not.toHaveBeenCalled();
    expect(mocks.listPendingApprovalsForUser).not.toHaveBeenCalled();
    expect(mocks.listLatestActiveAgentProcessLogsForUser).not.toHaveBeenCalled();
    expect(mocks.listManualRunnerStatusSummariesForUser).not.toHaveBeenCalled();
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).not.toHaveBeenCalled();
    expect(mocks.getCostEstimatesForUser).not.toHaveBeenCalled();
  });

  it("renders accessible daily and monthly infrastructure estimates without DTO internals", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardContent, {
        costResult: {
          ok: true,
          estimates: costEstimates(),
        },
      }),
    );

    expect(html).toContain('aria-labelledby="dashboard-cost-summary-title"');
    expect(html).toContain("Infrastructure cost estimates");
    expect(html).toContain("Daily estimate");
    expect(html).toContain("Monthly estimate");
    expect(html).toContain("Estimated runner monthly cost");
    expect(html).toContain("Estimated daily infrastructure cost");
    expect(html).toContain("Estimated monthly infrastructure cost");
    expect(html).toContain("Estimated infrastructure cost per agent");
    expect(html).toContain("Running agents now");
    expect(html).toContain("2 running");
    expect(html).toContain("$6.00");
    expect(html).toContain("$0.20");
    expect(html).toContain("$0.10");
    expect(html).toContain("$3.00");
    expect(html).toContain("$1.50");
    expect(html).toContain("Based on agents active during this window.");
    expect(html).toContain("Raw compute estimate only");
    expect(html).not.toContain("00000000-0000-4000-8000-000000000225");
    expect(html).not.toContain("dop_v1_secret-looking-runner-name");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("sizeSlug");
    expect(html).not.toContain("providerResourceId");
    expect(html).not.toContain("endpointUrl");
    expect(html).not.toContain("credential");
  });

  it("keeps manual or unknown runner prices explicitly unavailable instead of showing zero", () => {
    const unavailable = unavailableCost();
    const html = renderToStaticMarkup(
      createElement(DashboardContent, {
        costResult: {
          ok: true,
          estimates: costEstimates({
            daily: costWindow("daily", {
              runnerMonthlyCost: unavailable,
              estimatedInfrastructureCost: unavailable,
              estimatedInfrastructureCostPerAgent: unavailable,
            }),
            monthly: costWindow("monthly", {
              runnerMonthlyCost: unavailable,
              estimatedInfrastructureCost: unavailable,
              estimatedInfrastructureCostPerAgent: unavailable,
            }),
          }),
        },
      }),
    );

    expect(html).toContain("Estimate unavailable");
    expect(html).toContain(
      "A total is unavailable because at least one runner does not have provider price metadata.",
    );
    expect(html).toContain(
      "Manual runners and unknown provider prices remain unavailable until price metadata is configured.",
    );
    expect(html).not.toContain("$0.00");
  });

  it("shows zero running agents while leaving the per-agent estimate unavailable", () => {
    const noActiveAgents: CostEstimate = {
      available: false,
      reason: "no_active_agents",
      label: "Estimate unavailable",
      explanation:
        "A per-agent estimate is unavailable because no agents were active in this window.",
    };
    const html = renderToStaticMarkup(
      createElement(DashboardContent, {
        costResult: {
          ok: true,
          estimates: costEstimates({
            daily: costWindow("daily", {
              runningAgentCount: 0,
              windowActiveAgentCount: 0,
              estimatedInfrastructureCostPerAgent: noActiveAgents,
            }),
            monthly: costWindow("monthly", {
              runningAgentCount: 0,
              windowActiveAgentCount: 0,
              estimatedInfrastructureCostPerAgent: noActiveAgents,
            }),
          }),
        },
      }),
    );

    expect(html).toContain("0 running");
    expect(html).toContain("No agents active");
    expect(html).toContain(
      "A per-agent estimate is unavailable because no agents were active in this window.",
    );
  });

  it("keeps the rest of the dashboard useful when cost loading fails safely", async () => {
    const { CostEstimatePersistenceError } = await import("@/src/server/costs/cost-estimates");
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([
      {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        name: "Research Agent",
        templateKey: "research_agent",
        templateLabel: "Research Agent",
        status: "stopped",
        href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        createdAt: "2026-07-03T05:00:00.000Z",
      },
    ]);
    mocks.getCostEstimatesForUser.mockRejectedValueOnce(new CostEstimatePersistenceError());

    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Latest activity");
    expect(html).toContain("Infrastructure cost estimates could not be loaded.");
    expect(html).toContain("Agent and runner operations remain available.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("Cost estimate calculation failed");
  });

  it("starts independent dashboard loaders concurrently", async () => {
    let resolveAgents: ((agents: []) => void) | undefined;
    const pendingAgents = new Promise<[]>((resolve) => {
      resolveAgents = resolve;
    });
    mocks.listActiveAgentsForUser.mockReturnValueOnce(pendingAgents);

    const renderPromise = DashboardPage();

    await vi.waitFor(() => {
      expect(mocks.getCostEstimatesForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
      expect(mocks.listLatestAgentActivityForUser).toHaveBeenCalledWith({
        db: {},
        userId: APPLICATION_USER_ID,
        limit: 8,
      });
      expect(mocks.listPendingApprovalsForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
      expect(mocks.listLatestActiveAgentProcessLogsForUser).toHaveBeenCalledWith({
        db: {},
        userId: APPLICATION_USER_ID,
        limit: 8,
      });
      expect(mocks.listManualRunnerStatusSummariesForUser).toHaveBeenCalledWith(
        APPLICATION_USER_ID,
      );
      expect(mocks.listCloudRunnerProvisioningSummariesForUser).toHaveBeenCalledWith(
        APPLICATION_USER_ID,
      );
    });

    resolveAgents?.([]);
    await renderPromise;
  });

  it("renders persisted agents on the dashboard with lifecycle controls", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([
      {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        name: "Research Agent",
        templateKey: "research_agent",
        templateLabel: "Research Agent",
        status: "stopped",
        href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        createdAt: "2026-07-03T05:00:00.000Z",
      },
    ]);
    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Persisted agents");
    expect(html).toContain("Research Agent");
    expect(html).toContain("stopped");
    expect(html).toContain("Start");
    expect(html).toContain("Delete");
    expect(html).toContain('href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774"');
  });

  it("renders known manual runner status on the dashboard without secret endpoint details", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([]);
    mocks.listManualRunnerStatusSummariesForUser.mockResolvedValueOnce([
      {
        name: "Manual Runner",
        kind: "manual_vps",
        endpointHost: "runner.example.com:8443",
        status: "online",
        capacity: capacity({
          runningAgents: 3,
          maxAgents: 5,
          cpuUsedPercent: 37,
          memoryUsedMb: 512,
          memoryTotalMb: 2048,
          diskUsedMb: null,
          diskTotalMb: null,
        }),
        version: "agentbay-runner/1.2.3",
        lastSeenAt: "2026-07-05T01:01:00.000Z",
        updatedAt: "2026-07-05T01:00:00.000Z",
      },
    ]);

    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Runner health");
    expect(html).toContain("known");
    expect(html).toContain("Manual Runner");
    expect(html).toContain("manual_vps");
    expect(html).toContain("runner.example.com:8443");
    expect(html).toContain("online");
    expect(html).toContain("3 / 5 agents running");
    expect(html).toContain("37%");
    expect(html).toContain("512 / 2,048 MB");
    expect(html).toContain("No runner capacity blocker");
    expect(html).toContain("agentbay-runner/1.2.3");
    expect(html).toContain("2026-07-05T01:01:00.000Z");
    expect(html).toContain("2026-07-05T01:00:00.000Z");
    expect(html).not.toContain("https://user:password@runner.example.com");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("runner_id");
    expect(html).not.toContain("00000000-0000-4000-8000-000000000901");
    expect(html).not.toContain("token");
    expect(html).not.toContain("bearer");
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("cpuPercent");
  });

  it("renders cloud runner provisioning state on the dashboard without secrets", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([]);
    mocks.listCloudRunnerProvisioningSummariesForUser.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000154",
        name: "DigitalOcean Runner",
        kind: "digitalocean",
        status: "provisioning",
        readinessStatus: "provisioning",
        provider: "digitalocean",
        providerResourceId: "do-droplet-154",
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        latestHeartbeatAt: null,
        provisioning: {
          status: "waiting_for_runner",
          error: null,
          startedAt: "2026-07-06T01:00:00.000Z",
          completedAt: null,
          phases: [
            {
              name: "pending",
              status: "completed",
              startedAt: "2026-07-06T01:00:00.000Z",
              completedAt: null,
            },
            {
              name: "waiting_for_runner",
              status: "current",
              startedAt: "2026-07-06T01:00:00.000Z",
              completedAt: null,
            },
          ],
        },
      },
      {
        id: "00000000-0000-4000-8000-000000000155",
        name: "Online Cloud Runner",
        kind: "digitalocean",
        status: "online",
        readinessStatus: "online",
        provider: "digitalocean",
        providerResourceId: "do-droplet-155",
        region: "sfo3",
        sizeSlug: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
        latestHeartbeatAt: "2026-07-06T01:04:00.000Z",
        provisioning: {
          status: "ready",
          error: null,
          startedAt: "2026-07-06T01:00:00.000Z",
          completedAt: "2026-07-06T01:03:00.000Z",
          phases: [
            {
              name: "ready",
              status: "completed",
              startedAt: "2026-07-06T01:00:00.000Z",
              completedAt: "2026-07-06T01:03:00.000Z",
            },
          ],
        },
      },
    ]);

    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Cloud provisioning");
    expect(html).toContain("DigitalOcean Runner");
    expect(html).toContain("Online Cloud Runner");
    expect(html).toContain("digitalocean");
    expect(html).toContain("nyc3");
    expect(html).toContain("s-1vcpu-1gb");
    expect(html).toContain("ubuntu-24-04-x64");
    expect(html).toContain("waiting_for_runner");
    expect(html).toContain("online");
    expect(html).toContain("Runner heartbeat is online and ready for work.");
    expect(html).toContain("2026-07-06T01:04:00.000Z");
    expect(html).not.toContain("registrationToken");
    expect(html).not.toContain("agb_reg_");
    expect(html).not.toContain("agb_run_");
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(html).not.toContain("dop_v1");
  });

  it("renders cloud runner failures with safe next steps in settings", async () => {
    mocks.listSettingsRunnerManagementSummariesForUser.mockResolvedValueOnce([]);
    mocks.listCloudRunnerProvisioningSummariesForUser.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000156",
        name: "Failed Cloud Runner",
        kind: "digitalocean",
        status: "provision_failed",
        readinessStatus: "failed",
        provider: "digitalocean",
        providerResourceId: null,
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        latestHeartbeatAt: null,
        provisioning: {
          status: "failed",
          error: "Sensitive details omitted.",
          startedAt: "2026-07-06T01:00:00.000Z",
          completedAt: "2026-07-06T01:02:00.000Z",
          phases: [
            {
              name: "failed",
              status: "failed",
              startedAt: "2026-07-06T01:00:00.000Z",
              completedAt: null,
            },
          ],
        },
      },
    ]);

    const element = await SettingsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Cloud runners");
    expect(html).toContain("Create Runner");
    expect(html).toContain("Failed Cloud Runner");
    expect(html).toContain("failed");
    expect(html).toContain("Sensitive details omitted.");
    expect(html).toContain("Next step: check the provider configuration");
    expect(html).not.toContain("token=stored-for-downstream");
    expect(html).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(html).not.toContain("dop_v1");
    expect(html).not.toContain("credentialHash");
  });

  it("renders latest dashboard process logs with agent links and safe summaries", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000201",
        name: "Process Log Agent",
        templateKey: "research_agent",
        templateLabel: "Research Agent",
        status: "running",
        href: "/agents/00000000-0000-4000-8000-000000000201",
        createdAt: "2026-07-04T05:00:00.000Z",
      },
    ]);
    mocks.listLatestActiveAgentProcessLogsForUser.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000701",
        agentId: "00000000-0000-4000-8000-000000000201",
        agentName: "Process Log Agent",
        agentHref: "/agents/00000000-0000-4000-8000-000000000201",
        runnerId: "00000000-0000-4000-8000-000000000901",
        localRunnerProcessId: "00000000-0000-4000-8000-000000000901",
        dockerRunnerContainerId: null,
        source: "manual_runner",
        stream: "stdout",
        level: "info",
        message: "runner booted",
        sequence: 1,
        createdAt: "2026-07-04T06:00:00.000Z",
      },
      {
        id: "00000000-0000-4000-8000-000000000702",
        agentId: "00000000-0000-4000-8000-000000000201",
        agentName: "Process Log Agent",
        agentHref: "/agents/00000000-0000-4000-8000-000000000201",
        runnerId: "00000000-0000-4000-8000-000000000901",
        localRunnerProcessId: "00000000-0000-4000-8000-000000000901",
        dockerRunnerContainerId: null,
        source: "manual_runner",
        stream: "stderr",
        level: "error",
        message: "TOKEN=stored-for-downstream failed",
        sequence: 2,
        createdAt: "2026-07-04T06:00:01.000Z",
      },
    ]);
    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Latest process logs");
    expect(html).toContain("2 shown");
    expect(html).toContain("runner booted");
    expect(html).toContain("stdout");
    expect(html).toContain("stderr");
    expect(html).toContain("manual_runner");
    expect(html).toContain("Process Log Agent");
    expect(html).toContain('href="/agents/00000000-0000-4000-8000-000000000201"');
    expect(html).toContain("Sensitive details omitted.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("stored-for-downstream");
    expect(html).not.toContain("runnerId");
    expect(mocks.listLatestActiveAgentProcessLogsForUser).toHaveBeenCalledWith({
      db: {},
      userId: APPLICATION_USER_ID,
      limit: 8,
    });
  });

  it("renders dashboard process log empty and safe error states", () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(DashboardContent, {
        processLogsResult: {
          ok: true,
          logs: [],
        },
      }),
    );
    const errorHtml = renderToStaticMarkup(
      createElement(DashboardContent, {
        processLogsResult: {
          ok: false,
        },
      }),
    );

    expect(emptyHtml).toContain("No process logs yet");
    expect(emptyHtml).toContain(
      "Captured stdout and stderr lines for active agents will appear here.",
    );
    expect(errorHtml).toContain("Process logs could not be loaded.");
    expect(errorHtml).not.toContain("postgres://");
  });

  it("renders latest dashboard activity newest-first with agent context and deleted labels", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardContent, {
        listResult: {
          ok: true,
          agents: [
            {
              id: "00000000-0000-4000-8000-000000000201",
              name: "Active Feed Agent",
              templateKey: "research_agent",
              templateVersion: "1.0.0",
              templateLabel: "Research Agent",
              status: "running",
              desiredStatus: "running",
              latestDeployment: null,
              runtime: null,
              href: "/agents/00000000-0000-4000-8000-000000000201",
              createdAt: "2026-07-04T05:00:00.000Z",
            },
          ],
        },
        activityResult: {
          ok: true,
          events: [
            {
              id: "00000000-0000-4000-8000-000000000411",
              agentId: "00000000-0000-4000-8000-000000000212",
              actor: {
                userId: "00000000-0000-4000-8000-000000000101",
                displayName: "Local development user",
              },
              type: "agent.deleted",
              message: 'Agent "Deleted Feed Agent" deleted from active views.',
              metadata: {
                fromStatus: "stopped",
                toStatus: "deleted",
                deletedAt: "2026-07-04T06:30:00.000Z",
              },
              metadataSummary: "stopped -> deleted; Deleted at: 2026-07-04T06:30:00.000Z",
              createdAt: "2026-07-04T06:30:00.000Z",
              agent: {
                id: "00000000-0000-4000-8000-000000000212",
                name: "Deleted Feed Agent",
                templateKey: "github_issue_agent",
                status: "stopped",
                deletedAt: "2026-07-04T06:30:00.000Z",
              },
            },
            {
              id: "00000000-0000-4000-8000-000000000311",
              agentId: "00000000-0000-4000-8000-000000000201",
              actor: {
                userId: "00000000-0000-4000-8000-000000000101",
                displayName: "Jane Operator",
              },
              type: "agent.started",
              message: 'Start completed for agent "Active Feed Agent".',
              metadata: {
                fromStatus: "starting",
                toStatus: "running",
              },
              metadataSummary: "starting -> running",
              createdAt: "2026-07-04T06:00:00.000Z",
              agent: {
                id: "00000000-0000-4000-8000-000000000201",
                name: "Active Feed Agent",
                templateKey: "research_agent",
                status: "running",
                deletedAt: null,
              },
            },
          ],
        },
      }),
    );

    expect(html.indexOf("deleted from active views")).toBeLessThan(
      html.indexOf("Start completed for agent"),
    );
    expect(html).toContain("Latest activity");
    expect(html).toContain("Deleted agent");
    expect(html).toContain("agent.deleted");
    expect(html).toContain("agent.started");
    expect(html).toContain("Local development user");
    expect(html).toContain("Jane Operator");
    expect(html).toContain("stopped -&gt; deleted; Deleted at: 2026-07-04T06:30:00.000Z");
    expect(html).toContain("starting -&gt; running");
    expect(html).toContain('href="/agents/00000000-0000-4000-8000-000000000201"');
    expect(html).not.toContain('href="/agents/00000000-0000-4000-8000-000000000212"');
  });

  it("renders persisted pending approvals on the dashboard without raw payload details", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([]);
    mocks.listPendingApprovalsForUser.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "00000000-0000-4000-8000-000000000201",
        agentName: "Approval Agent",
        agentHref: "/agents/00000000-0000-4000-8000-000000000201",
        title: "Review outbound message",
        description: "Approve the drafted Telegram summary before it is sent.",
        status: "pending",
        requestedBy: "fake-runner",
        payloadSummary:
          "Source: fake_runner; Action: telegram.send_message; Destination: Demo Telegram channel; Summary: Daily operations summary is ready for review.",
        createdAt: "2026-07-04T08:15:00.000Z",
        expiresAt: "2026-07-04T09:15:00.000Z",
      },
    ]);

    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Pending approvals");
    expect(html).toContain("1 pending");
    expect(html).toContain("Approval Agent");
    expect(html).toContain('href="/agents/00000000-0000-4000-8000-000000000201"');
    expect(html).toContain("Review outbound message");
    expect(html).toContain("Approve the drafted Telegram summary before it is sent.");
    expect(html).toContain("pending");
    expect(html).toContain("fake-runner");
    expect(html).toContain("Payload summary");
    expect(html).toContain("Action: telegram.send_message");
    expect(html).toContain("Daily operations summary is ready for review.");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("2026-07-04T08:15:00.000Z");
    expect(html).toContain("2026-07-04T09:15:00.000Z");
    expect(html).not.toContain("payload_json");
    expect(html).not.toContain("token");
    expect(html).not.toContain("postgres://");
  });

  it("keeps the active agent list visible when dashboard activity cannot be loaded", () => {
    const html = renderToStaticMarkup(
      createElement(DashboardContent, {
        listResult: {
          ok: true,
          agents: [
            {
              id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
              name: "Research Agent",
              templateKey: "research_agent",
              templateVersion: "1.0.0",
              templateLabel: "Research Agent",
              status: "stopped",
              desiredStatus: "stopped",
              latestDeployment: null,
              runtime: null,
              href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
              createdAt: "2026-07-03T05:00:00.000Z",
            },
          ],
        },
        activityResult: {
          ok: false,
        },
      }),
    );

    expect(html).toContain("Research Agent");
    expect(html).toContain("Latest activity could not be loaded.");
    expect(html).not.toContain("postgres://");
  });

  it("keeps agents and activity visible when dashboard approvals cannot be loaded", async () => {
    const { AgentApprovalPersistenceError } = await import(
      "@/src/server/approvals/agent-approvals"
    );
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([
      {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        name: "Research Agent",
        templateKey: "research_agent",
        templateLabel: "Research Agent",
        status: "stopped",
        href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        createdAt: "2026-07-03T05:00:00.000Z",
      },
    ]);
    mocks.listPendingApprovalsForUser.mockRejectedValueOnce(new AgentApprovalPersistenceError());

    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("No activity yet");
    expect(html).toContain("Pending approvals could not be loaded.");
    expect(html).not.toContain("Approval request failed.");
    expect(html).not.toContain("postgres://");
  });

  it("renders the agents empty database-backed list state and create form", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([]);
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No agents yet");
    expect(html).toContain('class="agents-page"');
    expect(html).toContain('class="agents-workspace-overview"');
    expect(html).toContain("Agent workspace");
    expect(html).toContain('class="agent-creation-panel"');
    expect(html).toContain('class="assistant-choice-list"');
    expect(html).toContain('class="agent-creation-actions"');
    expect(html).toContain('class="agents-cloud-status"');
    expect(html.indexOf("agents-workspace-title")).toBeLessThan(html.indexOf("agent-list-title"));
    expect(html.indexOf("agent-list-title")).toBeLessThan(html.indexOf("create-agent-title"));
    expect(html.indexOf("create-agent-title")).toBeLessThan(
      html.indexOf("agents-cloud-runner-title"),
    );
    expect(html).toContain("Create a new agent");
    expect(html).toContain("ChatGPT");
    expect(html).toContain("Claude");
    expect(html).toContain("OpenAI API key");
    expect(html).toContain("Create my agent");
    expect(html).toContain("We handle the rest");
    expect(html).not.toContain("OpenRouter");
    expect(html).not.toContain("Template catalogue");
    expect(html).not.toContain("Advanced runner selection");
    expect(html).not.toContain("Create agent in Milestone 1");
    expect(mocks.listActiveAgentsForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.listAssignableRunnersForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.listModelConnectionsForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
    );
  });

  it.each(
    PAGE_AUTH_FAILURES,
  )("stops agents-page loading for $name configured-user results", async ({ result }) => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce(result);

    const html = renderToStaticMarkup(await AgentsPage());

    expect(html).toContain("Authentication required");
    expect(html).toContain("Authentication is required.");
    expect(html).not.toContain(result.code);
    expect(mocks.listActiveAgentsForUser).not.toHaveBeenCalled();
    expect(mocks.listAssignableRunnersForUser).not.toHaveBeenCalled();
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).not.toHaveBeenCalled();
  });

  it("renders persisted agents with stable identity and links", async () => {
    mocks.listActiveAgentsForUser.mockResolvedValueOnce([
      {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        name: "Research Agent",
        templateKey: "research_agent",
        templateVersion: "1.0.0",
        templateLabel: "Research Agent",
        status: "stopped",
        href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        createdAt: "2026-07-03T05:00:00.000Z",
      },
    ]);
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("stopped");
    expect(html).toContain("3e47bed7-b58f-4394-93c0-01e3d1e51774");
    expect(html).toContain('href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774"');
    expect(html).toContain("Configure");
    expect(html).toContain(
      'href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774#configuration-title"',
    );
  });

  it("renders safe feedback when persisted agents cannot be loaded", async () => {
    const { AgentListPersistenceError } = await import("@/src/server/agents/list-agents");
    mocks.listActiveAgentsForUser.mockRejectedValueOnce(new AgentListPersistenceError());
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Agent records could not be loaded.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("Agent list failed.");
  });

  it("renders persisted agent detail records with the empty activity state", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(
      detailAgent({ statusReason: "Waiting for setup." }),
    );
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("stopped");
    expect(html).toContain('class="agent-detail-page"');
    expect(html).toContain('class="placeholder-panel agent-overview-panel"');
    expect(html).toContain('class="agent-readiness-track"');
    expect(html).toContain("Agent run readiness</legend>");
    expect(html).toContain('class="agent-detail-workspace"');
    expect(html).toContain('class="agent-detail-primary"');
    expect(html).toContain('class="agent-detail-rail"');
    expect(html).toContain('class="agent-detail-live-grid"');
    expect(html).toContain('class="agent-detail-activity"');
    expect(html.indexOf("Hermes setup")).toBeLessThan(html.indexOf("Configuration"));
    expect(html.indexOf("Configuration")).toBeLessThan(html.indexOf("Assigned runner"));
    expect(html).toContain("research_agent");
    expect(html).toContain("Template version");
    expect(html).toContain("Template settings");
    expect(html).toContain("Default tools");
    expect(html).toContain("Web search, Notes, Summaries");
    expect(html).toContain("Default prompt");
    expect(html).toContain(
      "You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries.",
    );
    expect(html).toContain("2026-07-03T05:00:00.000Z");
    expect(html).toContain("2026-07-03T05:30:00.000Z");
    expect(html).toContain("Waiting for setup.");
    expect(html).toContain("Configuration");
    expect(html).toContain("Saved config");
    expect(html).toContain("gpt-4.1-mini");
    expect(html).toContain("$2.00");
    expect(html).toContain("Model name");
    expect(html).toContain("Max daily spend");
    expect(html).toContain("System prompt");
    expect(html).toContain("Save config");
    expect(html).toContain("Operational alerts");
    expect(html).toContain("No active alerts");
    expect(html).toContain("No assigned manual runner state is available");
    expect(html).toContain("Assigned runner");
    expect(html).toContain("No runner assigned");
    expect(html).toContain("Latest log summaries");
    expect(html).toContain("Loading runtime logs.");
    expect(html).toContain("Pending approvals");
    expect(html).toContain("No pending approvals");
    expect(html).toContain("Persisted approval requests for this agent will appear here.");
    expect(html).toContain("Activity");
    expect(html).toContain("No activity yet");
    expect(html).toContain("0 shown");
    expect(html).not.toContain("No record lookup is performed");
    expect(html).not.toContain("config editing");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("agent_id");
    expect(mocks.getActiveAgentForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(mocks.listPendingApprovalsForUserAgent).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(mocks.getAssignedManualRunnerStatusForUserAgent).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(mocks.listAgentSecretStatusesForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
    expect(mocks.listAgentEventFeedForUser).toHaveBeenCalledWith({
      db: {},
      userId: APPLICATION_USER_ID,
      agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
      cursor: null,
      limit: 10,
    });
    expect(mocks.closeDashboardConnection).toHaveBeenCalledTimes(2);
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
  });

  it.each(
    PAGE_AUTH_FAILURES,
  )("stops agent detail loading for $name configured-user results", async ({ result }) => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce(result);

    const html = renderToStaticMarkup(
      await AgentDetailPage({
        params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      }),
    );

    expect(html).toContain("Authentication required");
    expect(html).toContain("Authentication is required.");
    expect(html).not.toContain(result.code);
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
    expect(mocks.getActiveAgentForUser).not.toHaveBeenCalled();
    expect(mocks.createDatabaseConnection).not.toHaveBeenCalled();
    expect(mocks.listPendingApprovalsForUserAgent).not.toHaveBeenCalled();
    expect(mocks.listAgentBackupsForUser).not.toHaveBeenCalled();
    expect(mocks.listAgentEventFeedForUser).not.toHaveBeenCalled();
    expect(mocks.getAssignedManualRunnerStatusForUserAgent).not.toHaveBeenCalled();
  });

  it("renders agent backup status and restore controls without artifact internals", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentBackupsForUser.mockResolvedValueOnce([
      backupSummary({
        id: "00000000-0000-4000-8000-000000000267",
        status: "ready",
        createdAt: "2026-07-06T05:10:00.000Z",
        canRestore: true,
      }),
      backupSummary({
        id: "00000000-0000-4000-8000-000000000268",
        status: "failed",
        createdAt: "2026-07-06T05:11:00.000Z",
      }),
      backupSummary({
        id: "00000000-0000-4000-8000-000000000269",
        status: "restored",
        createdAt: "2026-07-06T05:12:00.000Z",
        restoredAt: "2026-07-06T05:13:00.000Z",
      }),
    ]);

    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Backups");
    expect(html).toContain("3 listed");
    expect(html).toContain("Create backup");
    expect(html).toContain("Restore backup");
    expect(html).toContain("ready");
    expect(html).toContain("failed");
    expect(html).toContain("restored");
    expect(html).toContain("2026-07-06T05:10:00.000Z");
    expect(html).toContain("2026-07-06T05:13:00.000Z");
    expect(html).toContain("00000000-0000-4000-8000-000000000267");
    expect(html).not.toContain("s3://");
    expect(html).not.toContain("agentbay-backups");
    expect(html).not.toContain("manifestJson");
    expect(html).not.toContain("storageUri");
    expect(html).not.toContain("secretReferences");
    expect(html).not.toContain("sk-or-v1-backup-secret");
    expect(mocks.listAgentBackupsForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
      "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    );
  });

  it("keeps detail record visible when backup status cannot be loaded", async () => {
    const { AgentBackupListPersistenceError } = await import("@/src/server/backups/list-backups");
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentBackupsForUser.mockRejectedValueOnce(new AgentBackupListPersistenceError());

    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Backup status could not be loaded.");
    expect(html).toContain("Configuration");
    expect(html).toContain("Activity");
    expect(html).not.toContain("postgres://");
  });

  it("renders safe operational alerts on the agent detail page", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(
      detailAgent({
        status: "error",
        statusReason:
          "Unhandled failure before retry\n    at run (/app/worker.ts:10:2)\npostgres://user:pass@localhost/db",
      }),
    );
    mocks.listPendingApprovalsForUserAgent.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        agentName: "Research Agent",
        agentHref: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        title: "Review outbound message",
        description: "Approve the drafted Telegram summary before it is sent.",
        status: "pending",
        requestedBy: "fake-runner",
        payloadSummary: "Payload details unavailable.",
        createdAt: "2026-07-04T08:15:00.000Z",
        expiresAt: "2026-07-04T09:15:00.000Z",
      },
    ]);
    mocks.listAgentEventFeedForUser.mockResolvedValueOnce({
      ok: true,
      page: {
        events: [
          activityEvent({
            id: "00000000-0000-4000-8000-000000000611",
            type: "agent.error",
            message:
              'Agent "Research Agent" failed with token=stored-for-downstream and stack details.',
            createdAt: "2026-07-04T08:30:00.000Z",
          }),
        ],
        nextCursor: null,
      },
    });

    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Operational alerts");
    expect(html).toContain("3 active");
    expect(html).toContain("Agent is in error");
    expect(html).toContain("Approval expired");
    expect(html).toContain("Agent error");
    expect(html).toContain("Sensitive details omitted.");
    expect(html).toContain("No assigned manual runner state is available");
    const alertPanelHtml = html.slice(
      html.indexOf('class="operational-alert-panel"'),
      html.indexOf('class="runtime-log-panel"'),
    );

    expect(alertPanelHtml).not.toContain("postgres://");
    expect(alertPanelHtml).not.toContain("token=stored-for-downstream");
    expect(alertPanelHtml).not.toContain("/app/worker.ts");
    expect(alertPanelHtml).not.toContain("payload_json");
  });

  it("renders assigned manual runner details and offline alerts safely", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.getAssignedManualRunnerStatusForUserAgent.mockResolvedValueOnce({
      name: "Remote Runner",
      kind: "manual_vps",
      endpointHost: "runner.example.com",
      status: "offline",
      capacity: capacity({ runningAgents: 1, maxAgents: 1, blocker: "runner_capacity_reached" }),
      version: "agentbay-runner/1.2.3",
      lastSeenAt: "2026-07-05T01:31:00.000Z",
      updatedAt: "2026-07-05T01:30:00.000Z",
      assignmentNotice: "This agent is assigned to Remote Runner.",
      alertState: "offline",
      alertMessage:
        "Assigned runner is inactive or unreachable. Check the runner host and service before restarting work.",
    });

    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Assigned runner");
    expect(html).toContain("Remote Runner");
    expect(html).toContain("This agent is assigned to Remote Runner.");
    expect(html).toContain("manual_vps");
    expect(html).toContain("runner.example.com");
    expect(html).toContain("offline");
    expect(html).toContain("1 / 1 agent running");
    expect(html).toContain("Runner capacity reached");
    expect(html).toContain("agentbay-runner/1.2.3");
    expect(html).toContain("2026-07-05T01:31:00.000Z");
    expect(html).toContain("2026-07-05T01:30:00.000Z");
    expect(html).toContain("Runner is offline");
    expect(html).toContain("Assigned runner is inactive or unreachable.");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("runner_id");
    expect(html).not.toContain("00000000-0000-4000-8000-000000000901");
    expect(html).not.toContain("https://user:password@runner.example.com");
    expect(html).not.toContain("TOKEN=stored-for-downstream");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("/app/worker.ts");
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("tokenHash");
    expect(html).not.toContain("cpuPercent");
  });

  it("renders assigned cloud runner details safely", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.getAssignedManualRunnerStatusForUserAgent.mockResolvedValueOnce({
      name: "Provisioned Cloud Runner",
      kind: "digitalocean",
      endpointHost: "cloud-runner.example.com",
      status: "online",
      capacity: capacity({
        runningAgents: 2,
        maxAgents: 5,
        cpuUsedPercent: null,
        memoryUsedMb: null,
        memoryTotalMb: null,
        diskUsedMb: null,
        diskTotalMb: null,
      }),
      version: "agentbay-runner/3.0.0",
      lastSeenAt: "2026-07-06T01:31:00.000Z",
      updatedAt: "2026-07-06T01:30:00.000Z",
      assignmentNotice: "This agent is assigned to Provisioned Cloud Runner.",
      alertState: null,
      alertMessage: null,
    });

    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Assigned runner");
    expect(html).toContain("Provisioned Cloud Runner");
    expect(html).toContain("digitalocean");
    expect(html).toContain("cloud-runner.example.com");
    expect(html).toContain("online");
    expect(html).toContain("2 / 5 agents running");
    expect(html).toContain("Not reported");
    expect(html).toContain("agentbay-runner/3.0.0");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("registrationToken");
    expect(html).not.toContain("agb_reg_");
    expect(html).not.toContain("agb_run_");
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("tokenHash");
    expect(html).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
  });

  it("renders persisted pending approvals on the agent detail page without raw payload details", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listPendingApprovalsForUserAgent.mockResolvedValueOnce([
      {
        id: "00000000-0000-4000-8000-000000000511",
        agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        agentName: "Research Agent",
        agentHref: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        title: "Review outbound message",
        description: "Approve the drafted Telegram summary before it is sent.",
        status: "pending",
        requestedBy: "fake-runner",
        payloadSummary:
          "Source: fake_runner; Action: telegram.send_message; Destination: Demo Telegram channel; Summary: Daily operations summary is ready for review.",
        createdAt: "2026-07-04T08:15:00.000Z",
        expiresAt: "2026-07-04T09:15:00.000Z",
      },
    ]);
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Pending approvals");
    expect(html).toContain("1 pending");
    expect(html).toContain("Review outbound message");
    expect(html).toContain("Approve the drafted Telegram summary before it is sent.");
    expect(html).toContain("pending");
    expect(html).toContain("fake-runner");
    expect(html).toContain("Payload summary");
    expect(html).toContain("Action: telegram.send_message");
    expect(html).toContain("Daily operations summary is ready for review.");
    expect(html).toContain("Approve");
    expect(html).toContain("Deny");
    expect(html).toContain("2026-07-04T08:15:00.000Z");
    expect(html).toContain("2026-07-04T09:15:00.000Z");
    expect(html).not.toContain("payload_json");
    expect(html).not.toContain("approval-secret-token");
    expect(html).not.toContain("postgres://");
  });

  it("renders agent detail activity newest-first with safe event fields and pagination", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeedForUser.mockResolvedValueOnce({
      ok: true,
      page: {
        events: [
          activityEvent({
            id: "00000000-0000-4000-8000-000000000303",
            type: "agent.stop_completed",
            message: 'Stop completed for agent "Research Agent".',
            metadata: {
              fromStatus: "running",
              toStatus: "stopped",
              internalNote: "raw value should not render without summary",
            },
            metadataSummary: "running -> stopped",
            createdAt: "2026-07-04T06:10:00.000Z",
          }),
          activityEvent({
            id: "00000000-0000-4000-8000-000000000301",
            type: "agent.created",
            message: 'Created agent "Research Agent".',
            metadata: {
              templateKey: "research_agent",
              status: "stopped",
            },
            metadataSummary: "Template: research_agent; Status: stopped",
            createdAt: "2026-07-04T05:00:00.000Z",
          }),
        ],
        nextCursor: "next cursor",
      },
    });
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html.indexOf("Stop completed for agent")).toBeLessThan(html.indexOf("Created agent"));
    expect(html).toContain("agent.stop_completed");
    expect(html).toContain("agent.created");
    expect(html).toContain("Jane Operator");
    expect(html).toContain("running -&gt; stopped");
    expect(html).toContain("Template: research_agent; Status: stopped");
    expect(html).toContain(
      'href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774?activityCursor=next%20cursor"',
    );
    expect(html).toContain("Older activity");
    expect(html).not.toContain("actorUserId");
    expect(html).not.toContain("00000000-0000-4000-8000-000000000101");
    expect(html).not.toContain("raw value should not render without summary");
  });

  it("renders older detail activity pagination with a newest-page link", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeedForUser.mockResolvedValueOnce({
      ok: true,
      page: {
        events: [],
        nextCursor: null,
      },
    });
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      searchParams: Promise.resolve({ activityCursor: "older-cursor" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No older activity");
    expect(html).toContain("There are no older persisted events for this agent.");
    expect(html).toContain('href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774"');
    expect(html).toContain("Newest activity");
    expect(mocks.listAgentEventFeedForUser).toHaveBeenCalledWith({
      db: {},
      userId: APPLICATION_USER_ID,
      agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
      cursor: "older-cursor",
      limit: 10,
    });
  });

  it("keeps the detail record visible when activity cannot be loaded", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeedForUser.mockRejectedValueOnce(
      new Error("postgres://user:pass@localhost/db"),
    );
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Agent activity could not be loaded.");
    expect(html).not.toContain("postgres://");
  });

  it("keeps detail record, config, logs, and activity visible when agent approvals cannot be loaded", async () => {
    const { AgentApprovalPersistenceError } = await import(
      "@/src/server/approvals/agent-approvals"
    );
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    mocks.listPendingApprovalsForUserAgent.mockRejectedValueOnce(
      new AgentApprovalPersistenceError(),
    );
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Configuration");
    expect(html).toContain("Latest log summaries");
    expect(html).toContain("Activity");
    expect(html).toContain("No activity yet");
    expect(html).toContain("Pending approvals could not be loaded.");
    expect(html).not.toContain("Approval request failed.");
    expect(html).not.toContain("postgres://");
  });

  it("renders a safe detail activity error for repeated cursor parameters", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(detailAgent());
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      searchParams: Promise.resolve({ activityCursor: ["first", "second"] }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Agent activity could not be loaded.");
    expect(mocks.listAgentEventFeedForUser).not.toHaveBeenCalled();
  });

  it("renders not found when agent detail lookup has no active record", async () => {
    mocks.getActiveAgentForUser.mockResolvedValueOnce(null);

    await expect(
      AgentDetailPage({
        params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("renders safe detail feedback when persisted agent detail cannot be loaded", async () => {
    const { AgentDetailPersistenceError } = await import("@/src/server/agents/list-agents");
    mocks.getActiveAgentForUser.mockRejectedValueOnce(new AgentDetailPersistenceError());
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Agent record could not be loaded.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("Agent detail failed.");
  });

  it("renders registered runner controls in settings without raw secret fields", async () => {
    mocks.listSettingsRunnerManagementSummariesForUser.mockResolvedValueOnce([
      {
        managementId: "00000000-0000-4000-8000-000000000133",
        name: "Settings Runner",
        kind: "manual_vps",
        endpointHost: "runner-settings.example.com",
        status: "offline",
        capacity: capacity({ runningAgents: 1, maxAgents: 1, blocker: "runner_capacity_reached" }),
        version: null,
        lastSeenAt: "2026-07-05T03:00:00.000Z",
        updatedAt: "2026-07-05T03:01:00.000Z",
      },
    ]);
    const element = await SettingsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Workspace settings");
    expect(html).toContain('class="settings-page"');
    expect(html).toContain('class="settings-fleet-overview"');
    expect(html).toContain("Runner fleet");
    expect(html).toContain('class="settings-runner-workspace"');
    expect(html).toContain('class="settings-runner-inventory"');
    expect(html).toContain("Runner management");
    expect(html).toContain('class="settings-configuration-notes"');
    expect(html).toContain("Workspace configuration");
    expect(html.indexOf("settings-fleet-title")).toBeLessThan(
      html.indexOf("settings-runners-title"),
    );
    expect(html.indexOf("settings-runners-title")).toBeLessThan(
      html.indexOf("Workspace configuration"),
    );
    expect(html).toContain("Registered runners");
    expect(html).toContain("1 listed");
    expect(html).toContain("Settings Runner");
    expect(html).toContain("runner-settings.example.com");
    expect(html).toContain("offline");
    expect(html).toContain("1 / 1 agent running");
    expect(html).toContain("Runner capacity reached");
    expect(html).toContain("Not reported");
    expect(html).toContain("2026-07-05T03:00:00.000Z");
    expect(html).toContain("Billing");
    expect(html).toContain(
      "Secret values and credential storage are not accepted by the current app.",
    );
    expect(html).toContain("Create Registration Token");
    expect(html).toContain("Create Token");
    expect(html).toContain("Rotate Credential");
    expect(html).toContain("Revoke Credential");
    expect(html).not.toContain("agb_reg_");
    expect(html).not.toContain("agb_run_");
    expect(html).not.toContain("credentialHash");
    expect(html).not.toContain("tokenHash");
    expect(html).not.toContain("runnerId");
    expect(html).not.toContain("00000000-0000-4000-8000-000000000133");
    expect(html).not.toContain("cpuPercent");
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
    expect(mocks.listSettingsRunnerManagementSummariesForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
    );
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).toHaveBeenCalledWith(
      APPLICATION_USER_ID,
    );
    expect(mocks.getCostEstimatesForUser).toHaveBeenCalledWith(APPLICATION_USER_ID);
  });

  it.each(PAGE_AUTH_FAILURES)("renders a safe settings boundary for $name", async ({ result }) => {
    mocks.requireConfiguredApplicationUser.mockResolvedValueOnce(result);

    const element = await SettingsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Authentication required");
    expect(html).not.toContain("Create Registration Token");
    expect(mocks.requireConfiguredApplicationUser).toHaveBeenCalledOnce();
    expect(mocks.listSettingsRunnerManagementSummariesForUser).not.toHaveBeenCalled();
    expect(mocks.listCloudRunnerProvisioningSummariesForUser).not.toHaveBeenCalled();
    expect(mocks.getCostEstimatesForUser).not.toHaveBeenCalled();
  });
});

type DetailAgent = {
  id: string;
  name: string;
  templateKey: string;
  templateVersion: string;
  templateLabel: string;
  templateSnapshot: {
    key: "research_agent";
    version: string;
    name: string;
    description: string;
    defaultTools: string[];
    defaultSchedule: "Manual";
    defaultSystemPrompt: string;
    requiredIntegrations: string[];
  };
  status: string;
  statusReason: string | null;
  href: string;
  createdAt: string;
  updatedAt: string;
  config: {
    systemPrompt: string;
    modelProvider: string;
    modelName: string;
    maxDailySpendCents: number;
    scheduleMode: "manual" | "cron";
    scheduleCron: string | null;
    timezone: string;
    updatedAt: string;
  };
};

function detailAgent(overrides: Partial<DetailAgent> = {}): DetailAgent {
  return {
    id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    name: "Research Agent",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    templateLabel: "Research Agent",
    templateSnapshot: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      description:
        "Tracks a research question, gathers source notes, and produces concise summaries for later review.",
      defaultTools: ["Web search", "Notes", "Summaries"],
      defaultSchedule: "Manual",
      defaultSystemPrompt:
        "You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.",
      requiredIntegrations: [],
    },
    status: "stopped",
    statusReason: null,
    href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
    createdAt: "2026-07-03T05:00:00.000Z",
    updatedAt: "2026-07-03T05:30:00.000Z",
    config: {
      systemPrompt: "Keep research concise.",
      modelProvider: "openai",
      modelName: "gpt-4.1-mini",
      maxDailySpendCents: 200,
      scheduleMode: "manual",
      scheduleCron: null,
      timezone: "UTC",
      updatedAt: "2026-07-03T05:31:00.000Z",
    },
    ...overrides,
  };
}

function activityEvent(overrides: Partial<AgentEventDto> = {}): AgentEventDto {
  return {
    id: "00000000-0000-4000-8000-000000000301",
    agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    actor: {
      userId: "00000000-0000-4000-8000-000000000101",
      displayName: "Jane Operator",
    },
    type: "agent.created",
    message: 'Created agent "Research Agent".',
    metadata: {},
    metadataSummary: null,
    createdAt: "2026-07-04T05:00:00.000Z",
    ...overrides,
  };
}

function backupSummary(overrides: Partial<AgentBackupSummary> = {}): AgentBackupSummary {
  return {
    id: "00000000-0000-4000-8000-000000000267",
    agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    status: "ready",
    createdAt: "2026-07-06T05:10:00.000Z",
    restoredAt: null,
    canRestore: false,
    ...overrides,
  };
}
