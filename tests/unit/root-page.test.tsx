import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import AgentsPage from "@/app/agents/page";
import DashboardPage from "@/app/dashboard/page";
import Home from "@/app/page";
import SettingsPage from "@/app/settings/page";

const mocks = vi.hoisted(() => ({
  getActiveAgentForDevelopmentUser: vi.fn(),
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

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("product shell routes", () => {
  afterEach(() => {
    mocks.getActiveAgentForDevelopmentUser.mockReset();
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

  it("renders persisted agent detail records", async () => {
    mocks.getActiveAgentForDevelopmentUser.mockResolvedValueOnce({
      id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
      name: "Research Agent",
      templateKey: "research_agent",
      templateLabel: "Research Agent",
      status: "stopped",
      statusReason: "Waiting for setup.",
      href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
      createdAt: "2026-07-03T05:00:00.000Z",
      updatedAt: "2026-07-03T05:30:00.000Z",
    });
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
    expect(html).not.toContain("No record lookup is performed");
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
