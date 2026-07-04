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

test("/dashboard shows latest persisted process logs scoped to active agents", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(isMobile, "dashboard process log proof runs once on desktop");

  const primaryName = `Dashboard Process Agent ${testInfo.project.name}`;
  const otherName = `Dashboard Other Process Agent ${testInfo.project.name}`;
  const deletedName = `Dashboard Deleted Process Agent ${testInfo.project.name}`;
  const primaryAgent = await createAgent(request, primaryName);
  const otherAgent = await createAgent(request, otherName);
  const deletedAgent = await createAgent(request, deletedName);
  createdAgentIds.add(primaryAgent.id);
  createdAgentIds.add(otherAgent.id);
  createdAgentIds.add(deletedAgent.id);

  await insertProcessRuntimeLogs(primaryAgent.id, [
    {
      stream: "stdout",
      level: "info",
      message: "primary stdout line",
      sequence: 1,
      createdAt: "2026-07-04T06:00:01.000Z",
    },
    {
      stream: "stderr",
      level: "error",
      message: "TOKEN=stored-for-downstream should not render",
      sequence: 2,
      createdAt: "2026-07-04T06:00:02.000Z",
    },
    {
      stream: "stderr",
      level: "error",
      message: "Error: failed\n    at run (/app/worker.ts:10:2)\npostgres://user:pass@localhost/db",
      sequence: 4,
      createdAt: "2026-07-04T06:00:05.000Z",
    },
  ]);
  await insertProcessRuntimeLogs(otherAgent.id, [
    {
      stream: "stdout",
      level: "info",
      message: "other active process line",
      sequence: 1,
      createdAt: "2026-07-04T06:00:03.000Z",
    },
  ]);
  await insertProcessRuntimeLogs(deletedAgent.id, [
    {
      stream: "stdout",
      level: "info",
      message: "deleted process line should not render",
      sequence: 1,
      createdAt: "2026-07-04T06:00:04.000Z",
    },
  ]);
  await insertRuntimeLog(primaryAgent.id, "simulator row should not render", 3);
  await markAgentDeleted(deletedAgent.id);

  const logsResponse = await request.get(`/api/agents/${primaryAgent.id}/logs?limit=100`);
  expect(logsResponse.status()).toBe(200);
  const logsBody = (await logsResponse.json()) as {
    logs: Array<{
      source: string;
      stream: string;
      message: string;
      sequence: number;
      id?: string;
      agentId?: string;
      runnerId?: string;
      localRunnerProcessId?: string;
      dockerRunnerContainerId?: string;
      metadata?: Record<string, unknown>;
    }>;
    nextAfter: number | null;
  };
  expect(logsBody.logs.map((log) => [log.sequence, log.source, log.stream, log.message])).toEqual([
    [1, "local_runner", "stdout", "primary stdout line"],
    [2, "local_runner", "stderr", "Sensitive details omitted."],
    [3, "simulator", "stdout", "simulator row should not render"],
    [4, "local_runner", "stderr", "Error: failed [redacted database URL]"],
  ]);
  expect(logsBody.nextAfter).toBe(4);
  expect(JSON.stringify(logsBody)).not.toContain('"id"');
  expect(JSON.stringify(logsBody)).not.toContain("agentId");
  expect(JSON.stringify(logsBody)).not.toContain(primaryAgent.id);
  expect(JSON.stringify(logsBody)).not.toContain("runnerId");
  expect(JSON.stringify(logsBody)).not.toContain("localRunnerProcessId");
  expect(JSON.stringify(logsBody)).not.toContain("dockerRunnerContainerId");
  expect(JSON.stringify(logsBody)).not.toContain("metadata");
  expect(JSON.stringify(logsBody)).not.toContain("stored-for-downstream");
  expect(JSON.stringify(logsBody)).not.toContain("postgres://");
  expect(JSON.stringify(logsBody)).not.toContain("/app/worker.ts");
  expect(JSON.stringify(logsBody)).not.toContain("other active process line");
  expect(JSON.stringify(logsBody)).not.toContain("deleted process line should not render");

  await page.goto("/dashboard");

  const processLogsPanel = page.locator(".dashboard-process-log-panel");
  const primaryLogItem = processLogsPanel.locator(".runtime-log-item", {
    hasText: "primary stdout line",
  });
  const otherLogItem = processLogsPanel.locator(".runtime-log-item", {
    hasText: "other active process line",
  });
  await expect(processLogsPanel).toContainText("Latest process logs");
  await expect(processLogsPanel).toContainText("4 shown");
  await expect(primaryLogItem.getByRole("link", { name: primaryName })).toHaveAttribute(
    "href",
    `/agents/${primaryAgent.id}`,
  );
  await expect(otherLogItem.getByRole("link", { name: otherName })).toHaveAttribute(
    "href",
    `/agents/${otherAgent.id}`,
  );
  await expect(processLogsPanel).toContainText("primary stdout line");
  await expect(processLogsPanel).toContainText("other active process line");
  await expect(processLogsPanel).toContainText("stdout");
  await expect(processLogsPanel).toContainText("stderr");
  await expect(processLogsPanel).toContainText("Sensitive details omitted.");
  await expect(processLogsPanel).toContainText("Error: failed [redacted database URL]");
  await expect(processLogsPanel).not.toContainText("stored-for-downstream");
  await expect(processLogsPanel).not.toContainText("postgres://");
  await expect(processLogsPanel).not.toContainText("/app/worker.ts");
  await expect(processLogsPanel).not.toContainText("simulator row should not render");
  await expect(processLogsPanel).not.toContainText("deleted process line should not render");
  await expect(processLogsPanel).not.toContainText(deletedName);
  await expect(processLogsPanel).not.toContainText("agent_id");
  await expect(processLogsPanel).not.toContainText("runner_id");
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
      await expect(
        page.getByRole("heading", { name: "Latest log summaries", exact: true }),
      ).toBeVisible();
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
  await expect(generatedApproval).toContainText("Payload summary");
  await expect(generatedApproval).toContainText("Source: fake_runner");
  await expect(generatedApproval).toContainText("Action:");
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
  await expect(dashboardAgentRow.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(
    dashboardAgentRow.getByRole("button", { name: "Restart", exact: true }),
  ).toBeEnabled();
  await expect(dashboardActivity).toContainText("agent.restart_requested");
  await expect(dashboardActivity).toContainText("agent.restart_completed");
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
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
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

test("/agents mobile list exposes status controls without horizontal overflow", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile, "mobile agent status control proof runs on the mobile project");

  const name = `Mobile Status Control Agent ${testInfo.project.name} with a deliberately long operational name`;
  const created = await createAgent(request, name, "social_content_agent");
  createdAgentIds.add(created.id);

  await page.goto("/agents");

  const agentsPanel = page.locator(".agent-list-panel");
  const mobileCard = agentsPanel.locator(".mobile-agent-card", { hasText: name });
  await expect(mobileCard.getByRole("link", { name })).toHaveAttribute(
    "href",
    `/agents/${created.id}`,
  );
  await expect(mobileCard).toContainText("Social Content Agent");
  await expect(mobileCard).toContainText("social_content_agent");
  await expect(mobileCard).toContainText(created.id);
  await expect(mobileCard.locator(".status-pill", { hasText: "stopped" })).toBeVisible();
  await expect(mobileCard.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(mobileCard.getByRole("button", { name: "Delete" })).toHaveCount(0);
  await expectPageNotHorizontallyOverflowing(page);

  await mobileCard.getByRole("button", { name: "Resume" }).click();
  await expect(mobileCard.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(mobileCard.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(mobileCard.getByRole("button", { name: "Resume" })).toHaveCount(0);
  await expectPageNotHorizontallyOverflowing(page);

  await mobileCard.getByRole("button", { name: "Stop" }).click();
  await expect(mobileCard.getByRole("status")).toContainText("Confirm to stop this running agent.");
  await expect(mobileCard.locator(".status-pill", { hasText: "running" })).toBeVisible();
  await expectPageNotHorizontallyOverflowing(page);

  await mobileCard.getByRole("button", { name: "Confirm stop" }).click();
  await expect(mobileCard.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(mobileCard.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(mobileCard.getByRole("button", { name: "Stop" })).toHaveCount(0);
  await expectPageNotHorizontallyOverflowing(page);

  await mobileCard.getByRole("button", { name: "Resume" }).click();
  await expect(mobileCard.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(mobileCard.getByRole("button", { name: "Stop" })).toBeVisible();
  await expectPageNotHorizontallyOverflowing(page);
});

test("core mobile control routes stay readable without horizontal page overflow", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile, "core mobile layout hardening proof runs on the mobile project");

  const name = `Mobile Hardening Agent ${testInfo.project.name} ${"long-name-".repeat(8)}`;
  const approvalTitle = `Review mobile hardening approval ${"approval-id-".repeat(10)}`;
  const created = await createAgent(request, name, "social_content_agent");
  createdAgentIds.add(created.id);

  await pinDevelopmentUserToAgent(created.id);
  await markAgentErrored(
    created.id,
    `Mobile hardening status reason ${"reason-fragment-".repeat(14)} should wrap.`,
  );
  await insertPendingApproval(created.id, {
    title: approvalTitle,
    description: `Approve this phone-sized control review with ${"description-fragment-".repeat(
      10,
    )} and keep the action buttons reachable.`,
    createdAt: "2026-07-04T14:15:00.000Z",
    expiresAt: "2026-07-04T14:45:00.000Z",
  });
  await insertAgentEvent(created.id, {
    type: "agent.error",
    message: `Agent failed during mobile hardening ${"event-fragment-".repeat(12)}.`,
  });
  await insertRuntimeLog(
    created.id,
    `Runtime log line for mobile hardening ${"log-fragment-".repeat(18)} remains readable.`,
  );

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 360, height: 740 },
  ]) {
    await page.setViewportSize(viewport);

    await page.goto("/agents");
    const agentsPanel = page.locator(".agent-list-panel");
    const agentsMobileCard = agentsPanel.locator(".mobile-agent-card", { hasText: name });
    await expect(agentsMobileCard.getByRole("link", { name })).toHaveAttribute(
      "href",
      `/agents/${created.id}`,
    );
    await expect(agentsMobileCard).toContainText("social_content_agent");
    await expect(agentsMobileCard).toContainText(created.id);
    await expect(agentsMobileCard.locator(".status-pill", { hasText: "error" })).toBeVisible();
    await expect(agentsMobileCard.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(agentsMobileCard.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expectPageNotHorizontallyOverflowing(page);

    await page.goto("/dashboard");
    const dashboardAgentCard = page
      .locator(".agent-list-panel")
      .locator(".mobile-agent-card", { hasText: name });
    await expect(dashboardAgentCard.getByRole("link", { name })).toHaveAttribute(
      "href",
      `/agents/${created.id}`,
    );
    await expect(dashboardAgentCard.locator(".status-pill", { hasText: "error" })).toBeVisible();
    await expect(dashboardAgentCard.getByRole("button", { name: "Resume" })).toBeVisible();

    const dashboardApproval = page.locator(".approval-item", { hasText: approvalTitle });
    await expect(dashboardApproval).toContainText("Payload summary");
    await expect(dashboardApproval.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(dashboardApproval.getByRole("button", { name: "Deny" })).toBeVisible();
    await dashboardApproval.getByRole("button", { name: "Approve" }).focus();
    await expect(dashboardApproval.getByRole("button", { name: "Approve" })).toBeFocused();
    await expectPageNotHorizontallyOverflowing(page);

    await page.goto(`/agents/${created.id}`);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(
      page.locator(".placeholder-panel").filter({ hasText: "Agent record" }),
    ).toContainText("Status reason");
    await expect(page.locator(".operational-alert-panel")).toContainText("Operational alerts");
    await expect(page.locator(".operational-alert-panel")).toContainText("Agent is in error");
    await expect(page.locator(".runtime-log-panel")).toContainText("Latest log summaries");
    const detailApproval = page.locator(".approval-item", { hasText: approvalTitle });
    await expect(detailApproval.getByRole("button", { name: "Approve" })).toBeVisible();
    await detailApproval.getByRole("button", { name: "Deny" }).focus();
    await expect(detailApproval.getByRole("button", { name: "Deny" })).toBeFocused();
    await expectPageNotHorizontallyOverflowing(page);
  }
});

test("Milestone 8 mobile acceptance covers controls, approvals, logs, alerts, and viewports", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(!isMobile, "final Milestone 8 mobile acceptance proof runs on mobile");

  for (const viewport of [
    { width: 375, height: 667 },
    { width: 360, height: 740 },
  ]) {
    await page.setViewportSize(viewport);

    const viewportLabel = `${viewport.width}x${viewport.height}`;
    const runId = randomUUID().slice(0, 8);
    const name = `Milestone 8 Acceptance Agent ${testInfo.project.name} ${viewportLabel} ${runId} ${"long-".repeat(
      6,
    )}`;
    const created = await createAgent(request, name, "github_issue_agent");
    createdAgentIds.add(created.id);

    await pinDevelopmentUserToAgent(created.id);
    const approvalToApproveId = await insertPendingApproval(created.id, {
      title: `Approve mobile acceptance action ${viewportLabel} ${runId}`,
      description:
        "Approve this final mobile acceptance action from a phone viewport without hidden desktop-only controls.",
      createdAt: "2026-07-04T15:00:00.000Z",
      expiresAt: "2999-07-04T15:30:00.000Z",
    });
    const approvalToDenyId = await insertPendingApproval(created.id, {
      title: `Deny mobile acceptance action ${viewportLabel} ${runId}`,
      description:
        "Deny this final mobile acceptance action from a phone viewport with confirmation.",
      createdAt: "2026-07-04T15:05:00.000Z",
      expiresAt: "2999-07-04T15:35:00.000Z",
    });
    await insertRuntimeLog(
      created.id,
      `Latest Milestone 8 mobile log ${"wrap-".repeat(20)} remains readable at ${viewportLabel}.`,
    );

    await page.goto("/agents");
    const agentsCard = page.locator(".mobile-agent-card", { hasText: created.id });
    await expect(agentsCard.getByRole("link", { name })).toHaveAttribute(
      "href",
      `/agents/${created.id}`,
    );
    await expect(agentsCard).toContainText("github_issue_agent");
    await expect(agentsCard.locator(".status-pill", { hasText: "stopped" })).toBeVisible();
    await expect(agentsCard.getByRole("button", { name: "Resume" })).toBeVisible();
    await expect(agentsCard.getByRole("button", { name: "Delete" })).toHaveCount(0);
    await expectPageNotHorizontallyOverflowing(page);

    await agentsCard.getByRole("button", { name: "Resume" }).click();
    await expect(agentsCard.locator(".status-pill", { hasText: "running" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(agentsCard.getByRole("button", { name: "Stop" })).toBeVisible();
    await expectPageNotHorizontallyOverflowing(page);

    await agentsCard.getByRole("button", { name: "Stop" }).click();
    await expect(agentsCard.getByRole("status")).toContainText(
      "Confirm to stop this running agent.",
    );
    await expect(agentsCard.getByRole("button", { name: "Confirm stop" })).toBeVisible();
    await expectPageNotHorizontallyOverflowing(page);

    await agentsCard.getByRole("button", { name: "Confirm stop" }).click();
    await expect(agentsCard.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
      timeout: 5_000,
    });
    await expect(agentsCard.getByRole("button", { name: "Resume" })).toBeVisible();
    await expectPageNotHorizontallyOverflowing(page);

    await page.goto(`/agents/${created.id}`);
    await expect(page.getByRole("heading", { name })).toBeVisible();
    await expect(page.locator(".runtime-log-panel")).toContainText("Latest log summaries");
    await expect(page.locator(".runtime-log-panel")).toContainText("Latest Milestone 8 mobile log");
    await expect(page.locator(".operational-alert-panel")).toContainText("Operational alerts");
    await expect(page.locator(".operational-alert-panel")).toContainText(
      "Pending approval blocks progress",
    );
    await expectPageNotHorizontallyOverflowing(page);

    await page.goto("/dashboard");
    const dashboardCard = page.locator(".mobile-agent-card", { hasText: name });
    await expect(dashboardCard.getByRole("link", { name })).toHaveAttribute(
      "href",
      `/agents/${created.id}`,
    );
    await expect(dashboardCard.getByRole("button", { name: "Resume" })).toBeVisible();

    const approvalToApprove = page.locator(".approval-item", {
      hasText: `Approve mobile acceptance action ${viewportLabel} ${runId}`,
    });
    await expect(approvalToApprove.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(approvalToApprove.getByRole("button", { name: "Deny" })).toBeVisible();
    await expectPageNotHorizontallyOverflowing(page);

    await pinDevelopmentUserToAgent(created.id);
    await approvalToApprove.getByRole("button", { name: "Approve" }).click();
    await expect(approvalToApprove.locator(".status-pill", { hasText: "approved" })).toBeVisible();
    await expect(approvalToApprove.getByRole("status")).toContainText("Approval approved.");
    await expectApprovalStatus(approvalToApproveId, "approved");
    await expectPageNotHorizontallyOverflowing(page);

    const approvalToDeny = page.locator(".approval-item", {
      hasText: `Deny mobile acceptance action ${viewportLabel} ${runId}`,
    });
    await expect(approvalToDeny.getByRole("button", { name: "Deny" })).toBeVisible();

    await pinDevelopmentUserToAgent(created.id);
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toBe("Deny this approval? This cannot be undone.");
      await dialog.accept();
    });
    await approvalToDeny.getByRole("button", { name: "Deny" }).click();
    await expect(approvalToDeny.locator(".status-pill", { hasText: "denied" })).toBeVisible();
    await expect(approvalToDeny.getByRole("status")).toContainText("Approval denied.");
    await expectApprovalStatus(approvalToDenyId, "denied");
    await expectPageNotHorizontallyOverflowing(page);
  }
});

test.describe
  .serial("mobile approval decisions", () => {
    test("/dashboard mobile approves a pending approval and shows resolved state", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(!isMobile, "mobile approval decision proof runs on the mobile project");

      const name = `Mobile Approve Agent ${testInfo.project.name} with a long readable name`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);
      const createdAt = "2026-07-04T12:15:00.000Z";
      const expiresAt = "2026-07-04T12:45:00.000Z";
      const approvalId = await insertPendingApproval(created.id, {
        title: "Approve mobile outbound message with enough context",
        description:
          "Approve this pending fake-runner action from a phone without desktop-only controls.",
        createdAt,
        expiresAt,
      });

      await pinDevelopmentUserToAgent(created.id);
      await page.goto("/dashboard");

      const approvalPanel = page.locator(".approval-panel");
      const approvalItem = approvalPanel.locator(".approval-item", {
        hasText: "Approve mobile outbound message with enough context",
      });
      await expect(approvalItem.getByRole("link", { name })).toHaveAttribute(
        "href",
        `/agents/${created.id}`,
      );
      await expect(approvalItem).toContainText(
        "Approve this pending fake-runner action from a phone without desktop-only controls.",
      );
      await expect(approvalItem.locator(".status-pill", { hasText: "pending" })).toBeVisible();
      await expect(approvalItem).toContainText("fake-runner");
      await expect(approvalItem).toContainText(createdAt);
      await expect(approvalItem).toContainText(expiresAt);
      await expect(approvalItem).toContainText("Payload summary");
      await expect(approvalItem).toContainText("Action: telegram.send_message");
      await expect(approvalItem).toContainText("Daily operations summary is ready for review.");
      await expect(approvalItem).not.toContainText("payload_json");
      await expect(approvalItem).not.toContainText("stored-for-downstream-not-rendered");
      await expectPageNotHorizontallyOverflowing(page);

      await pinDevelopmentUserToAgent(created.id);
      await approvalItem.getByRole("button", { name: "Approve" }).click();

      await expect(approvalItem.locator(".status-pill", { hasText: "approved" })).toBeVisible();
      await expect(approvalItem.getByRole("status")).toContainText("Resolved approved");
      await expect(approvalItem.getByRole("status")).toContainText("Approval approved.");
      await expect(approvalItem.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(approvalItem.getByRole("button", { name: "Deny" })).toHaveCount(0);
      await expect(approvalItem).not.toContainText("postgres://");
      await expectApprovalStatus(approvalId, "approved");
      await expectPageNotHorizontallyOverflowing(page);
    });

    test("/agents detail mobile confirms and denies a pending approval safely", async ({
      isMobile,
      page,
      request,
    }, testInfo) => {
      test.skip(!isMobile, "mobile deny decision proof runs on the mobile project");

      const name = `Mobile Deny Agent ${testInfo.project.name}`;
      const created = await createAgent(request, name);
      createdAgentIds.add(created.id);
      const staleApprovalId = await insertPendingApproval(created.id, {
        title: "Already resolved mobile inbox access",
        description: "Show a safe stale-response state without leaving mobile actions active.",
        createdAt: "2026-07-04T13:10:00.000Z",
        expiresAt: "2026-07-04T13:40:00.000Z",
      });
      const approvalId = await insertPendingApproval(created.id, {
        title: "Deny mobile inbox access",
        description: "Deny this pending fake inbox access from the agent detail view.",
        createdAt: "2026-07-04T13:15:00.000Z",
        expiresAt: "2026-07-04T13:45:00.000Z",
      });

      await pinDevelopmentUserToAgent(created.id);
      await page.goto(`/agents/${created.id}`);

      const approvalPanel = page.locator(".approval-panel");
      const approvalItem = approvalPanel.locator(".approval-item", {
        hasText: "Deny mobile inbox access",
      });
      await expect(page.getByRole("heading", { name })).toBeVisible();
      await expect(approvalItem.getByRole("link", { name })).toHaveAttribute(
        "href",
        `/agents/${created.id}`,
      );
      await expect(approvalItem).toContainText("fake-runner");
      await expect(approvalItem).toContainText("Action: telegram.send_message");
      await expect(approvalItem.locator(".status-pill", { hasText: "pending" })).toBeVisible();
      await expectPageNotHorizontallyOverflowing(page);

      const staleApprovalItem = approvalPanel.locator(".approval-item", {
        hasText: "Already resolved mobile inbox access",
      });
      await expect(staleApprovalItem.locator(".status-pill", { hasText: "pending" })).toBeVisible();
      await page.route(`**/api/approvals/${staleApprovalId}/deny`, async (route) => {
        await route.fulfill({
          contentType: "application/json",
          status: 409,
          body: JSON.stringify({
            error: {
              code: "approval_already_resolved",
              message: "postgres://user:pass@localhost/db payload_json stack trace",
              status: "denied",
            },
          }),
        });
      });
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toBe("Deny this approval? This cannot be undone.");
        await dialog.accept();
      });
      await staleApprovalItem.getByRole("button", { name: "Deny" }).click();
      await expect(staleApprovalItem.locator(".status-pill", { hasText: "denied" })).toBeVisible();
      await expect(staleApprovalItem.getByRole("status")).toContainText(
        "Approval has already been resolved.",
      );
      await expect(staleApprovalItem.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(staleApprovalItem.getByRole("button", { name: "Deny" })).toHaveCount(0);
      await expect(staleApprovalItem.getByRole("status")).not.toContainText("postgres://");
      await expect(staleApprovalItem.getByRole("status")).not.toContainText("payload_json");
      await page.unroute(`**/api/approvals/${staleApprovalId}/deny`);

      await pinDevelopmentUserToAgent(created.id);
      page.once("dialog", async (dialog) => {
        expect(dialog.message()).toBe("Deny this approval? This cannot be undone.");
        await dialog.accept();
      });
      await approvalItem.getByRole("button", { name: "Deny" }).click();

      await expect(approvalItem.locator(".status-pill", { hasText: "denied" })).toBeVisible();
      await expect(approvalItem.getByRole("status")).toContainText("Resolved denied");
      await expect(approvalItem.getByRole("status")).toContainText("Approval denied.");
      await expect(approvalItem.getByRole("button", { name: "Approve" })).toHaveCount(0);
      await expect(approvalItem.getByRole("button", { name: "Deny" })).toHaveCount(0);
      await expectApprovalStatus(approvalId, "denied");
      await expectPageNotHorizontallyOverflowing(page);
    });
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
  await expect(primaryRuntimeLogs).toContainText("Latest log summaries");
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

test.describe("mobile latest logs and operational alerts", () => {
  test("iPhone-sized detail view renders safe latest logs and active alerts", async ({
    isMobile,
    page,
    request,
  }, testInfo) => {
    test.skip(!isMobile, "mobile log and alert proof runs on the mobile project");

    await page.setViewportSize({ width: 375, height: 667 });

    const name = `Mobile Alert Agent ${testInfo.project.name}`;
    const created = await createAgent(request, name);
    createdAgentIds.add(created.id);

    await pinDevelopmentUserToAgent(created.id);
    await markAgentErrored(
      created.id,
      "Runtime failed before retry\n    at run (/app/worker.ts:10:2)\npostgres://user:pass@localhost/db",
    );
    await insertPendingApproval(created.id, {
      title: "Review mobile approval blocker",
      description: "This approval should be readable from a phone.",
      createdAt: "2026-07-04T08:15:00.000Z",
      expiresAt: "2026-07-04T09:15:00.000Z",
    });
    await insertAgentEvent(created.id, {
      type: "agent.error",
      message: "Agent failed with token=stored-for-downstream and raw stack details.",
    });
    await insertRuntimeLog(
      created.id,
      "Worker recovered after postgres://user:pass@localhost/db failed\n    at poll (/app/runner.ts:9:1)",
    );

    await page.goto(`/agents/${created.id}`);

    const alertPanel = page.locator(".operational-alert-panel");
    await expect(alertPanel).toContainText("Operational alerts");
    await expect(alertPanel).toContainText("Agent is in error");
    await expect(alertPanel).toContainText("Approval expired");
    await expect(alertPanel).toContainText("Agent error");
    await expect(alertPanel).toContainText("Runner offline and degraded alerts are deferred");
    await expect(alertPanel).toContainText("Sensitive details omitted.");
    await expect(alertPanel).not.toContainText("token=stored-for-downstream");
    await expect(alertPanel).not.toContainText("postgres://");
    await expect(alertPanel).not.toContainText("/app/worker.ts");

    const runtimeLogs = page.locator(".runtime-log-panel");
    await expect(runtimeLogs).toContainText("Latest log summaries");
    await expect(runtimeLogs).toContainText("[redacted database URL]");
    await expect(runtimeLogs).not.toContainText("postgres://");
    await expect(runtimeLogs).not.toContainText("/app/runner.ts");
    await expectPageNotHorizontallyOverflowing(page);
  });

  test("small Android detail view keeps latest logs scoped to the selected agent", async ({
    isMobile,
    page,
    request,
  }, testInfo) => {
    test.skip(!isMobile, "mobile log and alert proof runs on the mobile project");

    await page.setViewportSize({ width: 360, height: 740 });

    const selectedName = `Small Android Logs Agent ${testInfo.project.name}`;
    const otherName = `Other Small Android Logs Agent ${testInfo.project.name}`;
    const selected = await createAgent(request, selectedName);
    const other = await createAgent(request, otherName);
    createdAgentIds.add(selected.id);
    createdAgentIds.add(other.id);

    await insertRuntimeLog(
      selected.id,
      `Selected mobile log ${"wrap-".repeat(24)} remains readable for ${selectedName}.`,
    );
    await insertRuntimeLog(other.id, `Other agent log should not render for ${otherName}.`);

    await page.goto(`/agents/${selected.id}`);

    const runtimeLogs = page.locator(".runtime-log-panel");
    await expect(runtimeLogs).toContainText("Latest log summaries");
    await expect(runtimeLogs).toContainText("Selected mobile log");
    await expect(runtimeLogs).not.toContainText("Other agent log should not render");
    await expect(page.locator(".operational-alert-panel")).toContainText("No active alerts");
    await expectPageNotHorizontallyOverflowing(page);
  });
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

async function createAgent(
  request: APIRequestContext,
  name: string,
  templateKey = "research_agent",
): Promise<{ id: string }> {
  const createResponse = await request.post("/api/agents", {
    data: {
      name,
      templateKey,
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

async function insertRuntimeLog(agentId: string, message: string, sequence = 1): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into agent_logs (agent_id, stream, level, message, sequence)
      values (${agentId}, 'stdout', 'info', ${message}, ${sequence})
    `;
  });
}

async function insertProcessRuntimeLogs(
  agentId: string,
  logs: Array<{
    stream: "stdout" | "stderr";
    level: string;
    message: string;
    sequence: number;
    createdAt: string;
  }>,
): Promise<void> {
  await withDatabase(async (sql) => {
    const [processRow] = await sql<{ id: string }[]>`
      insert into local_runner_processes (
        agent_id,
        pid,
        command_metadata,
        status,
        started_at,
        created_at,
        updated_at
      )
      values (
        ${agentId},
        43273,
        ${sql.json({ command: "seeded-test-runner" })},
        'running',
        '2026-07-04T06:00:00.000Z',
        '2026-07-04T06:00:00.000Z',
        '2026-07-04T06:00:00.000Z'
      )
      returning id
    `;
    const processId = processRow?.id ?? "";

    for (const log of logs) {
      await sql`
        insert into agent_logs (
          agent_id,
          runner_id,
          local_runner_process_id,
          source,
          stream,
          level,
          message,
          sequence,
          created_at
        )
        values (
          ${agentId},
          ${processId},
          ${processId},
          'local_runner',
          ${log.stream},
          ${log.level},
          ${log.message},
          ${log.sequence},
          ${log.createdAt}
        )
      `;
    }
  });
}

async function markAgentErrored(agentId: string, statusReason: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      update agents
      set status = 'error',
          status_reason = ${statusReason},
          updated_at = now()
      where id = ${agentId}
    `;
  });
}

async function insertAgentEvent(
  agentId: string,
  event: {
    type: string;
    message: string;
  },
): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into agent_events (agent_id, actor_user_id, type, message, metadata)
      select id, user_id, ${event.type}, ${event.message}, '{}'::jsonb
      from agents
      where id = ${agentId}
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
        ${sql.json({
          source: "fake_runner",
          actionType: "telegram.send_message",
          preview: {
            destination: "Demo Telegram channel",
            summary: "Daily operations summary is ready for review.",
          },
          token: "stored-for-downstream-not-rendered",
        })},
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
    await sql`delete from local_runner_processes where agent_id in ${sql(agentIds)}`;
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
