import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentDetailPage from "@/app/agents/[agentId]/page";
import AgentsPage from "@/app/agents/page";
import DashboardPage from "@/app/dashboard/page";
import Home from "@/app/page";
import SettingsPage from "@/app/settings/page";

describe("product shell routes", () => {
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

  it("renders the agents empty list state with disabled future creation", () => {
    const html = renderToStaticMarkup(createElement(AgentsPage));

    expect(html).toContain("No agent records");
    expect(html).toContain("disabled");
    expect(html).toContain("Create agent in Milestone 1");
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
