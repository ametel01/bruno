import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import AgentsPage from "@/app/agents/page";
import DashboardPage, { DashboardContent } from "@/app/dashboard/page";
import Home from "@/app/page";
import SettingsPage from "@/app/settings/page";
import type { AgentEventDto } from "@/src/server/events/agent-events";

const mocks = vi.hoisted(() => ({
  closeDashboardConnection: vi.fn(),
  createDatabaseConnection: vi.fn(),
  getActiveAgentForDevelopmentUser: vi.fn(),
  listAgentEventFeed: vi.fn(),
  listLatestAgentActivity: vi.fn(),
  listActiveAgentsForDevelopmentUser: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/src/server/agents/list-agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/list-agents")>();

  return {
    ...actual,
    getActiveAgentForDevelopmentUser: mocks.getActiveAgentForDevelopmentUser,
    listActiveAgentsForDevelopmentUser: mocks.listActiveAgentsForDevelopmentUser,
  };
});

vi.mock("@/src/server/db/client", () => ({
  createDatabaseConnection: mocks.createDatabaseConnection,
}));

vi.mock("@/src/server/events/agent-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/events/agent-events")>();

  return {
    ...actual,
    listAgentEventFeed: mocks.listAgentEventFeed,
    listLatestAgentActivity: mocks.listLatestAgentActivity,
  };
});

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("product shell routes", () => {
  beforeEach(() => {
    mocks.createDatabaseConnection.mockReturnValue({
      db: {},
      close: mocks.closeDashboardConnection,
    });
    mocks.closeDashboardConnection.mockResolvedValue(undefined);
    mocks.listLatestAgentActivity.mockResolvedValue({
      ok: true,
      page: {
        events: [],
        nextCursor: null,
      },
    });
    mocks.listAgentEventFeed.mockResolvedValue({
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
    mocks.getActiveAgentForDevelopmentUser.mockReset();
    mocks.listAgentEventFeed.mockReset();
    mocks.listLatestAgentActivity.mockReset();
    mocks.listActiveAgentsForDevelopmentUser.mockReset();
    mocks.notFound.mockClear();
  });

  it("renders the root product dashboard shell", () => {
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("AgentBay");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Operational dashboard");
    expect(html).toContain("No agent records");
  });

  it("renders the dashboard empty persisted-agent state without fake records", async () => {
    mocks.listActiveAgentsForDevelopmentUser.mockResolvedValueOnce([]);
    const element = await DashboardPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No agent records");
    expect(html).toContain("No activity yet");
    expect(html).toContain("Active persisted records are read from the database.");
    expect(html).toContain(
      "Start, Stop, Restart, and Delete use deterministic fake lifecycle controls.",
    );
    expect(html).not.toContain("lifecycle verification waits");
    expect(html).not.toContain("Delete controls wait");
    expect(html).not.toContain("No persisted agent table or records are queried");
  });

  it("renders persisted agents on the dashboard with lifecycle controls", async () => {
    mocks.listActiveAgentsForDevelopmentUser.mockResolvedValueOnce([
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
              templateLabel: "Research Agent",
              status: "running",
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
              templateLabel: "Research Agent",
              status: "stopped",
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

  it("renders the agents empty database-backed list state and create form", async () => {
    mocks.listActiveAgentsForDevelopmentUser.mockResolvedValueOnce([]);
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("No agent records");
    expect(html).toContain("Create agent");
    expect(html).toContain("Research Agent");
    expect(html).toContain("inbox_triage_agent");
    expect(html).not.toContain("Create agent in Milestone 1");
  });

  it("renders persisted agents with stable identity and links", async () => {
    mocks.listActiveAgentsForDevelopmentUser.mockResolvedValueOnce([
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
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("stopped");
    expect(html).toContain("3e47bed7-b58f-4394-93c0-01e3d1e51774");
    expect(html).toContain('href="/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774"');
  });

  it("renders safe feedback when persisted agents cannot be loaded", async () => {
    const { AgentListPersistenceError } = await import("@/src/server/agents/list-agents");
    mocks.listActiveAgentsForDevelopmentUser.mockRejectedValueOnce(new AgentListPersistenceError());
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Agent records could not be loaded.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("Agent list failed.");
  });

  it("renders persisted agent detail records with the empty activity state", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(
      detailAgent({ statusReason: "Waiting for setup." }),
    );
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("stopped");
    expect(html).toContain("research_agent");
    expect(html).toContain("2026-07-03T05:00:00.000Z");
    expect(html).toContain("2026-07-03T05:30:00.000Z");
    expect(html).toContain("Waiting for setup.");
    expect(html).toContain("Activity");
    expect(html).toContain("No activity yet");
    expect(html).toContain("0 shown");
    expect(html).not.toContain("No record lookup is performed");
    expect(mocks.listAgentEventFeed).toHaveBeenCalledWith({
      db: {},
      agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
      cursor: null,
      limit: 10,
    });
    expect(mocks.closeDashboardConnection).toHaveBeenCalledOnce();
  });

  it("renders agent detail activity newest-first with safe event fields and pagination", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeed.mockResolvedValueOnce({
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
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeed.mockResolvedValueOnce({
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
    expect(mocks.listAgentEventFeed).toHaveBeenCalledWith({
      db: {},
      agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
      cursor: "older-cursor",
      limit: 10,
    });
  });

  it("keeps the detail record visible when activity cannot be loaded", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(detailAgent());
    mocks.listAgentEventFeed.mockRejectedValueOnce(new Error("postgres://user:pass@localhost/db"));
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Agent activity could not be loaded.");
    expect(html).not.toContain("postgres://");
  });

  it("renders a safe detail activity error for repeated cursor parameters", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(detailAgent());
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      searchParams: Promise.resolve({ activityCursor: ["first", "second"] }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("Agent activity could not be loaded.");
    expect(mocks.listAgentEventFeed).not.toHaveBeenCalled();
  });

  it("renders not found when agent detail lookup has no active record", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce(null);

    await expect(
      AgentDetailPage({
        params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledOnce();
  });

  it("renders safe detail feedback when persisted agent detail cannot be loaded", async () => {
    const { AgentDetailPersistenceError } = await import("@/src/server/agents/list-agents");
    mocks.getActiveAgentForDevelopmentUser.mockRejectedValueOnce(new AgentDetailPersistenceError());
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "3e47bed7-b58f-4394-93c0-01e3d1e51774" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Agent record could not be loaded.");
    expect(html).not.toContain("postgres://");
    expect(html).not.toContain("Agent detail failed.");
  });

  it("renders future-facing settings placeholders only", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));

    expect(html).toContain("Workspace settings");
    expect(html).toContain("Billing");
    expect(html).toContain(
      "Secret values and credential storage are not accepted by the current app.",
    );
  });
});

type DetailAgent = {
  id: string;
  name: string;
  templateKey: string;
  templateLabel: string;
  status: string;
  statusReason: string | null;
  href: string;
  createdAt: string;
  updatedAt: string;
};

function detailAgent(overrides: Partial<DetailAgent> = {}): DetailAgent {
  return {
    id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
    name: "Research Agent",
    templateKey: "research_agent",
    templateLabel: "Research Agent",
    status: "stopped",
    statusReason: null,
    href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
    createdAt: "2026-07-03T05:00:00.000Z",
    updatedAt: "2026-07-03T05:30:00.000Z",
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
