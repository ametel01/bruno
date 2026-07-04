import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const createdAgentIds = new Set<string>();

test.afterEach(async () => {
  const agentIds = [...createdAgentIds];
  createdAgentIds.clear();

  if (agentIds.length > 0) {
    await deleteCreatedAgents(agentIds);
  }
});

const shellRoutes = [
  { path: "/", heading: "Operational dashboard" },
  { path: "/dashboard", heading: "Operational dashboard" },
  { path: "/agents", heading: "Agent inventory" },
  { path: "/settings", heading: "Workspace settings" },
] as const;

for (const route of shellRoutes) {
  test(`${route.path} renders the AgentBay shell`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.getByRole("link", { name: "AgentBay dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Health JSON" })).toHaveAttribute(
      "href",
      "/health",
    );
  });
}

test("/health returns reachable database JSON in the browser", async ({ page }) => {
  await page.goto("/health");

  await expect(page.locator("body")).toContainText('"status":"ok"');
  await expect(page.locator("body")).toContainText('"database":"reachable"');
});

test.describe
  .serial("approval persistence surfaces", () => {
    test("/dashboard shows persisted pending approvals for active agents", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "dashboard approval persistence proof runs once on desktop");

      const name = `Approval Queue Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);
      const createdAt = "2026-07-04T08:15:00.000Z";
      const expiresAt = "2026-07-04T09:15:00.000Z";

      await pinDevelopmentUserToAgent(created.id);
      await insertPendingApproval(created.id, {
        title: "Review outbound message",
        description: "Approve the drafted Telegram summary before it is sent.",
        createdAt,
        expiresAt,
      });

      await page.goto("/dashboard");

      const approvalPanel = page.locator(".approval-panel");
      await expect(approvalPanel).toContainText("Pending approvals");
      await expect(approvalPanel).toContainText("1 pending");
      await expect(approvalPanel.getByRole("link", { name })).toHaveAttribute(
        "href",
        `/agents/${created.id}`,
      );
      await expect(approvalPanel).toContainText("Review outbound message");
      await expect(approvalPanel).toContainText(
        "Approve the drafted Telegram summary before it is sent.",
      );
      await expect(approvalPanel.locator(".status-pill", { hasText: "pending" })).toBeVisible();
      await expect(approvalPanel).toContainText(createdAt);
      await expect(approvalPanel).toContainText(expiresAt);
      await expect(approvalPanel).not.toContainText("payload_json");
      await expect(approvalPanel).not.toContainText("stored-for-downstream-not-rendered");
      await expect(approvalPanel).not.toContainText("postgres://");
    });

    test("/dashboard approve resolves a pending approval and shows approval activity", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "dashboard approval decision proof runs once on desktop");

      const name = `Approve Queue Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);

      await pinDevelopmentUserToAgent(created.id);
      await insertPendingApproval(created.id, {
        title: "Review dashboard approval",
        description: "Approve this queued action before it continues.",
        createdAt: "2026-07-04T08:45:00.000Z",
        expiresAt: "2026-07-04T09:45:00.000Z",
      });

      await page.goto("/dashboard");

      const approvalPanel = page.locator(".approval-panel");
      const approvalItem = approvalPanel.locator(".approval-item", {
        hasText: "Review dashboard approval",
      });
      await expect(approvalItem).toContainText(name);
      await approvalItem.getByRole("button", { name: "Approve" }).click();

      await expect(approvalPanel).not.toContainText("Review dashboard approval");
      const dashboardActivity = page.locator(".activity-feed-panel");
      await expect(dashboardActivity).toContainText("approval.approved");
      await expect(dashboardActivity).toContainText(
        'Approval "Review dashboard approval" approved for agent',
      );
      await expect(dashboardActivity).toContainText("Approval Status: approved");
      await expect(dashboardActivity).not.toContainText("payload_json");
      await expect(dashboardActivity).not.toContainText("stored-for-downstream-not-rendered");
      await expect(dashboardActivity).not.toContainText("postgres://");
    });

    test("/dashboard approve failure keeps the pending row readable with safe feedback", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "dashboard approval failure proof runs once on desktop");

      const name = `Approve Error Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);

      await pinDevelopmentUserToAgent(created.id);
      await insertPendingApproval(created.id, {
        title: "Review failed approval",
        description: "This queued action should remain pending after an unsafe server failure.",
        createdAt: "2026-07-04T08:55:00.000Z",
        expiresAt: "2026-07-04T09:55:00.000Z",
      });
      await page.route("**/api/approvals/*/approve", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          status: 500,
          body: JSON.stringify({
            error: {
              code: "approval_approve_failed",
              message: "postgres://user:pass@localhost/db payload_json stack trace",
            },
          }),
        });
      });

      await page.goto("/dashboard");

      const approvalPanel = page.locator(".approval-panel");
      const approvalItem = approvalPanel.locator(".approval-item", {
        hasText: "Review failed approval",
      });
      await approvalItem.getByRole("button", { name: "Approve" }).click();

      await expect(approvalItem.getByRole("status")).toContainText(
        "Approval could not be approved.",
      );
      await expect(approvalItem).toContainText("Review failed approval");
      await expect(approvalItem).not.toContainText("postgres://");
      await expect(approvalItem).not.toContainText("payload_json");
    });

    test("/dashboard denies a pending approval and shows decision activity", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "dashboard approval denial proof runs once on desktop");

      const name = `Deny Approval Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);
      const createdAt = "2026-07-04T08:35:00.000Z";
      const expiresAt = "2026-07-04T09:35:00.000Z";

      await pinDevelopmentUserToAgent(created.id);
      const approvalId = await insertPendingApproval(created.id, {
        title: "Deny outbound message",
        description: "Deny the drafted Telegram summary before it is sent.",
        createdAt,
        expiresAt,
      });

      await page.goto("/dashboard");

      const approvalPanel = page.locator(".approval-panel");
      const approvalItem = approvalPanel.locator(".approval-item", {
        hasText: "Deny outbound message",
      });
      await expect(approvalItem).toContainText("pending");
      await page.route(`**/api/approvals/${approvalId}/deny`, async (route) => {
        await route.fulfill({
          contentType: "application/json",
          status: 500,
          body: JSON.stringify({
            error: {
              code: "approval_deny_failed",
              message: "postgres://user:password@127.0.0.1/db raw payload_json stack",
            },
          }),
        });
      });
      await approvalItem.getByRole("button", { name: "Deny" }).click();
      await expect(approvalItem.getByRole("status")).toContainText("Approval could not be denied.");
      await expect(approvalItem.getByRole("status")).not.toContainText("postgres://");
      await expect(approvalItem.getByRole("status")).not.toContainText("payload_json");
      await page.unroute(`**/api/approvals/${approvalId}/deny`);

      await approvalItem.getByRole("button", { name: "Deny" }).click();

      await expect(
        approvalPanel.locator(".approval-item", { hasText: "Deny outbound message" }),
      ).toHaveCount(0);
      const dashboardActivity = page.locator(".activity-feed-panel");
      await expect(dashboardActivity).toContainText("approval.denied");
      await expect(dashboardActivity).toContainText(
        'Denied approval "Deny outbound message" for agent',
      );
      await expect(dashboardActivity).toContainText("pending -> denied");
      await expect(dashboardActivity).not.toContainText("payload_json");
      await expect(dashboardActivity).not.toContainText("stored-for-downstream-not-rendered");
    });

    test("/agents/:agentId shows persisted pending approvals only for that agent", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "agent detail approval persistence proof runs once on desktop");

      const selectedName = `Detail Approval Agent ${testInfo.project.name}`;
      const otherName = `Other Detail Approval Agent ${testInfo.project.name}`;
      const selected = await createAgent(request, selectedName);
      const other = await createAgent(request, otherName);
      createdAgentIds.add(selected.id);
      createdAgentIds.add(other.id);
      const createdAt = "2026-07-04T08:25:00.000Z";
      const expiresAt = "2026-07-04T09:25:00.000Z";

      await pinDevelopmentUserToAgent(selected.id);
      await insertPendingApproval(selected.id, {
        title: "Review selected outbound message",
        description: "Approve this agent's drafted Telegram summary before it is sent.",
        createdAt,
        expiresAt,
      });
      await insertPendingApproval(other.id, {
        title: "Other agent approval should not render",
        description: "This pending approval belongs to a different agent.",
        createdAt: "2026-07-04T08:30:00.000Z",
        expiresAt: "2026-07-04T09:30:00.000Z",
      });

      await page.goto(`/agents/${selected.id}`);

      await expect(page.getByRole("heading", { name: selectedName })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Configuration" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Runtime logs", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible();
      const approvalPanel = page.locator(".approval-panel");
      await expect(approvalPanel).toContainText("Pending approvals");
      await expect(approvalPanel).toContainText("1 pending");
      await expect(approvalPanel).toContainText("Review selected outbound message");
      await expect(approvalPanel).toContainText(
        "Approve this agent's drafted Telegram summary before it is sent.",
      );
      await expect(approvalPanel.locator(".status-pill", { hasText: "pending" })).toBeVisible();
      await expect(approvalPanel).toContainText("fake-runner");
      await expect(approvalPanel).toContainText(createdAt);
      await expect(approvalPanel).toContainText(expiresAt);
      await expect(approvalPanel).not.toContainText("Other agent approval should not render");
      await expect(approvalPanel).not.toContainText(
        "This pending approval belongs to a different agent.",
      );
      await expect(approvalPanel).not.toContainText("payload_json");
      await expect(approvalPanel).not.toContainText("stored-for-downstream-not-rendered");
      await expect(approvalPanel).not.toContainText("postgres://");
    });

    test("Milestone 7 acceptance covers visibility, decisions, events, and duplicate conflicts", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(isMobile, "final Milestone 7 approval acceptance proof runs once on desktop");

      const name = `Milestone 7 Acceptance Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);

      await pinDevelopmentUserToAgent(created.id);
      const approvalToApproveId = await insertPendingApproval(created.id, {
        title: "Approve final acceptance action",
        description: "Approve this final Milestone 7 queued action.",
        createdAt: "2026-07-04T10:00:00.000Z",
        expiresAt: "2026-07-04T11:00:00.000Z",
      });
      const approvalToDenyId = await insertPendingApproval(created.id, {
        title: "Deny final acceptance action",
        description: "Deny this final Milestone 7 queued action.",
        createdAt: "2026-07-04T10:05:00.000Z",
        expiresAt: "2026-07-04T11:05:00.000Z",
      });

      await pinDevelopmentUserToAgent(created.id);
      await page.goto("/dashboard");
      const dashboardApprovalPanel = page.locator(".approval-panel");
      await expect(dashboardApprovalPanel).toContainText("Pending approvals");
      await expect(dashboardApprovalPanel.getByRole("link", { name }).first()).toHaveAttribute(
        "href",
        `/agents/${created.id}`,
      );
      await expect(dashboardApprovalPanel).toContainText("Approve final acceptance action");
      await expect(dashboardApprovalPanel).toContainText("Deny final acceptance action");
      await expect(dashboardApprovalPanel).not.toContainText("payload_json");
      await expect(dashboardApprovalPanel).not.toContainText("stored-for-downstream-not-rendered");
      await expect(dashboardApprovalPanel).not.toContainText("postgres://");

      await pinDevelopmentUserToAgent(created.id);
      await page.goto(`/agents/${created.id}`);
      const detailApprovalPanel = page.locator(".approval-panel");
      await expect(page.getByRole("heading", { name })).toBeVisible();
      await expect(detailApprovalPanel).toContainText("Pending approvals");
      await expect(detailApprovalPanel).toContainText("Approve final acceptance action");
      await expect(detailApprovalPanel).toContainText("Deny final acceptance action");
      await expect(detailApprovalPanel).not.toContainText("payload_json");
      await expect(detailApprovalPanel).not.toContainText("stored-for-downstream-not-rendered");
      await expect(detailApprovalPanel).not.toContainText("postgres://");

      await pinDevelopmentUserToAgent(created.id);
      await page.goto("/dashboard");
      await expectApprovalDecisionSuccess(
        request.post(`/api/approvals/${approvalToApproveId}/approve`),
        "approved",
        "approval.approved",
      );
      await pinDevelopmentUserToAgent(created.id);
      await page.reload();
      await expect(dashboardApprovalPanel).not.toContainText("Approve final acceptance action");
      await expectApprovalStatus(approvalToApproveId, "approved");
      await expectApprovalEventCounts(approvalToApproveId, { approved: 1, denied: 0 });

      await pinDevelopmentUserToAgent(created.id);
      await expectAlreadyResolvedConflict(
        request.post(`/api/approvals/${approvalToApproveId}/approve`),
        "approved",
      );
      await pinDevelopmentUserToAgent(created.id);
      await expectAlreadyResolvedConflict(
        request.post(`/api/approvals/${approvalToApproveId}/deny`),
        "approved",
      );
      await expectApprovalEventCounts(approvalToApproveId, { approved: 1, denied: 0 });

      await pinDevelopmentUserToAgent(created.id);
      await expectApprovalDecisionSuccess(
        request.post(`/api/approvals/${approvalToDenyId}/deny`),
        "denied",
        "approval.denied",
      );
      await pinDevelopmentUserToAgent(created.id);
      await page.reload();
      await expect(dashboardApprovalPanel).not.toContainText("Deny final acceptance action");
      await expectApprovalStatus(approvalToDenyId, "denied");
      await expectApprovalEventCounts(approvalToDenyId, { approved: 0, denied: 1 });

      await pinDevelopmentUserToAgent(created.id);
      await expectAlreadyResolvedConflict(
        request.post(`/api/approvals/${approvalToDenyId}/deny`),
        "denied",
      );
      await pinDevelopmentUserToAgent(created.id);
      await expectAlreadyResolvedConflict(
        request.post(`/api/approvals/${approvalToDenyId}/approve`),
        "denied",
      );
      await expectApprovalEventCounts(approvalToDenyId, { approved: 0, denied: 1 });

      const dashboardActivity = page.locator(".activity-feed-panel");
      await expect(dashboardActivity).toContainText("approval.approved");
      await expect(dashboardActivity).toContainText("approval.denied");
      await expect(dashboardActivity).not.toContainText("payload_json");
      await expect(dashboardActivity).not.toContainText("stored-for-downstream-not-rendered");
      await expect(dashboardActivity).not.toContainText("postgres://");

      await pinDevelopmentUserToAgent(created.id);
      await page.goto(`/agents/${created.id}`);
      await expect(page.locator(".approval-panel")).toContainText("No pending approvals");
      const detailActivity = page.locator(".activity-feed-panel:not(.activity-loading-state)");
      await expect(detailActivity).toContainText("approval.approved");
      await expect(detailActivity).toContainText("approval.denied");
      await expect(detailActivity).not.toContainText("payload_json");
      await expect(detailActivity).not.toContainText("stored-for-downstream-not-rendered");
      await expect(detailActivity).not.toContainText("postgres://");
    });
  });

test("/dashboard shows fake approvals generated by observing a running agent", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(isMobile, "fake approval generation dashboard proof runs once on desktop");

  const name = `Fake Approval Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  createdAgentIds.add(created.id);

  await page.goto(`/agents/${created.id}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status")).toContainText("Start requested.");
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(async () => {
    await pinDevelopmentUserToAgent(created.id);
    const logsResponse = await request.get(`/api/agents/${created.id}/logs`);
    expect(logsResponse.status()).toBe(200);
    const logsBody = (await logsResponse.json()) as { logs: { message: string }[] };
    expect(logsBody.logs.map((log) => log.message)).toContain("Checking task queue...");
  }).toPass({ timeout: 5_000 });

  await pinDevelopmentUserToAgent(created.id);
  await page.goto("/dashboard");

  const approvalPanel = page.locator(".approval-panel");
  await expect(approvalPanel).toContainText("Pending approvals");
  const generatedApproval = approvalPanel.locator(".approval-item", { hasText: name });
  await expect(generatedApproval.getByRole("link", { name })).toHaveAttribute(
    "href",
    `/agents/${created.id}`,
  );
  await expect(generatedApproval).toContainText(
    /Approve (Telegram message|research task|Gmail inbox access)/,
  );
  await expect(generatedApproval.locator(".status-pill", { hasText: "pending" })).toBeVisible();
  await expect(generatedApproval).not.toContainText("payload_json");
  await expect(generatedApproval).not.toContainText("token");
  await expect(generatedApproval).not.toContainText("postgres://");

  const dashboardActivity = page.locator(".activity-feed-panel");
  await expect(dashboardActivity).toContainText("approval.requested");
  await expect(dashboardActivity).toContainText("Source: fake_runner");
});

test("/agents creates Research Agent and persists it across read surfaces", async ({
  isMobile,
  page,
}) => {
  test.skip(isMobile, "final exact-name Milestone 1 smoke path runs once on desktop");

  const name = "Research Agent";

  await page.goto("/agents");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Template").selectOption("research_agent");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Agent created.");
  const agentLink = page.getByRole("link", { name });
  await expect(agentLink).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();
  const agentHref = await agentLink.getAttribute("href");
  expect(agentHref).toMatch(/^\/agents\/[0-9a-f-]+$/);
  trackAgentHref(agentHref);

  await page.reload();

  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Persisted agents" })).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();
  let dashboardActivity = page.locator(".activity-feed-panel");
  await expect(dashboardActivity).toContainText("Latest activity");
  await expect(dashboardActivity).toContainText("agent.created");
  await expect(dashboardActivity).toContainText(`Created agent "${name}".`);
  await expect(dashboardActivity).toContainText("Local development user");

  await page.reload();

  await expect(page.locator(".agent-list-panel").getByRole("link", { name })).toBeVisible();
  const dashboardAgentRow = page
    .getByRole("row", { name: new RegExp(`${name}.*Research Agent`) })
    .first();
  await expect(dashboardAgentRow).toContainText("stopped");
  await dashboardAgentRow.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status")).toContainText("Start requested.");
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(dashboardAgentRow.getByRole("button", { name: "Running" })).toBeDisabled();
  await expect(dashboardAgentRow.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(dashboardAgentRow.getByRole("button", { name: "Restart" })).toBeVisible();
  await dashboardAgentRow.getByRole("button", { name: "Restart" }).click();
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "restarting" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(dashboardAgentRow.getByRole("button", { name: "Restart" })).toBeVisible();
  await dashboardAgentRow.getByRole("button", { name: "Stop" }).click();
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(dashboardAgentRow.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expect(dashboardAgentRow.getByRole("button", { name: "Restart" })).toHaveCount(0);
  await expect(dashboardAgentRow.getByRole("button", { name: "Start" })).toBeVisible();
  await expect(dashboardAgentRow.getByRole("button", { name: "Simulate error" })).toBeVisible();
  await dashboardAgentRow.getByRole("button", { name: "Simulate error" }).click();
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "error" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(dashboardAgentRow.getByRole("button", { name: "Simulate error" })).toHaveCount(0);
  dashboardActivity = page.locator(".activity-feed-panel");
  await expect(dashboardActivity).toContainText("agent.error");
  await expect(dashboardActivity).toContainText(`Simulated error requested for agent "${name}".`);
  await expect(dashboardActivity).toContainText("stopped -> error");
  await expect(dashboardActivity).toContainText("Source: development_simulator");

  expect(agentHref).not.toBeNull();
  await page.goto(agentHref ?? "/agents/missing");
  await expect(page.getByRole("heading", { name })).toBeVisible();
  const detailRecord = page.locator(".placeholder-panel").filter({ hasText: "Agent record" });
  await expect(detailRecord.locator(".status-pill", { hasText: "error" })).toBeVisible();
  await expect(detailRecord).toContainText("research_agent");
  await expect(detailRecord).toContainText("Simulated error requested for development testing.");
  await expect(detailRecord).toContainText("Created");
  await expect(detailRecord).toContainText("Updated");
  await expect(page.getByRole("button", { name: "Start" })).toBeVisible();
  let detailActivity = page.locator(".activity-feed-panel");
  await expect(detailActivity).toContainText("Activity");
  await expect(detailActivity).toContainText("agent.created");
  await expect(detailActivity).toContainText(`Created agent "${name}".`);
  await expect(detailActivity).toContainText("agent.start_requested");
  await expect(detailActivity).toContainText("agent.restart_completed");
  await expect(detailActivity).toContainText("agent.stop_completed");
  await expect(detailActivity).toContainText("agent.error");
  await expect(detailActivity).toContainText("Source: development_simulator");
  await expect(detailActivity).toContainText("Local development user");
  await expect(detailActivity).toContainText("Template: research_agent; Status: stopped");
  await expect(detailActivity).not.toContainText("actorUserId");

  await page.reload();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator(".status-pill", { hasText: "error" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status")).toContainText("Start requested.");
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  detailActivity = page.locator(".activity-feed-panel");
  await expect(detailActivity).toContainText("agent.start_requested");
  await expect(detailActivity).toContainText("agent.start_completed");
  await expect(detailActivity).toContainText(`Start completed for agent "${name}".`);
  await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await expect(page.locator(".status-pill", { hasText: "restarting" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(detailActivity).toContainText("agent.restart_requested");
  await expect(detailActivity).toContainText("agent.restart_completed");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(detailActivity).toContainText("agent.stop_requested");
  await expect(detailActivity).toContainText("agent.stop_completed");
  await expect(detailActivity.getByRole("link", { name: "Older activity" })).toBeVisible();
  await expectPageNotHorizontallyOverflowing(page);
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();

  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("link", { name })).toHaveCount(0);

  await page.goto("/dashboard");
  await expect(page.getByRole("heading", { name: "Persisted agents" })).toBeVisible();
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  dashboardActivity = page.locator(".activity-feed-panel");
  await expect(dashboardActivity).toContainText(`Agent "${name}" deleted from active views.`);
  await expect(dashboardActivity).toContainText("agent.deleted");
  await expect(dashboardActivity).toContainText("Deleted agent");

  expect(agentHref).not.toBeNull();
  await page.goto(agentHref ?? "/agents/missing");
  await expectNotFoundPage(page);
  await expect(page.locator("body")).not.toContainText(name);
});

test("/agents detail activity feed wraps on mobile without horizontal overflow", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile, "mobile wrapping check runs on the mobile project");

  const name = `Mobile Activity Agent ${testInfo.project.name}`;
  const createResponse = await request.post("/api/agents", {
    data: {
      name,
      templateKey: "research_agent",
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { agent: { id: string } };
  createdAgentIds.add(created.agent.id);

  await page.goto(`/agents/${created.agent.id}`);

  const detailActivity = page.locator(".activity-feed-panel");
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(detailActivity).toContainText("agent.created");
  await expect(detailActivity).toContainText(`Created agent "${name}".`);
  await expect(detailActivity).toContainText("Template: research_agent; Status: stopped");
  await expectPageNotHorizontallyOverflowing(page);
});

test("/agents detail edits config through persisted save and safe validation", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(isMobile, "desktop is the primary configuration editing surface");

  const name = `Config Editor Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  createdAgentIds.add(created.id);

  await page.goto(`/agents/${created.id}`);

  const configPanel = page.locator(".placeholder-panel").filter({ hasText: "Configuration" });
  const savedConfig = configPanel.getByRole("group", { name: "Saved config" });
  const configStatus = configPanel.getByRole("status");
  const detailActivity = page.locator(".activity-feed-panel");
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("config editing is future");
  await expect(page.locator("body")).not.toContainText("config editing is unavailable");
  await expect(savedConfig).toContainText("not_configured / not_configured");
  await expect(savedConfig).toContainText("$0.00");
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText("No config changes to save.");
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.locator("#config-model-name").fill("gpt-failed-save");
  await page.route(`**/api/agents/${created.id}`, async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 500,
      body: JSON.stringify({
        error: {
          code: "agent_config_update_failed",
          message: "postgres://user:password@127.0.0.1/db sql stack trace",
        },
      }),
    });
  });
  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText("Agent config could not be saved.");
  await expect(configStatus).not.toContainText("postgres://");
  await expect(savedConfig).not.toContainText("gpt-failed-save");
  await expect(detailActivity).not.toContainText("config.updated");
  await page.unroute(`**/api/agents/${created.id}`);
  await configPanel.getByRole("button", { name: "Reset edits" }).click();

  await configPanel.locator("#config-max-daily-spend").fill("bad spend");
  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText(
    "Max daily spend must be a positive dollar amount with whole cents.",
  );
  await expect(savedConfig).toContainText("$0.00");
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.locator("#config-max-daily-spend").fill("0.00");
  await configPanel.locator("#config-model-name").fill("   ");
  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText("Model name is required.");
  await expect(savedConfig).toContainText("not_configured / not_configured");
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.locator("#config-model-name").fill("not_configured");
  await configPanel.locator("#config-schedule-mode").selectOption("cron");
  await configPanel.locator("#config-schedule-cron").fill("not cron");
  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText(
    "Schedule cron must be a valid 5-field cron expression.",
  );
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.locator("#config-schedule-mode").selectOption("manual");
  await configPanel.locator("#config-timezone").fill("Mars/Base");
  await configPanel.getByRole("button", { name: "Save config" }).click();
  await expect(configStatus).toContainText("Timezone must be a valid IANA timezone.");
  await expect(detailActivity).not.toContainText("config.updated");

  await configPanel.locator("#config-timezone").fill("UTC");
  await configPanel.locator("#config-model-name").fill("gpt-5.5-mini");
  await configPanel.locator("#config-max-daily-spend").fill("2.00");
  await configPanel.getByRole("button", { name: "Save config" }).click();

  await expect(savedConfig).toContainText("not_configured / gpt-5.5-mini");
  await expect(savedConfig).toContainText("$2.00");
  await expect(
    detailActivity.locator(".activity-feed-item", { hasText: "config.updated" }),
  ).toHaveCount(1);
  await expect(detailActivity).toContainText("Configuration updated.");
  await expect(detailActivity).toContainText("Model Name: not_configured -> gpt-5.5-mini");
  await expect(detailActivity).toContainText("Max Daily Spend: $0.00 -> $2.00");

  await page.reload();

  await expect(configPanel.locator("#config-model-name")).toHaveValue("gpt-5.5-mini");
  await expect(configPanel.locator("#config-max-daily-spend")).toHaveValue("2.00");
  await expect(configPanel.getByRole("group", { name: "Saved config" })).toContainText(
    "not_configured / gpt-5.5-mini",
  );
  await expect(configPanel.getByRole("group", { name: "Saved config" })).toContainText("$2.00");
  await expect(page.locator(".activity-feed-item", { hasText: "config.updated" })).toHaveCount(1);
  await expectPageNotHorizontallyOverflowing(page);
});

test("/agents detail shows scoped runtime logs and stops polling after settled states", async ({
  page,
  request,
}, testInfo) => {
  const primaryName = `Runtime Logs Agent ${testInfo.project.name}`;
  const otherName = `Other Runtime Agent ${testInfo.project.name}`;
  const primaryAgent = await createAgent(request, primaryName);
  const otherAgent = await createAgent(request, otherName);
  createdAgentIds.add(primaryAgent.id);
  createdAgentIds.add(otherAgent.id);

  await insertRuntimeLog(otherAgent.id, `Scoped log for ${otherName}`);

  await page.goto(`/agents/${primaryAgent.id}`);
  await expect(page.getByRole("heading", { name: primaryName })).toBeVisible();
  const primaryRuntimeLogs = page.locator(".runtime-log-panel");
  await expect(primaryRuntimeLogs).toContainText("Runtime logs");
  await expect(primaryRuntimeLogs).toContainText("No runtime logs yet");
  await expect(primaryRuntimeLogs).not.toContainText(`Scoped log for ${otherName}`);

  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.getByRole("status")).toContainText("Start requested.");
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await pinDevelopmentUserToAgent(primaryAgent.id);
  const logsResponse = await request.get(`/api/agents/${primaryAgent.id}/logs`);
  expect(logsResponse.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: primaryName })).toBeVisible();
  await expect(primaryRuntimeLogs).toContainText("Checking task queue...");
  await expect(primaryRuntimeLogs).toContainText("No pending tasks.");
  await expect(primaryRuntimeLogs).toContainText("Heartbeat OK.");
  await expect(primaryRuntimeLogs).toContainText("Memory loaded.");
  await expect(primaryRuntimeLogs).toContainText("stdout");
  await expect(primaryRuntimeLogs).toContainText("info");
  await expect(primaryRuntimeLogs).toContainText("#1");
  await expect(primaryRuntimeLogs).not.toContainText("agent_id");
  await expect(primaryRuntimeLogs).not.toContainText("runner_id");
  await expect(primaryRuntimeLogs).not.toContainText("postgres://");
  const primaryLogItems = primaryRuntimeLogs.locator(".runtime-log-item");
  await expect(primaryLogItems).toHaveCount(4);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
    timeout: 5_000,
  });
  const stoppedLogCount = await primaryLogItems.count();
  await expect(primaryRuntimeLogs).toContainText("Checking task queue...");
  await page.waitForTimeout(2_000);
  await expect(primaryLogItems).toHaveCount(stoppedLogCount);

  await page.getByRole("button", { name: "Simulate error" }).click();
  await expect(page.locator(".status-pill", { hasText: "error" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(primaryRuntimeLogs).toContainText("Memory loaded.");
  await page.waitForTimeout(2_000);
  await expect(primaryLogItems).toHaveCount(stoppedLogCount);
  const detailActivity = page.locator(".activity-feed-panel");
  await expect(detailActivity).toContainText("agent.error");
  await expect(detailActivity).toContainText(
    `Simulated error requested for agent "${primaryName}".`,
  );
  await expect(detailActivity).toContainText("Source: development_simulator");

  await page.goto(`/agents/${otherAgent.id}`);
  const otherRuntimeLogs = page.locator(".runtime-log-panel");
  await expect(page.getByRole("heading", { name: otherName })).toBeVisible();
  await expect(otherRuntimeLogs).toContainText(`Scoped log for ${otherName}`);
  await expect(otherRuntimeLogs).not.toContainText("Checking task queue...");
  await expectPageNotHorizontallyOverflowing(page);
});

test("/agents detail keeps the record readable when runtime logs fail safely", async ({
  page,
  request,
}, testInfo) => {
  const name = `Runtime Log Error Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  createdAgentIds.add(created.id);

  await page.route("**/api/agents/*/logs?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      status: 500,
      body: JSON.stringify({
        error: {
          code: "agent_logs_failed",
          message: "postgres://user:pass@localhost/db",
        },
      }),
    });
  });

  await page.goto(`/agents/${created.id}`);

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(
    page.locator(".placeholder-panel").filter({ hasText: "Agent record" }),
  ).toBeVisible();
  const runtimeLogs = page.locator(".runtime-log-panel");
  await expect(runtimeLogs).toContainText("Runtime logs could not be loaded.");
  await expect(runtimeLogs).not.toContainText("postgres://");
  await expectPageNotHorizontallyOverflowing(page);
});

test("/agents shows safe client validation for invalid create input", async ({ page }) => {
  await page.goto("/agents");
  await page.getByLabel("Name").fill("   ");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Name is required.");
  await expect(page.getByRole("status")).not.toContainText("postgres://");
});

test("/agents detail returns not found for missing, malformed, and soft-deleted IDs", async ({
  page,
  request,
}, testInfo) => {
  await page.goto(`/agents/${randomUUID()}`);
  await expectNotFoundPage(page);
  await expect(page.locator("body")).not.toContainText("No record lookup is performed");

  await page.goto("/agents/not-a-uuid");
  await expectNotFoundPage(page);
  await expect(page.locator("body")).not.toContainText("No record lookup is performed");

  const createResponse = await request.post("/api/agents", {
    data: {
      name: `Soft Deleted Agent ${testInfo.project.name}`,
      templateKey: "research_agent",
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { agent: { id: string } };
  createdAgentIds.add(created.agent.id);

  await markAgentDeleted(created.agent.id);

  await page.goto(`/agents/${created.agent.id}`);
  await expectNotFoundPage(page);
  await expect(page.locator("body")).not.toContainText("Soft Deleted Agent");
  await expect(page.locator("body")).not.toContainText("No record lookup is performed");
});

function trackAgentHref(agentHref: string | null): void {
  const agentId = agentHref?.match(/^\/agents\/([0-9a-f-]+)$/)?.[1];

  if (agentId) {
    createdAgentIds.add(agentId);
  }
}

async function createAgent(request: APIRequestContext, name: string): Promise<{ id: string }> {
  const createResponse = await request.post("/api/agents", {
    data: {
      name,
      templateKey: "research_agent",
    },
  });
  expect(createResponse.status()).toBe(201);
  const created = (await createResponse.json()) as { agent: { id: string } };

  return {
    id: created.agent.id,
  };
}

async function markAgentDeleted(agentId: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`update agents set deleted_at = now() where id = ${agentId}`;
  });
}

async function insertRuntimeLog(agentId: string, message: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into agent_logs (agent_id, stream, level, message, sequence)
      values (${agentId}, 'stdout', 'info', ${message}, 1)
    `;
  });
}

async function insertPendingApproval(
  agentId: string,
  approval: {
    title: string;
    description: string;
    createdAt: string;
    expiresAt: string;
  },
): Promise<string> {
  let approvalId = "";

  await withDatabase(async (sql) => {
    const [inserted] = await sql<{ id: string }[]>`
      insert into agent_approvals (
        agent_id,
        title,
        description,
        status,
        payload_json,
        requested_by,
        created_at,
        expires_at
      )
      values (
        ${agentId},
        ${approval.title},
        ${approval.description},
        'pending',
        ${sql.json({ token: "stored-for-downstream-not-rendered" })},
        'fake-runner',
        ${approval.createdAt},
        ${approval.expiresAt}
      )
      returning id
    `;

    approvalId = inserted?.id ?? "";
  });

  expect(approvalId).toMatch(/^[0-9a-f-]+$/);
  return approvalId;
}

async function pinDevelopmentUserToAgent(agentId: string): Promise<void> {
  await withDatabase(async (sql) => {
    const [agent] = await sql<{ user_id: string }[]>`
      select user_id from agents where id = ${agentId} limit 1
    `;

    expect(agent).toBeDefined();
    await sql`
      insert into app_metadata (key, value)
      values ('local_development_user_id', ${agent?.user_id ?? ""})
      on conflict (key) do update
      set value = excluded.value,
          updated_at = now()
    `;
  });
}

async function deleteCreatedAgents(agentIds: string[]): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from agent_approvals where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_logs where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_events where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_configs where agent_id in ${sql(agentIds)}`;
    await sql`delete from agents where id in ${sql(agentIds)}`;
  });
}

async function expectApprovalStatus(
  approvalId: string,
  expectedStatus: "approved" | "denied",
): Promise<void> {
  const status = await withDatabase(async (sql) => {
    const [approval] = await sql<{ status: string }[]>`
      select status from agent_approvals where id = ${approvalId} limit 1
    `;

    return approval?.status;
  });

  expect(status).toBe(expectedStatus);
}

async function expectApprovalEventCounts(
  approvalId: string,
  expected: { approved: number; denied: number },
): Promise<void> {
  const counts = await withDatabase(async (sql) => {
    const rows = await sql<{ type: string; count: string }[]>`
      select type, count(*)::text as count
      from agent_events
      where metadata->>'approvalId' = ${approvalId}
        and type in ('approval.approved', 'approval.denied')
      group by type
    `;

    return {
      approved: Number(rows.find((row) => row.type === "approval.approved")?.count ?? 0),
      denied: Number(rows.find((row) => row.type === "approval.denied")?.count ?? 0),
    };
  });

  expect(counts).toEqual(expected);
}

async function expectApprovalDecisionSuccess(
  responsePromise: Promise<APIResponse>,
  status: "approved" | "denied",
  eventType: "approval.approved" | "approval.denied",
): Promise<void> {
  const response = await responsePromise;
  const body = await response.json();

  expect(response.status()).toBe(200);
  expect(body).toMatchObject({
    ok: true,
    approval: {
      status,
    },
    event: {
      type: eventType,
    },
  });
  expect(JSON.stringify(body)).not.toContain("payload_json");
  expect(JSON.stringify(body)).not.toContain("postgres://");
}

async function expectAlreadyResolvedConflict(
  responsePromise: Promise<APIResponse>,
  status: "approved" | "denied",
): Promise<void> {
  const response = await responsePromise;
  const body = await response.json();

  expect(response.status()).toBe(409);
  expect(body).toEqual({
    error: {
      code: "approval_already_resolved",
      message: "Approval has already been resolved.",
      status,
    },
  });
  expect(JSON.stringify(body)).not.toContain("payload_json");
  expect(JSON.stringify(body)).not.toContain("postgres://");
}

async function expectNotFoundPage(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This page could not be found." })).toBeVisible();
}

async function expectPageNotHorizontallyOverflowing(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));

  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/agentbay";
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
  });

  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
