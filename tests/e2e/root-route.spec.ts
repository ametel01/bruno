import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  type APIRequestContext,
  type APIResponse,
  expect,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import postgres from "postgres";

const createdAgentIds = new Set<string>();
const createdRunnerIds = new Set<string>();
const BRUNO_AGENT_ID_LABEL = "bruno.agent_id";
const DOCKER_RUNNER_FIXTURE_IMAGE = "busybox:1.36";
const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_125;

test.afterEach(async ({ request }) => {
  const agentIds = [...createdAgentIds];
  createdAgentIds.clear();

  if (agentIds.length > 0) {
    await stopCreatedAgents(request, agentIds);
    await deleteCreatedAgents(agentIds);
    await deleteCreatedRunners();

    for (const agentId of agentIds) {
      await removeDockerContainersForAgent(agentId);
    }
  }

  await deleteCreatedRunners();
  await removeOrphanedStoppedBrunoDockerContainers();
});

const shellRoutes = [
  { path: "/dashboard", heading: "Founder dispatch" },
  { path: "/agents", heading: "Agent roster" },
  { path: "/settings", heading: "Workspace settings" },
] as const;

for (const route of shellRoutes) {
  test(`${route.path} renders the bruno shell`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.getByRole("link", { name: "bruno dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "System health" })).toHaveAttribute(
      "href",
      "/health",
    );
  });
}

test("/ renders the public Bruno.Ai product direction", async ({ page }) => {
  await page.goto("/");

  expect(await page.evaluate(() => document.body.firstChild?.nodeType)).toBe(8);
  expect(await page.evaluate(() => document.body.firstChild?.textContent)).toContain(
    "seed b32744ed",
  );
  await expect(
    page.getByRole("heading", { name: "Bruno.Ai runs your business with you. 24/7." }),
  ).toBeVisible();
  const hero = page.locator('section[aria-labelledby="landing-title"]');
  await expect(hero.getByRole("link", { exact: true, name: "Open dashboard" })).toHaveAttribute(
    "href",
    "/dashboard",
  );
  await expect(hero.getByRole("link", { exact: true, name: "Create an agent" })).toHaveAttribute(
    "href",
    "/agents#create-agent-title",
  );
  await expect(page.getByRole("link", { name: "Follow the build" })).toHaveAttribute(
    "href",
    "https://github.com/ametel01/bruno",
  );
  await expect(page.getByText("Illustrative data")).toBeVisible();
  await expect(page.locator('a[href="/sign-in"]')).toHaveAttribute("href", "/sign-in");

  await hero.getByRole("link", { exact: true, name: "Open dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Founder dispatch" })).toBeVisible();
});

test("/health returns reachable database JSON in the browser", async ({ page }) => {
  await page.goto("/dashboard");
  await page.getByRole("link", { name: "System health" }).click();

  await expect(page).toHaveURL(/\/health$/);
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

test("manual runner status, alerts, and remote logs stay visible and safe", async ({
  page,
  request,
}, testInfo) => {
  const name = `Manual Runner UI Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  const localRunnerIds: string[] = [];

  try {
    const runner = await insertManualRunnerForAgent(created.id, {
      name: `Manual Runner ${testInfo.project.name}`,
      endpointUrl: `https://user:password@runner-${randomUUID()}.example.com:8443/runner/v1?token=hidden`,
      status: "offline",
      updatedAt: "2026-07-05T01:30:00.000Z",
    });
    localRunnerIds.push(runner.id);
    await insertRunnerHeartbeat(runner.id, {
      status: "online",
      version: "bruno-runner/1.2.3",
      observedAt: "2026-07-05T01:30:30.000Z",
      metrics: {
        maxAgents: 1,
        runningAgents: 1,
        cpuPercent: 37,
        memoryUsedMb: 512,
        memoryTotalMb: 2048,
        diskUsedMb: 1024,
        diskTotalMb: 4096,
      },
    });
    const onlineRunner = await insertManualRunnerForAgent(
      created.id,
      {
        name: `Online Runner ${testInfo.project.name}`,
        endpointUrl: `https://online-${randomUUID()}.example.com:8443/runner/v1`,
        status: "online",
        updatedAt: "2026-07-05T01:32:00.000Z",
      },
      { assign: false },
    );
    localRunnerIds.push(onlineRunner.id);
    await insertRunnerHeartbeat(onlineRunner.id, {
      status: "online",
      version: "bruno-runner/2.0.0",
      observedAt: "2026-07-05T01:32:30.000Z",
      metrics: {
        maxAgents: 5,
        runningAgents: 3,
        cpuPercent: 42,
        memoryUsedMb: 1024,
        memoryTotalMb: 4096,
        diskUsedMb: 2048,
        diskTotalMb: 8192,
      },
    });
    const oldRunnerCredential = `bruno_run_old_${randomUUID().replaceAll("-", "")}`;
    await insertRunnerCredential(runner.id, oldRunnerCredential, "2026-07-05T01:33:00.000Z");
    await insertManualRunnerLog(created.id, runner.id, {
      stream: "stderr",
      level: "error",
      message: "remote manual runner unreachable",
      sequence: 1,
      createdAt: "2026-07-05T01:31:00.000Z",
    });

    await withPinnedDevelopmentUserForAgent(created.id, async () => {
      await page.goto("/dashboard");

      const runnerPanel = page.locator(".manual-runner-panel", {
        hasText: "Runner health",
      });
      await expect(runnerPanel).toContainText("Runner health");
      await expect(runnerPanel).toContainText(`Manual Runner ${testInfo.project.name}`);
      await expect(runnerPanel).toContainText(`Online Runner ${testInfo.project.name}`);
      await expect(runnerPanel).toContainText("manual_vps");
      await expect(runnerPanel).toContainText(new URL(runner.endpointUrl).host);
      await expect(runnerPanel).toContainText(new URL(onlineRunner.endpointUrl).host);
      await expect(runnerPanel).toContainText("offline");
      await expect(runnerPanel).toContainText("online");
      await expect(runnerPanel).toContainText("1 / 1 agent running");
      await expect(runnerPanel).toContainText("3 / 5 agents running");
      await expect(runnerPanel).toContainText("Runner capacity reached");
      await expect(runnerPanel).toContainText("37%");
      await expect(runnerPanel).toContainText("512 / 2,048 MB");
      await expect(runnerPanel).toContainText("1,024 / 4,096 MB");
      await expect(runnerPanel).toContainText("bruno-runner/1.2.3");
      await expect(runnerPanel).toContainText("bruno-runner/2.0.0");
      await expect(runnerPanel).toContainText("2026-07-05T01:30:30.000Z");
      await expect(runnerPanel).toContainText("2026-07-05T01:32:30.000Z");
      await expect(runnerPanel).toContainText("2026-07-05T01:30:00.000Z");
      await expect(runnerPanel).not.toContainText("password");
      await expect(runnerPanel).not.toContainText("token=hidden");
      await expect(runnerPanel).not.toContainText("/runner/v1");
      await expect(runnerPanel).not.toContainText(runner.id);
      await expect(runnerPanel).not.toContainText(onlineRunner.id);
      await expect(runnerPanel).not.toContainText("credentialHash");
      await expect(runnerPanel).not.toContainText("tokenHash");
      await expect(runnerPanel).not.toContainText("cpuPercent");
      await expect(runnerPanel).not.toContainText("apiToken");

      const processLogsPanel = page.locator(".dashboard-process-log-panel");
      await expect(processLogsPanel).toContainText("remote manual runner unreachable");
      await expect(processLogsPanel).toContainText("manual_runner");
      await expect(processLogsPanel).toContainText("stderr");
      await expect(processLogsPanel).toContainText("error");
      await expect(processLogsPanel).not.toContainText(runner.id);
      await expect(processLogsPanel).not.toContainText("runner_id");

      await page.goto(`/agents/${created.id}`);

      const assignedRunnerPanel = page.locator(".manual-runner-panel", {
        hasText: "Assigned runner",
      });
      await expect(assignedRunnerPanel).toContainText("Assigned runner");
      await expect(assignedRunnerPanel).toContainText(`Manual Runner ${testInfo.project.name}`);
      await expect(assignedRunnerPanel).toContainText("This agent is assigned to");
      await expect(assignedRunnerPanel).toContainText("offline");
      await expect(assignedRunnerPanel).toContainText("1 / 1 agent running");
      await expect(assignedRunnerPanel).toContainText("Runner capacity reached");
      await expect(assignedRunnerPanel).toContainText("37%");
      await expect(assignedRunnerPanel).toContainText("512 / 2,048 MB");
      await expect(assignedRunnerPanel).toContainText(new URL(runner.endpointUrl).host);
      await expect(assignedRunnerPanel).toContainText("bruno-runner/1.2.3");
      await expect(assignedRunnerPanel).toContainText("2026-07-05T01:30:30.000Z");
      await expect(assignedRunnerPanel).toContainText(
        "Assigned runner is inactive or unreachable.",
      );
      await expect(assignedRunnerPanel).not.toContainText("password");
      await expect(assignedRunnerPanel).not.toContainText("token=hidden");
      await expect(assignedRunnerPanel).not.toContainText(runner.id);
      await expect(assignedRunnerPanel).not.toContainText("credentialHash");
      await expect(assignedRunnerPanel).not.toContainText("cpuPercent");

      const alertPanel = page.locator(".operational-alert-panel");
      await expect(alertPanel).toContainText("Runner is offline");
      await expect(alertPanel).toContainText("Assigned runner is inactive or unreachable.");
      await expect(alertPanel).not.toContainText("postgres://");
      await expect(alertPanel).not.toContainText("/app/worker.ts");

      const runtimeLogs = page.locator(".runtime-log-panel", { hasText: "Latest log summaries" });
      await expect(runtimeLogs).toContainText("remote manual runner unreachable");
      await expect(runtimeLogs).toContainText("manual_runner");
      await expect(runtimeLogs).toContainText("stderr");
      await expect(runtimeLogs).toContainText("#1");
      await expect(runtimeLogs).not.toContainText(runner.id);
      await expect(runtimeLogs).not.toContainText("runnerId");
      await expect(runtimeLogs).not.toContainText("runner_id");

      await page.goto("/settings");

      const settingsRunnerPanel = page.locator(".manual-runner-panel", {
        hasText: "Registered runners",
      });
      await expect(settingsRunnerPanel).toContainText("Registered runners");
      await expect(settingsRunnerPanel).toContainText(`Manual Runner ${testInfo.project.name}`);
      await expect(settingsRunnerPanel).toContainText(`Online Runner ${testInfo.project.name}`);
      await expect(settingsRunnerPanel).toContainText("offline");
      await expect(settingsRunnerPanel).toContainText("online");
      await expect(settingsRunnerPanel).toContainText("1 / 1 agent running");
      await expect(settingsRunnerPanel).toContainText("3 / 5 agents running");
      await expect(settingsRunnerPanel).toContainText("Runner capacity reached");
      await expect(settingsRunnerPanel).toContainText("42%");
      await expect(settingsRunnerPanel).toContainText("1,024 / 4,096 MB");
      await expect(settingsRunnerPanel).toContainText("2,048 / 8,192 MB");
      await expect(settingsRunnerPanel).toContainText("bruno-runner/1.2.3");
      await expect(settingsRunnerPanel).toContainText("bruno-runner/2.0.0");
      await expect(settingsRunnerPanel).not.toContainText(runner.id);
      await expect(settingsRunnerPanel).not.toContainText(onlineRunner.id);
      await expect(settingsRunnerPanel).not.toContainText("credentialHash");
      await expect(settingsRunnerPanel).not.toContainText("tokenHash");
      await expect(settingsRunnerPanel).not.toContainText("cpuPercent");
      await expect(settingsRunnerPanel).not.toContainText("apiToken");

      const registrationFailureRoute = async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          contentType: "application/json",
          status: 503,
          body: JSON.stringify({
            error: {
              code: "database_unavailable",
              message: "postgres://user:pass@localhost/db bruno_reg_should_not_render",
            },
          }),
        });
      };
      await page.route("**/api/runners/registration-tokens", registrationFailureRoute);
      await settingsRunnerPanel.getByRole("button", { name: "Create Token" }).click();
      await expect(settingsRunnerPanel.getByRole("button", { name: "Creating…" })).toBeVisible();
      await expect(settingsRunnerPanel.locator(".form-message").last()).toContainText(
        "Registration token could not be created. Start the database and run migrations.",
      );
      await expect(settingsRunnerPanel).not.toContainText("postgres://");
      await expect(settingsRunnerPanel).not.toContainText("bruno_reg_should_not_render");
      await page.unroute("**/api/runners/registration-tokens", registrationFailureRoute);

      await settingsRunnerPanel.getByRole("button", { name: "Create Token" }).click();
      const registrationSecret = settingsRunnerPanel
        .locator(".visible-once-secret", { hasText: "Registration token" })
        .first();
      await expect(registrationSecret).toContainText("bruno_reg_");
      await expect(registrationSecret).toContainText("Expires");
      const registrationToken = await registrationSecret.locator("code").innerText();
      expect(registrationToken).toMatch(/^bruno_reg_/);
      await registrationSecret.getByRole("button", { name: "Dismiss" }).click();
      await expect(settingsRunnerPanel).not.toContainText(registrationToken);

      const managedRunnerItem = settingsRunnerPanel.locator(".manual-runner-item", {
        hasText: `Manual Runner ${testInfo.project.name}`,
      });
      const rotateValidationRoute = async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          contentType: "application/json",
          status: 400,
          body: JSON.stringify({
            ok: false,
            error: {
              code: "validation_failed",
              message: "bruno_run_validation_leak should not render",
            },
          }),
        });
      };
      await page.route("**/api/runners/*/credentials/rotate", rotateValidationRoute);
      await managedRunnerItem.getByRole("button", { name: "Rotate Credential" }).click();
      await expect(managedRunnerItem.getByRole("button", { name: "Rotating…" })).toBeVisible();
      await expect(managedRunnerItem.locator(".form-message").last()).toContainText(
        "Runner credential request was invalid.",
      );
      await expect(managedRunnerItem).not.toContainText("bruno_run_validation_leak");
      await page.unroute("**/api/runners/*/credentials/rotate", rotateValidationRoute);

      const rotateDelayRoute = async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      };
      await page.route("**/api/runners/*/credentials/rotate", rotateDelayRoute);
      await managedRunnerItem.getByRole("button", { name: "Rotate Credential" }).click();
      await expect(managedRunnerItem.getByRole("button", { name: "Rotating…" })).toBeVisible();
      const runnerCredentialSecret = managedRunnerItem
        .locator(".visible-once-secret", { hasText: "Runner credential" })
        .first();
      await expect(runnerCredentialSecret).toContainText("bruno_run_");
      await expect(runnerCredentialSecret).toContainText("Rotated");
      const rotatedCredential = await runnerCredentialSecret.locator("code").innerText();
      expect(rotatedCredential).toMatch(/^bruno_run_/);
      await page.unroute("**/api/runners/*/credentials/rotate", rotateDelayRoute);
      await expectRunnerHeartbeat(request, runner.id, oldRunnerCredential, 401);
      await runnerCredentialSecret.getByRole("button", { name: "Dismiss" }).click();
      await expect(managedRunnerItem).not.toContainText(rotatedCredential);

      await managedRunnerItem.getByRole("button", { name: "Revoke Credential" }).click();
      await expect(managedRunnerItem.locator(".form-message").last()).toContainText(
        "Confirm revocation to stop this runner credential from authenticating.",
      );
      const revokeDelayRoute = async (route: Route) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.continue();
      };
      await page.route("**/api/runners/*/credentials/revoke", revokeDelayRoute);
      await managedRunnerItem.getByRole("button", { name: "Confirm Revoke" }).click();
      await expect(managedRunnerItem.getByRole("button", { name: "Revoking…" })).toBeVisible();
      await expect(managedRunnerItem.locator(".form-message").last()).toContainText(
        "can no longer authenticate",
      );
      await page.unroute("**/api/runners/*/credentials/revoke", revokeDelayRoute);
      await expectRunnerHeartbeat(request, runner.id, rotatedCredential, 401);
      await expect(settingsRunnerPanel).not.toContainText("credentialHash");
      await expect(settingsRunnerPanel).not.toContainText("tokenHash");
      await expect(settingsRunnerPanel).not.toContainText("postgres://");

      await page.reload();
      await expect(settingsRunnerPanel).not.toContainText(registrationToken);
      await expect(settingsRunnerPanel).not.toContainText(rotatedCredential);
      await expect(settingsRunnerPanel).not.toContainText(oldRunnerCredential);
      await expectPageNotHorizontallyOverflowing(page);
    });
  } finally {
    await deleteCreatedAgents([created.id]);
    await deleteRunnerRows(localRunnerIds);
  }
});

test("cloud runner create action and provisioning status stay visible and safe", async ({
  page,
  request,
}, testInfo) => {
  const name = `Cloud Runner UI Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  const cloudRunnerIds: string[] = [];

  try {
    const failedRunner = await insertCloudRunnerForAgent(created.id, {
      name: `Failed Cloud Runner ${testInfo.project.name}`,
      status: "provision_failed",
      providerResourceId: null,
      region: "nyc3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "failed",
      provisioningError: "token=stored-for-downstream",
      provisioningStartedAt: "2026-07-06T01:00:00.000Z",
      provisioningCompletedAt: "2026-07-06T01:02:00.000Z",
    });
    cloudRunnerIds.push(failedRunner.id);
    const onlineRunner = await insertCloudRunnerForAgent(created.id, {
      name: `Online Cloud Runner ${testInfo.project.name}`,
      status: "online",
      providerResourceId: `do-${randomUUID()}`,
      region: "sfo3",
      sizeSlug: "s-2vcpu-2gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "ready",
      provisioningError: null,
      provisioningStartedAt: "2026-07-06T01:05:00.000Z",
      provisioningCompletedAt: "2026-07-06T01:08:00.000Z",
    });
    cloudRunnerIds.push(onlineRunner.id);
    await insertRunnerHeartbeat(onlineRunner.id, {
      status: "online",
      version: "bruno-runner/3.0.0",
      observedAt: "2026-07-06T01:09:00.000Z",
    });

    await withPinnedDevelopmentUserForAgent(created.id, async () => {
      await page.goto("/settings");

      const cloudPanel = page.locator(".cloud-runner-panel", { hasText: "Cloud runners" });
      await expect(cloudPanel).toContainText(`Failed Cloud Runner ${testInfo.project.name}`);
      await expect(cloudPanel).toContainText(`Online Cloud Runner ${testInfo.project.name}`);
      await expect(cloudPanel).toContainText("failed");
      await expect(cloudPanel).toContainText("online");
      await expect(cloudPanel).toContainText("nyc3");
      await expect(cloudPanel).toContainText("s-1vcpu-1gb");
      await expect(cloudPanel).toContainText("ubuntu-24-04-x64");
      await expect(cloudPanel).toContainText("2026-07-06T01:09:00.000Z");
      await expect(cloudPanel).toContainText("Next step: check the provider configuration");
      await expect(cloudPanel).not.toContainText("token=stored-for-downstream");
      await expect(cloudPanel).not.toContainText("BRUNO_DIGITALOCEAN_TOKEN");
      await expect(cloudPanel).not.toContainText("bruno_reg_");
      await expect(cloudPanel).not.toContainText("bruno_run_");
      await expect(cloudPanel).not.toContainText("credentialHash");

      await deleteRunnerRows(cloudRunnerIds.splice(0));
      await page.reload();
      await expect(cloudPanel).toContainText("No cloud runners");

      await page.route("**/api/runners", async (route) => {
        if (route.request().method() !== "POST") {
          await route.fallback();
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            duplicate: false,
            runner: {
              id: "00000000-0000-4000-8000-000000000154",
              name: "DigitalOcean Runner",
              kind: "digitalocean",
              status: "provisioning",
              provider: "digitalocean",
              providerResourceId: null,
              region: "nyc3",
              sizeSlug: "s-1vcpu-1gb",
              image: "ubuntu-24-04-x64",
              provisioning: {
                status: "pending",
                error: null,
                startedAt: "2026-07-06T01:10:00.000Z",
                completedAt: null,
                phases: [],
              },
            },
          }),
        });
      });
      const createResponsePromise = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/runners") && response.request().method() === "POST",
      );
      await cloudPanel.getByRole("button", { name: "Create Runner" }).click();
      await expect(cloudPanel.getByRole("button", { name: "Creating…" })).toBeVisible();
      const createResponse = await createResponsePromise;
      expect(createResponse.status()).toBe(201);
      const createBody = (await createResponse.json()) as {
        runner?: {
          id?: string;
        };
      };
      expect(createBody.runner?.id).toBe("00000000-0000-4000-8000-000000000154");
      await page.unroute("**/api/runners");

      await expect(cloudPanel).toContainText("Cloud runner provisioning started at pending.");
      const pendingRunner = await insertCloudRunnerForAgent(created.id, {
        name: "DigitalOcean Runner",
        status: "provisioning",
        providerResourceId: null,
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "pending",
        provisioningError: null,
        provisioningStartedAt: "2026-07-06T01:10:00.000Z",
        provisioningCompletedAt: null,
      });
      cloudRunnerIds.push(pendingRunner.id);

      await page.reload();
      await expect(cloudPanel).toContainText("DigitalOcean Runner");
      await expect(cloudPanel).toContainText("pending");
      await expect(cloudPanel).toContainText("provisioning");
      await expect(cloudPanel).not.toContainText("registrationToken");
      await expect(cloudPanel).not.toContainText("bruno_reg_");
      await expect(cloudPanel).not.toContainText("bruno_run_");

      await expectPageNotHorizontallyOverflowing(page);
    });
  } finally {
    await deleteCreatedAgents([created.id]);
    await deleteRunnerRows(cloudRunnerIds);
  }
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

test("/dashboard shows Docker logs captured by observing a running agent", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(isMobile, "Docker log capture dashboard proof runs once on desktop");

  const name = `Docker Log Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  createdAgentIds.add(created.id);

  await page.goto(`/agents/${created.id}`);
  await page.getByRole("button", { name: "Start" }).click();
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(async () => {
    await pinDevelopmentUserToAgent(created.id);
    const logsResponse = await request.get(`/api/agents/${created.id}/logs`);
    expect(logsResponse.status()).toBe(200);
    const logsBody = (await logsResponse.json()) as { logs: { message: string }[] };
    expect(logsBody.logs.map((log) => log.message)).toContain(
      `bruno docker dummy runner started for ${created.id}`,
    );
  }).toPass({ timeout: 5_000 });

  await pinDevelopmentUserToAgent(created.id);
  await page.goto("/dashboard");

  const processLogsPanel = page.locator(".dashboard-process-log-panel");
  await expect(processLogsPanel).toContainText("Latest process logs");
  const capturedLog = processLogsPanel.locator(".runtime-log-item", {
    hasText: `bruno docker dummy runner started for ${created.id}`,
  });
  await expect(capturedLog.getByRole("link", { name })).toHaveAttribute(
    "href",
    `/agents/${created.id}`,
  );
  await expect(capturedLog).toContainText(`bruno docker dummy runner started for ${created.id}`);
  await expect(capturedLog).toContainText("stdout");
  await expect(capturedLog).toContainText("info");
  await expect(capturedLog).not.toContainText("dockerRunnerContainerId");
  await expect(capturedLog).not.toContainText("agent_id");
  await expect(capturedLog).not.toContainText("postgres://");
});

test("/dashboard Docker runner final acceptance keeps selected containers isolated", async ({
  isMobile,
  request,
}, testInfo) => {
  test.setTimeout(90_000);
  test.skip(isMobile, "Docker runner final acceptance smoke runs once on desktop");

  const docker = await detectDockerForE2e();
  if (!docker.available) {
    test.skip(true, docker.reason);
  }

  const fixtureImage = await ensureDockerImage(DOCKER_RUNNER_FIXTURE_IMAGE);
  if (!fixtureImage.available) {
    test.skip(true, fixtureImage.reason);
  }
  await deferDockerAcceptanceSmokeWhenSuiteIsParallel(testInfo);

  const primary = await createAgent(request, `Docker Acceptance Primary ${testInfo.project.name}`);
  const sibling = await createAgent(
    request,
    `Docker Acceptance Sibling ${testInfo.project.name}`,
    "github_issue_agent",
  );
  const tamper = await createAgent(
    request,
    `Docker Acceptance Fail Closed ${testInfo.project.name}`,
  );
  createdAgentIds.add(primary.id);
  createdAgentIds.add(sibling.id);
  createdAgentIds.add(tamper.id);
  const cleanupAgentIds = [primary.id, sibling.id, tamper.id];
  const cleanupContainerIds = new Set<string>();

  try {
    await expectAgentAction(request, primary.id, "start", 202);
    await expectAgentAction(request, sibling.id, "start", 202);

    const primaryStarted = await expectLatestDockerContainer(primary.id, "running");
    const siblingStarted = await expectLatestDockerContainer(sibling.id, "running");
    cleanupContainerIds.add(primaryStarted.containerId);
    cleanupContainerIds.add(siblingStarted.containerId);
    expect(await countDockerContainersForAgent(primary.id)).toBe(1);
    expect(await countDockerContainersForAgent(sibling.id)).toBe(1);
    await expectDockerContainer(primaryStarted.containerId, primary.id, "running");
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");

    const primaryLogs = await expectAgentLogs(request, primary.id);
    const siblingLogs = await expectAgentLogs(request, sibling.id);
    expect(primaryLogs).toContain(`bruno docker dummy runner started for ${primary.id}`);
    expect(primaryLogs).not.toContain(sibling.id);
    expect(siblingLogs).toContain(`bruno docker dummy runner started for ${sibling.id}`);
    expect(siblingLogs).not.toContain(primary.id);

    await expectAgentAction(request, primary.id, "restart", 202);
    const primaryRestarted = await expectRunningReplacementDockerContainer(
      primary.id,
      primaryStarted.containerId,
    );
    cleanupContainerIds.add(primaryRestarted.containerId);
    expect(primaryRestarted.containerId).not.toBe(primaryStarted.containerId);
    await expectDockerContainer(primaryRestarted.containerId, primary.id, "running");
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");

    await expectAgentAction(request, primary.id, "stop", 200);
    const primaryStopped = await expectDockerContainerMetadata(
      primary.id,
      primaryRestarted.containerId,
      "exited",
    );
    expect(primaryStopped.containerId).toBe(primaryRestarted.containerId);
    await expectDockerContainer(primaryRestarted.containerId, primary.id, "exited");
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");

    await expectAgentAction(request, primary.id, "start", 202);
    const primaryCrashTarget = await expectRunningReplacementDockerContainer(
      primary.id,
      primaryRestarted.containerId,
    );
    cleanupContainerIds.add(primaryCrashTarget.containerId);
    await runDocker(["kill", "--signal", "KILL", primaryCrashTarget.containerId]);
    await expect
      .poll(
        async () => {
          await request.get(`/agents/${primary.id}`);
          return (await getAgentStatus(primary.id))?.status;
        },
        { timeout: 10_000 },
      )
      .toBe("error");
    const primaryCrashLogs = await expectAgentLogs(request, primary.id);
    expect(primaryCrashLogs).toContain("Docker runner container exited unexpectedly");
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");

    const deletePrimary = await request.delete(`/api/agents/${primary.id}`);
    expect(deletePrimary.status()).toBe(200);
    await expectDockerContainerRemoved(primaryCrashTarget.containerId);
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");

    await expectAgentAction(request, tamper.id, "start", 202);
    const tamperStarted = await expectLatestDockerContainer(tamper.id, "running");
    cleanupContainerIds.add(tamperStarted.containerId);
    await pointLatestDockerContainerAtOtherAgent({
      sourceAgentId: tamper.id,
      targetAgentId: sibling.id,
      targetContainer: siblingStarted,
    });

    const failedDelete = await request.delete(`/api/agents/${tamper.id}`);
    expect(failedDelete.status()).toBe(500);
    expect(await failedDelete.json()).toEqual({
      error: {
        code: "agent_delete_failed",
        message: "Agent could not be deleted.",
      },
    });
    expect(await getAgentStatus(tamper.id)).toMatchObject({
      deletedAt: null,
    });
    await expectDockerContainer(siblingStarted.containerId, sibling.id, "running");
    await expectDockerContainer(tamperStarted.containerId, tamper.id, "running");
  } finally {
    await removeDockerContainersByIds([...cleanupContainerIds]);

    for (const agentId of cleanupAgentIds) {
      await removeDockerContainersForAgent(agentId);
    }
  }
});

test("a persisted compatibility record remains available across read surfaces", async ({
  isMobile,
  page,
}) => {
  test.skip(isMobile, "final exact-name Milestone 1 smoke path runs once on desktop");

  const name = "Research Agent";

  const created = await page.request.post("/api/agents", {
    data: { name, templateKey: "research_agent", runnerId: null },
  });
  expect(created.status()).toBe(201);
  const createdBody = (await created.json()) as { agent: { id: string } };
  const agentHref = `/agents/${createdBody.agent.id}`;
  trackAgentHref(agentHref);
  await page.goto("/agents");

  const agentLink = page.getByRole("link", { name });
  await expect(agentLink).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();
  await expect(agentLink).toHaveAttribute("href", agentHref);

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
  await page.waitForTimeout(750);
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
  await expect(detailRecord).toContainText("Template version");
  await expect(detailRecord).toContainText("1.0.0");
  await expect(detailRecord).toContainText("Simulated error requested for development testing.");
  await expect(detailRecord).toContainText("Created");
  await expect(detailRecord).toContainText("Updated");
  const templateSettings = page
    .locator(".placeholder-panel")
    .filter({ hasText: "Template settings" });
  await expect(templateSettings).toContainText("Default tools");
  await expect(templateSettings).toContainText("Web search, Notes, Summaries");
  await expect(templateSettings).toContainText("Schedule");
  await expect(templateSettings).toContainText("Manual");
  await expect(templateSettings).toContainText("Default prompt");
  await expect(templateSettings).toContainText("You are a Research Agent.");
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
  await page.waitForTimeout(750);
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

test("/agents detail shows backup status and runs backup restore controls safely", async ({
  isMobile,
  page,
  request,
}, testInfo) => {
  test.skip(isMobile, "backup control smoke runs once on desktop");

  const name = `Backup UI Agent ${testInfo.project.name}`;
  const created = await createAgent(request, name);
  createdAgentIds.add(created.id);
  const backupId = await insertBackupSummaryFixture(created.id, name);
  const restoredAgentId = randomUUID();

  await page.route(`**/api/agents/${created.id}/backups`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        ok: true,
        backup: {
          id: randomUUID(),
          agentId: created.id,
          runnerId: null,
          status: "ready",
          createdAt: "2026-07-06T05:20:00.000Z",
          restoredAt: null,
        },
        event: { type: "backup.created" },
      }),
    });
  });
  await page.route(`**/api/agents/${created.id}/backups/${backupId}/restore`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }

    await route.fulfill({
      contentType: "application/json",
      status: 201,
      body: JSON.stringify({
        ok: true,
        backup: {
          id: backupId,
          agentId: created.id,
          runnerId: null,
          status: "restored",
          createdAt: "2026-07-06T05:10:00.000Z",
          restoredAt: "2026-07-06T05:21:00.000Z",
        },
        restoredAgent: {
          id: restoredAgentId,
          name: `${name} (restored)`,
          status: "stopped",
        },
        event: { type: "backup.restored" },
      }),
    });
  });

  await withPinnedDevelopmentUserForAgent(created.id, async () => {
    await page.goto(`/agents/${created.id}`);

    const backupPanel = page.locator(".backup-panel");
    await expect(backupPanel).toContainText("Backups");
    await expect(backupPanel).toContainText("ready");
    await expect(backupPanel).toContainText("2026-07-06T05:10:00.000Z");
    await expect(backupPanel).toContainText("Not restored");
    await expect(backupPanel).toContainText(backupId);
    await expect(backupPanel).not.toContainText("s3://");
    await expect(backupPanel).not.toContainText("bruno-backups");
    await expect(backupPanel).not.toContainText("manifestJson");
    await expect(backupPanel).not.toContainText("storageUri");
    await expect(backupPanel).not.toContainText("sk-");

    await backupPanel.getByRole("button", { name: "Create backup" }).click();
    await expect(backupPanel.getByRole("status")).toContainText("Manual backup created.");

    await backupPanel.getByRole("button", { name: "Restore backup" }).click();
    await expect(backupPanel.getByRole("status")).toContainText(`Restored ${name} (restored).`);
    await expect(backupPanel.getByRole("link", { name: "Open restored agent" })).toHaveAttribute(
      "href",
      `/agents/${restoredAgentId}`,
    );
    await expect(backupPanel).not.toContainText("BRUNO_BACKUP_STORAGE");
    await expect(backupPanel).not.toContainText("token=stored-for-downstream");
  });
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
  await expect(page.locator(".status-pill", { hasText: "running" })).toBeVisible({
    timeout: 5_000,
  });
  await pinDevelopmentUserToAgent(primaryAgent.id);
  const logsResponse = await request.get(`/api/agents/${primaryAgent.id}/logs`);
  expect(logsResponse.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("heading", { name: primaryName })).toBeVisible();
  await expect(primaryRuntimeLogs).toContainText(
    `bruno docker dummy runner started for ${primaryAgent.id}`,
  );
  await expect(primaryRuntimeLogs).toContainText(
    `bruno docker dummy runner stderr ready for ${primaryAgent.id}`,
  );
  await expect(primaryRuntimeLogs).toContainText("stdout");
  await expect(primaryRuntimeLogs).toContainText("stderr");
  await expect(primaryRuntimeLogs).toContainText("info");
  await expect(primaryRuntimeLogs).toContainText("error");
  await expect(primaryRuntimeLogs).toContainText("#1");
  await expect(primaryRuntimeLogs).not.toContainText("agent_id");
  await expect(primaryRuntimeLogs).not.toContainText("runner_id");
  await expect(primaryRuntimeLogs).not.toContainText("postgres://");
  const primaryLogItems = primaryRuntimeLogs.locator(".runtime-log-item");
  await expect(primaryLogItems.first()).toBeVisible();
  await expect(primaryLogItems.nth(1)).toBeVisible();

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.locator(".status-pill", { hasText: "stopped" })).toBeVisible({
    timeout: 5_000,
  });
  const stoppedLogCount = await primaryLogItems.count();
  await page.waitForTimeout(2_000);
  await expect(primaryLogItems).toHaveCount(stoppedLogCount);

  await page.getByRole("button", { name: "Simulate error" }).click();
  await expect(page.locator(".status-pill", { hasText: "error" })).toBeVisible({
    timeout: 5_000,
  });
  await expect(primaryRuntimeLogs).toContainText(
    `bruno docker dummy runner started for ${primaryAgent.id}`,
  );
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
    await expect(alertPanel).toContainText("No assigned manual runner state is available");
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
  await page.getByLabel("What should we call your agent?").fill("   ");
  await page.getByRole("button", { name: "Create my agent" }).click();

  const setupAlert = page.locator(".agent-creation-panel .form-message[role='alert']");
  await expect(setupAlert).toContainText("Name is required.");
  await expect(setupAlert).not.toContainText("postgres://");
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

test("/dashboard shows accessible daily and monthly cost estimates without infrastructure secrets", async ({
  page,
}, testInfo) => {
  const created = await insertCostAgentFixture(`Cost Summary Agent ${testInfo.project.name}`);
  createdAgentIds.add(created.id);
  const runnerName = `dop_v1_secret-looking-cost-runner-${testInfo.project.name}`;
  const providerResourceId = `do-secret-${randomUUID()}`;
  const runner = await insertCloudRunnerForAgent(created.id, {
    name: runnerName,
    status: "online",
    providerResourceId,
    region: "nyc3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    provisioningStatus: "ready",
    provisioningError: null,
    provisioningStartedAt: new Date(Date.now() - 13 * 60 * 60 * 1_000).toISOString(),
    provisioningCompletedAt: new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString(),
  });
  createdRunnerIds.add(runner.id);

  try {
    await startCostUsageFixture(created.id, runner.id);
    await withPinnedDevelopmentUserForAgent(created.id, async () => {
      await page.goto("/dashboard");

      const costPanel = page.getByRole("region", { name: "Infrastructure cost estimates" });
      await expect(costPanel).toBeVisible();
      await expect(costPanel.getByRole("heading", { name: "Daily estimate" })).toBeVisible();
      await expect(costPanel.getByRole("heading", { name: "Monthly estimate" })).toBeVisible();
      await expect(costPanel).toContainText("Estimated runner monthly cost");
      await expect(costPanel).toContainText("Estimated daily infrastructure cost");
      await expect(costPanel).toContainText("Estimated monthly infrastructure cost");
      await expect(costPanel).toContainText("Estimated infrastructure cost per agent");
      await expect(costPanel).toContainText("1 running");
      await expect(costPanel.getByText("$6.00", { exact: true })).toHaveCount(2);
      await expect(costPanel).toContainText("Raw compute estimate only");
      await expect(costPanel).not.toContainText(created.id);
      await expect(costPanel).not.toContainText(runner.id);
      await expect(costPanel).not.toContainText(runnerName);
      await expect(costPanel).not.toContainText(providerResourceId);
      await expect(costPanel).not.toContainText("runnerId");
      await expect(costPanel).not.toContainText("endpointUrl");
      await expect(costPanel).not.toContainText("credential");
      await expectPageNotHorizontallyOverflowing(page);
    });
  } finally {
    await stopCostUsageFixture(created.id);
  }
});

test("/dashboard keeps manual runner estimates unavailable instead of showing zero", async ({
  isMobile,
  page,
}, testInfo) => {
  test.skip(isMobile, "manual-price unavailable browser proof runs once on desktop");

  const created = await insertCostAgentFixture(`Manual Cost Agent ${testInfo.project.name}`);
  createdAgentIds.add(created.id);
  const runner = await insertManualRunnerForAgent(created.id, {
    name: `Manual Cost Runner ${testInfo.project.name}`,
    endpointUrl: `https://user:password@manual-cost-${randomUUID()}.example.com?token=hidden`,
    status: "online",
    updatedAt: new Date().toISOString(),
  });
  createdRunnerIds.add(runner.id);

  await withPinnedDevelopmentUserForAgent(created.id, async () => {
    await page.goto("/dashboard");

    const costPanel = page.getByRole("region", { name: "Infrastructure cost estimates" });
    await expect(costPanel).toContainText("Estimate unavailable");
    await expect(costPanel).toContainText(
      "A total is unavailable because at least one runner does not have provider price metadata.",
    );
    await expect(costPanel).toContainText(
      "Manual runners and unknown provider prices remain unavailable until price metadata is configured.",
    );
    await expect(costPanel).not.toContainText("$0.00");
    await expect(costPanel).not.toContainText(runner.id);
    await expect(costPanel).not.toContainText("password");
    await expect(costPanel).not.toContainText("token=hidden");
  });
});

function trackAgentHref(agentHref: string | null): void {
  const agentId = agentHref?.match(/^\/agents\/([0-9a-f-]+)$/)?.[1];

  if (agentId) {
    createdAgentIds.add(agentId);
  }
}

type DockerContainerRow = {
  containerId: string;
  containerName: string;
  observedStatus: string;
};

type AgentStatusRow = {
  deletedAt: string | null;
  status: string;
};

type DockerInspect = {
  Config?: {
    Labels?: Record<string, string> | null;
  };
  State?: {
    Status?: string;
  };
};

async function expectAgentAction(
  request: APIRequestContext,
  agentId: string,
  action: "restart" | "start" | "stop",
  expectedStatus: number,
): Promise<void> {
  const response = await request.post(`/api/agents/${agentId}/actions/${action}`);
  const body = await response.json();

  expect(response.status()).toBe(expectedStatus);
  expect(body).toMatchObject({
    ok: true,
    agent: {
      id: agentId,
    },
  });
}

async function expectLatestDockerContainer(
  agentId: string,
  expectedStatus: string,
): Promise<DockerContainerRow> {
  const container = await getLatestDockerContainer(agentId);

  expect(container).toMatchObject({
    observedStatus: expectedStatus,
  });

  if (!container) {
    throw new Error(`Expected Docker container metadata for agent ${agentId}.`);
  }

  return container;
}

async function expectRunningReplacementDockerContainer(
  agentId: string,
  previousContainerId: string,
): Promise<DockerContainerRow> {
  await expect
    .poll(
      async () => {
        const containers = await getDockerContainersForAgent(agentId);
        return (
          containers.find(
            (container) =>
              container.containerId !== previousContainerId &&
              container.observedStatus === "running",
          )?.containerId ?? null
        );
      },
      { timeout: 10_000 },
    )
    .not.toBeNull();

  const replacement = (await getDockerContainersForAgent(agentId)).find(
    (container) =>
      container.containerId !== previousContainerId && container.observedStatus === "running",
  );

  if (!replacement) {
    throw new Error(`Expected replacement Docker container metadata for agent ${agentId}.`);
  }

  return replacement;
}

async function expectDockerContainerMetadata(
  agentId: string,
  containerId: string,
  expectedStatus: string,
): Promise<DockerContainerRow> {
  await expect
    .poll(
      async () => {
        const container = await getDockerContainerForAgent(agentId, containerId);
        return container?.observedStatus ?? null;
      },
      { timeout: 10_000 },
    )
    .toBe(expectedStatus);

  const container = await getDockerContainerForAgent(agentId, containerId);

  if (!container) {
    throw new Error(`Expected Docker container ${containerId} metadata for agent ${agentId}.`);
  }

  return container;
}

async function getLatestDockerContainer(agentId: string): Promise<DockerContainerRow | null> {
  const [container] = await getDockerContainersForAgent(agentId);

  return container ?? null;
}

async function getDockerContainerForAgent(
  agentId: string,
  containerId: string,
): Promise<DockerContainerRow | null> {
  return (
    (await getDockerContainersForAgent(agentId)).find(
      (container) => container.containerId === containerId,
    ) ?? null
  );
}

async function getDockerContainersForAgent(agentId: string): Promise<DockerContainerRow[]> {
  return await withDatabase(async (sql) => {
    return await sql<DockerContainerRow[]>`
      select
        container_id as "containerId",
        container_name as "containerName",
        observed_status as "observedStatus"
      from docker_runner_containers
      where agent_id = ${agentId}
      order by observed_at desc, created_at desc
    `;
  });
}

async function getAgentStatus(agentId: string): Promise<AgentStatusRow | null> {
  return await withDatabase(async (sql) => {
    const [agent] = await sql<AgentStatusRow[]>`
      select
        status,
        deleted_at as "deletedAt"
      from agents
      where id = ${agentId}
      limit 1
    `;

    return agent ?? null;
  });
}

async function expectAgentLogs(request: APIRequestContext, agentId: string): Promise<string> {
  await pinDevelopmentUserToAgent(agentId);
  const response = await request.get(`/api/agents/${agentId}/logs?limit=100`);
  const body = (await response.json()) as {
    logs: Array<{
      message: string;
    }>;
  };

  expect(response.status()).toBe(200);

  return body.logs.map((log) => log.message).join("\n");
}

async function pointLatestDockerContainerAtOtherAgent(input: {
  sourceAgentId: string;
  targetAgentId: string;
  targetContainer: DockerContainerRow;
}): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      update docker_runner_containers
      set
        container_id = ${`${input.targetContainer.containerId}-detached-for-fail-closed-test`},
        container_name = ${`${input.targetContainer.containerName}-detached-for-fail-closed-test`},
        updated_at = now()
      where agent_id = ${input.targetAgentId}
    `;
    await sql`
      update docker_runner_containers
      set
        container_id = ${input.targetContainer.containerId},
        container_name = ${input.targetContainer.containerName},
        updated_at = now()
      where id = (
        select id
        from docker_runner_containers
        where agent_id = ${input.sourceAgentId}
        order by observed_at desc, created_at desc
        limit 1
      )
    `;
  });
}

async function detectDockerForE2e(): Promise<
  | {
      available: true;
    }
  | {
      available: false;
      reason: string;
    }
> {
  try {
    await runDocker(["info", "--format", "{{.ServerVersion}}"]);

    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: `Skipping real Docker acceptance smoke: ${describeDockerError(error)}`,
    };
  }
}

async function ensureDockerImage(image: string): Promise<
  | {
      available: true;
    }
  | {
      available: false;
      reason: string;
    }
> {
  try {
    await runDocker(["image", "inspect", image]);

    return { available: true };
  } catch {
    try {
      await runDocker(["pull", image]);

      return { available: true };
    } catch (error) {
      return {
        available: false,
        reason: `Skipping real Docker acceptance smoke: ${describeDockerError(error)}`,
      };
    }
  }
}

async function deferDockerAcceptanceSmokeWhenSuiteIsParallel(testInfo: {
  config: {
    workers: number;
  };
}): Promise<void> {
  if (testInfo.config.workers <= 1) {
    return;
  }

  // The aggregate suite already has Docker lifecycle coverage. Defer this heavier final smoke
  // so it does not starve older 5-second lifecycle assertions when Playwright runs workers.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 15_000);
  });
}

async function countDockerContainersForAgent(agentId: string): Promise<number> {
  const result = await runDocker([
    "ps",
    "-a",
    "--filter",
    `label=${BRUNO_AGENT_ID_LABEL}=${agentId}`,
    "--format",
    "{{.ID}}",
  ]);

  return result.stdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().length > 0).length;
}

async function expectDockerContainer(
  containerId: string,
  agentId: string,
  expectedStatus: string,
): Promise<void> {
  const inspect = await inspectDockerContainer(containerId);

  expect(inspect.Config?.Labels?.[BRUNO_AGENT_ID_LABEL]).toBe(agentId);
  expect(inspect.State?.Status).toBe(expectedStatus);
}

async function expectDockerContainerRemoved(containerId: string): Promise<void> {
  await expect(runDocker(["inspect", containerId])).rejects.toThrow();
}

async function inspectDockerContainer(containerId: string): Promise<DockerInspect> {
  const result = await runDocker(["inspect", "--format", "{{json .}}", containerId]);
  const parsed = JSON.parse(result.stdout.trim()) as DockerInspect;

  return parsed;
}

async function removeDockerContainersForAgent(agentId: string): Promise<void> {
  const containerIds = await listDockerContainerIdsForAgent(agentId);

  await removeDockerContainersByIds(containerIds);

  await expect
    .poll(async () => await listDockerContainerIdsForAgent(agentId), { timeout: 10_000 })
    .toEqual([]);
}

async function removeOrphanedStoppedBrunoDockerContainers(): Promise<void> {
  const removableStatuses = ["created", "exited", "dead"] as const;

  for (const status of removableStatuses) {
    await removeDockerContainersByIds(await listOrphanedBrunoDockerContainerIdsByStatus(status));
  }

  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            removableStatuses.map((status) => listOrphanedBrunoDockerContainerIdsByStatus(status)),
          )
        ).flat(),
      { timeout: 10_000 },
    )
    .toEqual([]);
}

async function listDockerContainerIdsForAgent(agentId: string): Promise<string[]> {
  const result = await runDocker([
    "ps",
    "-a",
    "--quiet",
    "--filter",
    `label=${BRUNO_AGENT_ID_LABEL}=${agentId}`,
  ]).catch(() => ({ stdout: "", stderr: "" }));

  return result.stdout
    .trim()
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

async function listOrphanedBrunoDockerContainerIdsByStatus(status: string): Promise<string[]> {
  const result = await runDocker([
    "ps",
    "-a",
    "--format",
    `{{.ID}}\t{{.Label "${BRUNO_AGENT_ID_LABEL}"}}`,
    "--filter",
    `label=${BRUNO_AGENT_ID_LABEL}`,
    "--filter",
    `status=${status}`,
  ]).catch(() => ({ stdout: "", stderr: "" }));
  const containers = result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      const [containerId, agentId] = line.trim().split("\t");

      return {
        agentId: agentId?.trim() ?? "",
        containerId: containerId?.trim() ?? "",
      };
    })
    .filter((container) => container.containerId.length > 0);

  if (containers.length === 0) {
    return [];
  }

  const existingAgentIds = await getExistingAgentIds(
    containers.map((container) => container.agentId),
  );

  return containers
    .filter((container) => !existingAgentIds.has(container.agentId))
    .map((container) => container.containerId);
}

async function getExistingAgentIds(agentIds: string[]): Promise<Set<string>> {
  const uniqueAgentIds = [...new Set(agentIds.filter((agentId) => agentId.length > 0))];

  if (uniqueAgentIds.length === 0) {
    return new Set();
  }

  return await withDatabase(async (sql) => {
    const rows = await sql<{ id: string }[]>`
      select id
      from agents
      where id in ${sql(uniqueAgentIds)}
    `;

    return new Set(rows.map((row) => row.id));
  });
}

async function removeDockerContainersByIds(containerIds: string[]): Promise<void> {
  const uniqueContainerIds = [
    ...new Set(containerIds.filter((containerId) => containerId.length > 0)),
  ];

  for (const containerId of uniqueContainerIds) {
    await expect
      .poll(
        async () => {
          const inspect = await runDocker(["inspect", containerId]).catch(() => null);

          if (!inspect) {
            return "removed";
          }

          await runDocker(["rm", "--force", containerId]).catch(() => undefined);

          return "present";
        },
        { timeout: 10_000 },
      )
      .toBe("removed");
  }
}

function runDocker(args: readonly string[]): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stderr, stdout });
      },
    );
  });
}

function describeDockerError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }

  return "Docker command failed.";
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

async function insertCostAgentFixture(name: string): Promise<{ id: string }> {
  return await withDatabase(async (sql) => {
    const [user] = await sql<{ id: string }[]>`
      insert into users default values
      returning id
    `;
    const [agent] = await sql<{ id: string }[]>`
      insert into agents (user_id, name, template_key, status)
      values (${user?.id ?? ""}, ${name}, 'research_agent', 'stopped')
      returning id
    `;

    expect(agent?.id).toMatch(/^[0-9a-f-]+$/);

    return { id: agent?.id ?? "" };
  });
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

async function insertBackupSummaryFixture(agentId: string, agentName: string): Promise<string> {
  return await withDatabase(async (sql) => {
    const [agent] = await sql<{ user_id: string }[]>`
      select user_id from agents where id = ${agentId} limit 1
    `;
    const backupId = randomUUID();

    expect(agent).toBeDefined();
    await sql`
      insert into backups (
        id,
        agent_id,
        runner_id,
        status,
        storage_uri,
        manifest_json,
        created_by,
        created_at
      )
      values (
        ${backupId},
        ${agentId},
        null,
        'ready',
        ${`s3://bruno-backups/agents/${agentId}/backups/${backupId}.json`},
        ${sql.json(validBackupManifestForE2e(agentId, agentName))},
        ${agent?.user_id ?? ""},
        '2026-07-06T05:10:00.000Z'
      )
    `;

    return backupId;
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

async function insertManualRunnerForAgent(
  agentId: string,
  runner: {
    name: string;
    endpointUrl: string;
    status: "active" | "inactive" | "online" | "offline" | "degraded";
    updatedAt: string;
  },
  options: { assign?: boolean } = {},
): Promise<{ id: string; endpointUrl: string }> {
  let runnerId = "";
  const shouldAssign = options.assign ?? true;

  await withDatabase(async (sql) => {
    const [inserted] = await sql<{ id: string }[]>`
      insert into runners (
        user_id,
        name,
        kind,
        endpoint_url,
        status,
        created_at,
        updated_at
      )
      select user_id,
             ${runner.name},
             'manual_vps',
             ${runner.endpointUrl},
             ${runner.status},
             ${runner.updatedAt},
             ${runner.updatedAt}
      from agents
      where id = ${agentId}
      returning id
    `;

    runnerId = inserted?.id ?? "";
    expect(runnerId).toMatch(/^[0-9a-f-]+$/);

    if (shouldAssign) {
      await sql`
        update agents
        set runner_id = ${runnerId},
            updated_at = ${runner.updatedAt}
        where id = ${agentId}
      `;
    }
  });

  return {
    id: runnerId,
    endpointUrl: runner.endpointUrl,
  };
}

async function insertCloudRunnerForAgent(
  agentId: string,
  runner: {
    name: string;
    status: "provisioning" | "provision_failed" | "online" | "offline" | "degraded";
    providerResourceId: string | null;
    region: string;
    sizeSlug: string;
    image: string;
    provisioningStatus:
      | "pending"
      | "creating"
      | "tagging"
      | "firewall_configuring"
      | "bootstrapping"
      | "waiting_for_runner"
      | "ready"
      | "failed";
    provisioningError: string | null;
    provisioningStartedAt: string;
    provisioningCompletedAt: string | null;
  },
): Promise<{ id: string }> {
  let runnerId = "";

  await withDatabase(async (sql) => {
    const [inserted] = await sql<{ id: string }[]>`
      insert into runners (
        user_id,
        name,
        kind,
        status,
        provider,
        provider_resource_id,
        region,
        size_slug,
        image,
        provisioning_status,
        provisioning_error,
        provisioning_started_at,
        provisioning_completed_at,
        created_at,
        updated_at
      )
      select user_id,
             ${runner.name},
             'digitalocean',
             ${runner.status},
             'digitalocean',
             ${runner.providerResourceId},
             ${runner.region},
             ${runner.sizeSlug},
             ${runner.image},
             ${runner.provisioningStatus},
             ${runner.provisioningError},
             ${runner.provisioningStartedAt},
             ${runner.provisioningCompletedAt},
             ${runner.provisioningStartedAt},
             ${runner.provisioningCompletedAt ?? runner.provisioningStartedAt}
      from agents
      where id = ${agentId}
      returning id
    `;

    runnerId = inserted?.id ?? "";
    expect(runnerId).toMatch(/^[0-9a-f-]+$/);
  });

  return {
    id: runnerId,
  };
}

async function insertRunnerHeartbeat(
  runnerId: string,
  heartbeat: {
    status: "online" | "offline" | "degraded";
    version: string;
    observedAt: string;
    metrics?: {
      maxAgents?: number;
      runningAgents?: number;
      cpuPercent?: number;
      memoryUsedMb?: number;
      memoryTotalMb?: number;
      diskUsedMb?: number;
      diskTotalMb?: number;
    };
  },
): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into runner_heartbeats (
        runner_id,
        status,
        metadata,
        observed_at,
        created_at
      )
      values (
        ${runnerId},
        ${heartbeat.status},
        ${sql.json({
          version: heartbeat.version,
          metrics: {
            cpuPercent: 37,
            ...heartbeat.metrics,
            apiToken: "must-not-render",
          },
        })},
        ${heartbeat.observedAt},
        ${heartbeat.observedAt}
      )
    `;
  });
}

async function insertRunnerCredential(
  runnerId: string,
  credential: string,
  createdAt: string,
): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into runner_credentials (
        runner_id,
        credential_hash,
        credential_prefix,
        status,
        created_at,
        updated_at
      )
      values (
        ${runnerId},
        ${hashRunnerSecretForE2e(credential)},
        ${credential.slice(0, 16)},
        'active',
        ${createdAt},
        ${createdAt}
      )
    `;
  });
}

async function insertManualRunnerLog(
  agentId: string,
  runnerId: string,
  log: {
    stream: "stdout" | "stderr";
    level: string;
    message: string;
    sequence: number;
    createdAt: string;
  },
): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into agent_logs (
        agent_id,
        runner_id,
        source,
        stream,
        level,
        message,
        sequence,
        created_at
      )
      values (
        ${agentId},
        ${runnerId},
        'manual_runner',
        ${log.stream},
        ${log.level},
        ${log.message},
        ${log.sequence},
        ${log.createdAt}
      )
    `;
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

async function startCostUsageFixture(agentId: string, runnerId: string): Promise<void> {
  await withDatabase(async (sql) => {
    const startedAt = new Date(Date.now() - 12 * 60 * 60 * 1_000).toISOString();

    await sql`
      update agents
      set runner_id = ${runnerId},
          status = 'running',
          updated_at = now()
      where id = ${agentId}
    `;
    await sql`
      insert into agent_usage_periods (agent_id, runner_id, source, started_at)
      values (${agentId}, ${runnerId}, 'lifecycle', ${startedAt})
    `;
  });
}

async function stopCostUsageFixture(agentId: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      update agent_usage_periods
      set stopped_at = coalesce(stopped_at, now()),
          updated_at = now()
      where agent_id = ${agentId}
    `;
    await sql`
      update agents
      set status = 'stopped',
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

async function withPinnedDevelopmentUserForAgent<T>(
  agentId: string,
  run: () => Promise<T>,
): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;

    try {
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

      return await run();
    } finally {
      await sql`select pg_advisory_unlock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    }
  });
}

async function deleteCreatedAgents(agentIds: string[]): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from agent_usage_periods where agent_id in ${sql(agentIds)}`;
    await sql`delete from backups where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_approvals where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_logs where agent_id in ${sql(agentIds)}`;
    await sql`delete from docker_runner_containers where agent_id in ${sql(agentIds)}`;
    await sql`delete from local_runner_processes where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_events where agent_id in ${sql(agentIds)}`;
    await sql`delete from agent_configs where agent_id in ${sql(agentIds)}`;
    await sql`delete from agents where id in ${sql(agentIds)}`;
  });
}

function validBackupManifestForE2e(agentId: string, agentName: string) {
  return {
    schemaVersion: 1,
    agent: {
      id: agentId,
      name: agentName,
      status: "stopped",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      createdAt: "2026-07-06T05:00:00.000Z",
      updatedAt: "2026-07-06T05:00:00.000Z",
    },
    config: {
      modelProvider: "openai",
      modelName: "gpt-4.1-mini",
      scheduleMode: "manual",
      timezone: "UTC",
      maxDailySpendCents: 0,
      scheduleCron: null,
    },
    templateSnapshot: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      description: "Research template",
      defaultTools: ["Web search"],
      defaultSchedule: "Manual",
      defaultSystemPrompt: "Gather notes.",
      requiredIntegrations: [],
    },
    systemPrompt: "Gather notes.",
    skills: {
      folderPath: ".agent/skills",
      files: [],
    },
    memory: {
      files: [],
    },
    logs: {
      included: true,
      entries: [],
    },
  };
}

async function deleteCreatedRunners(): Promise<void> {
  const runnerIds = [...createdRunnerIds];
  createdRunnerIds.clear();

  await deleteRunnerRows(runnerIds);
}

async function deleteRunnerRows(runnerIds: string[]): Promise<void> {
  if (runnerIds.length === 0) {
    return;
  }

  await withDatabase(async (sql) => {
    await sql`delete from runner_heartbeats where runner_id in ${sql(runnerIds)}`;
    await sql`delete from runner_credentials where runner_id in ${sql(runnerIds)}`;
    await sql`delete from runners where id in ${sql(runnerIds)}`;
  });
}

async function stopCreatedAgents(request: APIRequestContext, agentIds: string[]): Promise<void> {
  await Promise.all(
    agentIds.map(async (agentId) => {
      await request.post(`/api/agents/${agentId}/actions/stop`);
    }),
  );
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

async function expectRunnerHeartbeat(
  request: APIRequestContext,
  runnerId: string,
  credential: string,
  expectedStatus: number,
): Promise<void> {
  const response = await request.post("/runner/v1/heartbeat", {
    headers: {
      authorization: `Bearer ${credential}`,
    },
    data: {
      runnerId,
      status: "online",
      version: "bruno-runner/e2e",
    },
  });
  const body = await response.json();

  expect(response.status()).toBe(expectedStatus);

  if (expectedStatus === 200) {
    expect(body).toMatchObject({
      ok: true,
      runner: {
        id: runnerId,
        status: "online",
      },
    });
    return;
  }

  expect(body).toEqual({
    error: {
      code: "runner_unauthorized",
      message: "Runner credentials are invalid.",
    },
  });
  expect(JSON.stringify(body)).not.toContain(credential);
  expect(JSON.stringify(body)).not.toContain("credentialHash");
}

async function expectPageNotHorizontallyOverflowing(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));

  expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
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

function hashRunnerSecretForE2e(value: string): string {
  return createHash("sha256").update(value.trim(), "utf8").digest("hex");
}
