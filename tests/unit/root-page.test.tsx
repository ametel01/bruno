import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import AgentsPage from "@/app/agents/page";
import DashboardPage from "@/app/dashboard/page";
import Home from "@/app/page";
import SettingsPage from "@/app/settings/page";

const mocks = vi.hoisted(() => ({
  listActiveAgentsForDevelopmentUser: vi.fn(),
}));

vi.mock("@/src/server/agents/list-agents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/src/server/agents/list-agents")>();

  return {
    ...actual,
    listActiveAgentsForDevelopmentUser: mocks.listActiveAgentsForDevelopmentUser,
  };
});

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
  }),
}));

describe("product shell routes", () => {
  afterEach(() => {
    mocks.listActiveAgentsForDevelopmentUser.mockReset();
  });

  it("renders the root product dashboard shell", () => {
    const html = renderToStaticMarkup(createElement(Home));

    expect(html).toContain("AgentBay");
    expect(html).toContain('href="/dashboard"');
    expect(html).toContain("Operational dashboard");
    expect(html).toContain("No agents configured");
  });

  it("renders the dashboard empty operational state without fake records", () => {
    const html = renderToStaticMarkup(createElement(DashboardPage));

    expect(html).toContain("No agents configured");
    expect(html).toContain("No persisted agent table or records are queried");
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
    expect(html).not.toContain("disabled");
  });

  it("renders persisted agents with stable identity and links", async () => {
    mocks.listActiveAgentsForDevelopmentUser.mockResolvedValueOnce([
      {
        id: "3e47bed7-b58f-4394-93c0-01e3d1e51774",
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        href: "/agents/3e47bed7-b58f-4394-93c0-01e3d1e51774",
        createdAt: "2026-07-03T05:00:00.000Z",
      },
    ]);
    const element = await AgentsPage();
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Research Agent");
    expect(html).toContain("research_agent");
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

  it("renders placeholder detail for arbitrary agent IDs without a record lookup", async () => {
    const element = await AgentDetailPage({
      params: Promise.resolve({ agentId: "test-agent" }),
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("test-agent");
    expect(html).toContain("No record lookup is performed");
    expect(html).toContain("None in Milestone 0");
  });

  it("renders future-facing settings placeholders only", () => {
    const html = renderToStaticMarkup(createElement(SettingsPage));

    expect(html).toContain("Workspace settings");
    expect(html).toContain("Billing");
    expect(html).toContain("Secret values and credential storage are not accepted");
  });
});
