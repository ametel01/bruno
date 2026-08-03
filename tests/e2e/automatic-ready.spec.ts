import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, type Page, type Request, test } from "@playwright/test";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_228;
const OPENROUTER_CANARY = "e2e-openrouter-canary-not-a-provider-key";
const TELEGRAM_CANARY = "e2e-telegram-canary-not-a-bot-token";
const ALLOWLIST_CANARIES = ["811111111111111111", "822222222222222222"] as const;
const CONFIG_REVISION = "e2e-ready-ui-v1";

const deploymentStages = [
  "pending",
  "provisioning_runner",
  "configuring_hermes",
  "starting_gateway",
  "verifying_model",
  "connecting_telegram",
  "ready",
  "failed",
] as const;

type DeploymentStage = (typeof deploymentStages)[number];

type Fixture = {
  userId: string;
  agentIds: Set<string>;
};

type DeploymentSnapshot = {
  id: string;
  agentId: string;
  stage: DeploymentStage;
  configRevision: string;
  attemptCount: number;
  error: { code: string; detail: null } | null;
  nextAttemptAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type BrowserEvidence = {
  consoleMessages: string[];
  pageErrors: string[];
  externalRequests: string[];
};

test.use({ screenshot: "off", trace: "off", video: "off" });

test("automatic submission follows persisted progress to ready across refresh, reopen, and a second context", async ({
  browser,
  context,
  isMobile,
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await createFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }

      await page.emulateMedia({ reducedMotion: "reduce" });
      const evidence = await installBrowserEvidence(context, page);
      const clientPosts: Array<{ path: string; body: unknown }> = [];
      const observedPostPaths: string[] = [];
      page.on("request", (request) => {
        if (request.method() === "POST") {
          observedPostPaths.push(new URL(request.url()).pathname);
        }
      });
      const agentId = randomUUID();
      const deploymentId = randomUUID();
      const createdAt = new Date().toISOString();
      let createIdempotencyKey = "";

      await page.route("**/api/agents", async (route) => {
        const request = route.request();

        if (request.method() !== "POST") {
          await route.continue();
          return;
        }

        const body = readJsonRequest(request);
        clientPosts.push({ path: new URL(request.url()).pathname, body });
        expect(request.headers().accept).toBe("application/json");
        expect(request.headers()["content-type"]).toContain("application/json");
        expect(body).toMatchObject({ idempotencyKey: expect.any(String) });
        createIdempotencyKey = (body as { idempotencyKey: string }).idempotencyKey;
        expect(createIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(body).toEqual({
          name: "Persisted Ready Agent",
          templateKey: "research_agent",
          runnerId: null,
          launchMode: "ready",
          idempotencyKey: createIdempotencyKey,
          openrouterModel: "openai/gpt-4.1-mini",
          openrouterApiKey: OPENROUTER_CANARY,
          telegramBotToken: TELEGRAM_CANARY,
          telegramAllowedUserIds: [...ALLOWLIST_CANARIES],
        });

        await insertAgent(fixture, {
          agentId,
          deploymentId,
          deploymentIdempotencyKey: randomUUID(),
          desiredStatus: "running",
          name: "Persisted Ready Agent",
          stage: "pending",
          status: "stopped",
          createdAt,
        });

        await route.fulfill({
          contentType: "application/json",
          status: 202,
          body: JSON.stringify({
            agent: { id: agentId },
            deployment: deploymentSnapshot({
              agentId,
              deploymentId,
              stage: "pending",
              createdAt,
            }),
          }),
        });
      });

      await page.goto("/agents");
      await expect(page.getByRole("button", { name: "Automatic setup" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(page.getByLabel("Model")).toHaveValue("openai/gpt-4.1-mini");
      await expect(page.getByLabel("Model").locator("option")).toHaveCount(1);
      await expect(page.getByLabel("OpenRouter API key")).toHaveAttribute("type", "password");
      await expect(page.getByLabel("Telegram bot token")).toHaveAttribute("type", "password");
      await expect(page.getByLabel("Telegram allowed user IDs")).toBeVisible();
      await expect(page.getByRole("link", { name: "BotFather" })).toHaveAttribute(
        "href",
        "https://t.me/BotFather",
      );
      await expect(page.getByRole("link", { name: "BotFather" })).toHaveAttribute(
        "rel",
        /noopener/,
      );
      await expectNoHorizontalOverflow(page);

      await page.getByLabel("Name").fill("   ");
      await page.getByRole("button", { name: "Create and set up" }).click();
      await expect(page.locator("#agent-create-name-error")).toHaveText("Name is required.");
      await expect(page.getByLabel("Name")).toBeFocused();

      await page.getByLabel("Name").fill("Persisted Ready Agent");
      await page.getByLabel("OpenRouter API key").fill(OPENROUTER_CANARY);
      await page.getByLabel("Telegram bot token").fill(TELEGRAM_CANARY);
      await page
        .getByLabel("Telegram allowed user IDs")
        .fill(`${ALLOWLIST_CANARIES[0]}\n${ALLOWLIST_CANARIES[1]}\n${ALLOWLIST_CANARIES[0]}`);
      const submit = page.getByRole("button", { name: "Create and set up" });
      await submit.focus();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
      expect(clientPosts).toEqual([
        {
          path: "/api/agents",
          body: {
            name: "Persisted Ready Agent",
            templateKey: "research_agent",
            runnerId: null,
            launchMode: "ready",
            idempotencyKey: createIdempotencyKey,
            openrouterModel: "openai/gpt-4.1-mini",
            openrouterApiKey: OPENROUTER_CANARY,
            telegramBotToken: TELEGRAM_CANARY,
            telegramAllowedUserIds: [...ALLOWLIST_CANARIES],
          },
        },
      ]);
      await expectCurrentStage(page, "Preparing deployment");
      await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Stop setup" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Open advanced setup" })).not.toBeVisible();
      await expectNoSensitiveExposure(page, context, evidence, [
        OPENROUTER_CANARY,
        TELEGRAM_CANARY,
        ...ALLOWLIST_CANARIES,
        createIdempotencyKey,
      ]);

      await updateDeploymentStage(agentId, deploymentId, "provisioning_runner");
      await requestImmediatePoll(page);
      await expectCurrentStage(page, "Provisioning runner");

      await updateDeploymentStage(agentId, deploymentId, "configuring_hermes");
      await page.reload();
      await expectCurrentStage(page, "Configuring Hermes");

      await updateDeploymentStage(agentId, deploymentId, "starting_gateway");
      const detailUrl = page.url();
      const reopenedPage = await context.newPage();
      installPageEvidence(reopenedPage, evidence);
      await reopenedPage.emulateMedia({ reducedMotion: "reduce" });
      await reopenedPage.goto(detailUrl);
      await page.close();
      await expectCurrentStage(reopenedPage, "Starting gateway");

      await updateDeploymentStage(agentId, deploymentId, "verifying_model");
      const secondContext = await browser.newContext({
        reducedMotion: "reduce",
        viewport: isMobile ? { width: 320, height: 720 } : { width: 1280, height: 800 },
      });
      const secondPage = await secondContext.newPage();
      const secondEvidence = await installBrowserEvidence(secondContext, secondPage);
      let secondContextStage: Exclude<DeploymentStage, "failed"> = "verifying_model";
      await secondPage.route(`**/api/agents/${agentId}/deployment`, async (route) => {
        await route.fulfill({
          contentType: "application/json",
          status: 200,
          body: JSON.stringify({
            deployment: deploymentSnapshot({
              agentId,
              deploymentId,
              stage: secondContextStage,
              createdAt,
            }),
          }),
        });
      });

      try {
        await secondPage.goto(detailUrl);
        await expectCurrentStage(secondPage, "Verifying model");
        await expectNoHorizontalOverflow(secondPage);

        await updateDeploymentStage(agentId, deploymentId, "connecting_telegram");
        secondContextStage = "connecting_telegram";
        await requestImmediatePoll(secondPage);
        await expectCurrentStage(secondPage, "Connecting Telegram");

        await updateDeploymentStage(agentId, deploymentId, "ready");
        secondContextStage = "ready";
        await requestImmediatePoll(secondPage);
        await expectCurrentStage(secondPage, "Ready");
        await expect(secondPage.locator(".agent-overview-panel .status-pill")).toContainText(
          "Ready",
        );
        await expect(secondPage.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
        await expect(
          secondPage.getByRole("button", { name: "Restart", exact: true }),
        ).toBeVisible();
        await expect(secondPage.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
        await expectNoHorizontalOverflow(secondPage);
        await expectNoSensitiveExposure(secondPage, secondContext, secondEvidence, [
          OPENROUTER_CANARY,
          TELEGRAM_CANARY,
          ...ALLOWLIST_CANARIES,
          createIdempotencyKey,
        ]);
        expect(secondEvidence.externalRequests).toEqual([]);
      } finally {
        await secondContext.close();
      }

      await requestImmediatePoll(reopenedPage);
      await expectCurrentStage(reopenedPage, "Ready");
      await expectNoSensitiveExposure(reopenedPage, context, evidence, [
        OPENROUTER_CANARY,
        TELEGRAM_CANARY,
        ...ALLOWLIST_CANARIES,
        createIdempotencyKey,
      ]);
      expect(observedPostPaths).toEqual(["/api/agents"]);
      expect(evidence.externalRequests).toEqual([]);
      const reducedMotionEvidence = await reopenedPage.evaluate(() => ({
        matches: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        animations: document.querySelector(".agent-deployment-progress-card")?.getAnimations()
          .length,
      }));
      expect(reducedMotionEvidence).toEqual({ matches: true, animations: 0 });
    });
  } finally {
    await deleteFixture(fixture);
  }
});

test("failed setup retries with one new operation and reaches ready", async ({
  context,
  isMobile,
  page,
}) => {
  const fixture = await createFixture();
  const agentId = randomUUID();
  const failedDeploymentId = randomUUID();
  const failedAt = "2026-08-03T02:00:00.000Z";
  const persistedIdempotencyKey = randomUUID();

  try {
    await insertAgent(fixture, {
      agentId,
      deploymentId: failedDeploymentId,
      deploymentIdempotencyKey: persistedIdempotencyKey,
      desiredStatus: "running",
      name: "Retry Ready Agent",
      stage: "failed",
      status: "stopped",
      createdAt: failedAt,
    });

    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }

      const evidence = await installBrowserEvidence(context, page);
      const retryDeploymentId = randomUUID();
      const retryCreatedAt = new Date().toISOString();
      let retryBody: unknown;
      let retryPollStage: Exclude<DeploymentStage, "failed"> = "pending";

      await page.route(`**/api/agents/${agentId}/deployment/retry`, async (route) => {
        retryBody = readJsonRequest(route.request());
        await insertRetryDeployment(
          fixture,
          agentId,
          retryDeploymentId,
          randomUUID(),
          retryCreatedAt,
        );
        await route.fulfill({
          contentType: "application/json",
          status: 202,
          body: JSON.stringify({
            deployment: deploymentSnapshot({
              agentId,
              deploymentId: retryDeploymentId,
              stage: "pending",
              createdAt: retryCreatedAt,
            }),
          }),
        });
      });
      await page.route(`**/api/agents/${agentId}/deployment`, async (route) => {
        await route.fulfill({
          contentType: "application/json",
          status: 200,
          body: JSON.stringify({
            deployment: deploymentSnapshot({
              agentId,
              deploymentId: retryDeploymentId,
              stage: retryPollStage,
              createdAt: retryCreatedAt,
            }),
          }),
        });
      });

      await page.goto(`/agents/${agentId}`);
      await expect(page.locator(".agent-deployment-progress-card [role='alert']")).toContainText(
        "Automatic setup could not finish. Retry or stop this agent.",
      );
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await expectCurrentStage(page, "Preparing deployment");
      expect(retryBody).toMatchObject({ idempotencyKey: expect.any(String) });
      expect(Object.keys(retryBody as object)).toEqual(["idempotencyKey"]);
      const retryIdempotencyKey = (retryBody as { idempotencyKey: string }).idempotencyKey;
      expect(retryIdempotencyKey).toMatch(/^[0-9a-f-]{36}$/);

      await updateDeploymentStage(agentId, retryDeploymentId, "ready");
      retryPollStage = "ready";
      await requestImmediatePoll(page);
      await expectCurrentStage(page, "Ready");
      await expectNoSensitiveExposure(page, context, evidence, [
        retryIdempotencyKey,
        persistedIdempotencyKey,
      ]);
      expect(evidence.externalRequests).toEqual([]);
    });
  } finally {
    await deleteFixture(fixture);
  }
});

test("Stop setup persists intentional stop during progress", async ({
  context,
  isMobile,
  page,
}) => {
  const fixture = await createFixture();
  const agentId = randomUUID();
  const deploymentId = randomUUID();

  try {
    await insertAgent(fixture, {
      agentId,
      deploymentId,
      deploymentIdempotencyKey: randomUUID(),
      desiredStatus: "running",
      name: "Stopped During Setup Agent",
      stage: "configuring_hermes",
      status: "stopped",
      createdAt: new Date().toISOString(),
    });

    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }

      const evidence = await installBrowserEvidence(context, page);
      const stopRequests: Array<{ method: string; body: string | null }> = [];
      await page.route(`**/api/agents/${agentId}/actions/stop`, async (route) => {
        stopRequests.push({ method: route.request().method(), body: route.request().postData() });
        await stopDeployment(agentId, deploymentId);
        await route.fulfill({ contentType: "application/json", status: 200, body: '{"ok":true}' });
      });

      await page.goto(`/agents/${agentId}`);
      await expectCurrentStage(page, "Configuring Hermes");
      await page.getByRole("button", { name: "Stop setup" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { name: "Intentionally stopped" })).toBeVisible();
      expect(stopRequests).toEqual([{ method: "POST", body: null }]);
      await expect(page.getByRole("button", { name: "Stop setup" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(evidence.externalRequests).toEqual([]);
    });
  } finally {
    await deleteFixture(fixture);
  }
});

test("observation failures degrade after three reads and recover without changing deployment state", async ({
  context,
  isMobile,
  page,
}) => {
  test.setTimeout(30_000);
  const fixture = await createFixture();
  const agentId = randomUUID();
  const deploymentId = randomUUID();

  try {
    await insertAgent(fixture, {
      agentId,
      deploymentId,
      deploymentIdempotencyKey: randomUUID(),
      desiredStatus: "running",
      name: "Observed Ready Agent",
      stage: "pending",
      status: "stopped",
      createdAt: new Date().toISOString(),
    });

    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }

      const evidence = await installBrowserEvidence(context, page);
      let deploymentReads = 0;
      await page.route(`**/api/agents/${agentId}/deployment`, async (route) => {
        deploymentReads += 1;

        if (deploymentReads <= 3) {
          await route.abort("connectionfailed");
          return;
        }

        await route.continue();
      });

      await page.goto(`/agents/${agentId}`);
      await expect.poll(() => deploymentReads).toBeGreaterThanOrEqual(1);
      await requestImmediatePoll(page);
      await expect.poll(() => deploymentReads).toBeGreaterThanOrEqual(2);
      await requestImmediatePoll(page);
      await expect.poll(() => deploymentReads).toBeGreaterThanOrEqual(3);
      await expect(page.getByText("Progress updates are temporarily unavailable")).toBeVisible();
      await expectCurrentStage(page, "Preparing deployment");

      await updateDeploymentStage(agentId, deploymentId, "configuring_hermes");
      await page.getByRole("button", { name: "Check again" }).click();
      await expectCurrentStage(page, "Configuring Hermes");
      await expect(page.getByText("Progress updates are temporarily unavailable")).toHaveCount(0);
      expect(deploymentReads).toBeGreaterThanOrEqual(4);
      expect(evidence.externalRequests).toEqual([]);
    });
  } finally {
    await deleteFixture(fixture);
  }
});

test("manual fallback posts the legacy envelope and keeps automatic setup secondary", async ({
  context,
  isMobile,
  page,
}) => {
  const fixture = await createFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }

      const evidence = await installBrowserEvidence(context, page);
      const agentId = randomUUID();
      let manualBody: unknown;
      let deploymentReads = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.endsWith("/deployment")) {
          deploymentReads += 1;
        }
      });
      await page.route("**/api/agents", async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }

        manualBody = readJsonRequest(route.request());
        await insertAgent(fixture, {
          agentId,
          deploymentId: null,
          deploymentIdempotencyKey: null,
          desiredStatus: "stopped",
          name: "Manual Fallback Agent",
          stage: null,
          status: "stopped",
          createdAt: new Date().toISOString(),
        });
        await route.fulfill({
          contentType: "application/json",
          status: 201,
          body: JSON.stringify({ agent: { id: agentId }, event: { type: "agent.created" } }),
        });
      });

      await page.goto("/agents");
      await page.getByRole("button", { name: "Manual", exact: true }).click();
      await expect(page.getByLabel("OpenRouter API key")).toHaveCount(0);
      await expect(page.getByLabel("Telegram bot token")).toHaveCount(0);
      await page.getByLabel("Name").fill("Manual Fallback Agent");
      await page.getByRole("button", { name: "Create agent" }).click();

      await expect(page).toHaveURL(new RegExp(`/agents/${agentId}$`));
      expect(manualBody).toEqual({
        name: "Manual Fallback Agent",
        templateKey: "research_agent",
        runnerId: null,
      });
      await expect(page.getByRole("heading", { name: "Manual setup" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Start", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Advanced Hermes setup" })).toBeVisible();
      expect(deploymentReads).toBe(0);
      await expectNoHorizontalOverflow(page);
      expect(evidence.externalRequests).toEqual([]);
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function installBrowserEvidence(
  context: BrowserContext,
  page: Page,
): Promise<BrowserEvidence> {
  const evidence: BrowserEvidence = {
    consoleMessages: [],
    pageErrors: [],
    externalRequests: [],
  };

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
      await route.continue();
      return;
    }

    evidence.externalRequests.push(url.toString());
    await route.abort("blockedbyclient");
  });
  installPageEvidence(page, evidence);
  return evidence;
}

function installPageEvidence(page: Page, evidence: BrowserEvidence): void {
  page.on("console", (message) => evidence.consoleMessages.push(message.text()));
  page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
}

async function expectCurrentStage(page: Page, label: string): Promise<void> {
  await expect(page.locator("#deployment-progress-title")).toHaveText(label);
  await expect(
    page
      .getByRole("list", { name: "Persisted deployment stages" })
      .getByRole("listitem")
      .filter({ hasText: label }),
  ).toHaveAttribute("aria-current", "step");
}

async function requestImmediatePoll(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth + 1);
}

async function expectNoSensitiveExposure(
  page: Page,
  context: BrowserContext,
  evidence: BrowserEvidence,
  values: readonly string[],
): Promise<void> {
  const browserState = await page.evaluate(() => ({
    html: document.documentElement.outerHTML,
    localStorage: JSON.stringify({ ...window.localStorage }),
    sessionStorage: JSON.stringify({ ...window.sessionStorage }),
    url: window.location.href,
  }));
  const cookies = JSON.stringify(await context.cookies());
  const searchable = [
    browserState.html,
    browserState.localStorage,
    browserState.sessionStorage,
    browserState.url,
    cookies,
    ...evidence.consoleMessages,
    ...evidence.pageErrors,
  ].join("\n");

  for (const value of values) {
    expect(searchable).not.toContain(value);
  }

  expect(evidence.pageErrors).toEqual([]);
}

function readJsonRequest(request: Request): unknown {
  const body = request.postData();
  expect(body).not.toBeNull();
  return JSON.parse(body ?? "null") as unknown;
}

async function createFixture(): Promise<Fixture> {
  const userId = randomUUID();
  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, now(), now())`;
  });
  return { userId, agentIds: new Set<string>() };
}

async function insertAgent(
  fixture: Fixture,
  input: {
    agentId: string;
    deploymentId: string | null;
    deploymentIdempotencyKey: string | null;
    desiredStatus: "running" | "stopped";
    name: string;
    stage: DeploymentStage | null;
    status: "running" | "stopped";
    createdAt: string;
  },
): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      insert into users (id, created_at, updated_at)
      values (${fixture.userId}, now(), now())
      on conflict (id) do nothing
    `;
    await sql`
      insert into app_metadata (key, value)
      values ('local_development_user_id', ${fixture.userId})
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    await sql`
      insert into agents (
        id, user_id, name, template_key, status, desired_status, created_at, updated_at
      ) values (
        ${input.agentId}, ${fixture.userId}, ${input.name}, 'research_agent', ${input.status},
        ${input.desiredStatus}, ${input.createdAt}, ${input.createdAt}
      )
    `;
    await sql`
      insert into agent_configs (agent_id, system_prompt, model_provider, model_name)
      values (
        ${input.agentId},
        'E2E fixture prompt with no external actions.',
        'openrouter',
        'openai/gpt-4.1-mini'
      )
    `;

    if (input.deploymentId && input.deploymentIdempotencyKey && input.stage) {
      await insertDeploymentRow(sql, {
        agentId: input.agentId,
        deploymentId: input.deploymentId,
        idempotencyKey: input.deploymentIdempotencyKey,
        stage: input.stage,
        createdAt: input.createdAt,
      });
    }
  });
  fixture.agentIds.add(input.agentId);
}

async function insertRetryDeployment(
  fixture: Fixture,
  agentId: string,
  deploymentId: string,
  idempotencyKey: string,
  createdAt: string,
): Promise<void> {
  expect(fixture.agentIds.has(agentId)).toBe(true);
  await withDatabase(async (sql) => {
    await insertDeploymentRow(sql, {
      agentId,
      deploymentId,
      idempotencyKey,
      stage: "pending",
      createdAt,
    });
  });
}

async function insertDeploymentRow(
  sql: postgres.Sql,
  input: {
    agentId: string;
    deploymentId: string;
    idempotencyKey: string;
    stage: DeploymentStage;
    createdAt: string;
  },
): Promise<void> {
  const failed = input.stage === "failed";
  const ready = input.stage === "ready";
  const needsRunnerOperation = stageNeedsRunnerOperation(input.stage);
  const runnerOperationId = needsRunnerOperation ? randomUUID() : null;
  const canaryPassed = input.stage === "connecting_telegram" || ready;
  await sql`
    insert into agent_deployments (
      id, agent_id, user_id, stage, config_revision, idempotency_key, attempt_count,
      error_code, error_detail, runner_operation_id, runner_accepted_at, canary_state,
      canary_attempted_at, canary_completed_at, started_at, completed_at, failed_at,
      created_at, updated_at
    )
    select
      ${input.deploymentId}, id, user_id, ${input.stage}, ${CONFIG_REVISION},
      ${input.idempotencyKey}, 0, ${failed ? "deployment_failed" : null}, null,
      ${runnerOperationId}, ${needsRunnerOperation ? input.createdAt : null},
      ${canaryPassed ? "passed" : "not_started"},
      ${canaryPassed ? input.createdAt : null}, ${canaryPassed ? input.createdAt : null},
      ${input.createdAt}, ${ready ? input.createdAt : null}, ${failed ? input.createdAt : null},
      ${input.createdAt}, ${input.createdAt}
    from agents where id = ${input.agentId}
  `;
}

async function updateDeploymentStage(
  agentId: string,
  deploymentId: string,
  stage: Exclude<DeploymentStage, "failed">,
): Promise<void> {
  const changedAt = new Date().toISOString();
  const needsRunnerOperation = stageNeedsRunnerOperation(stage);
  const runnerOperationId = needsRunnerOperation ? randomUUID() : null;
  const canaryPassed = stage === "connecting_telegram" || stage === "ready";
  await withDatabase(async (sql) => {
    await sql`
      update agent_deployments
      set stage = ${stage},
          error_code = null,
          error_detail = null,
          runner_operation_id = ${runnerOperationId},
          runner_accepted_at = ${needsRunnerOperation ? changedAt : null},
          canary_state = ${canaryPassed ? "passed" : "not_started"},
          canary_attempted_at = ${canaryPassed ? changedAt : null},
          canary_completed_at = ${canaryPassed ? changedAt : null},
          completed_at = ${stage === "ready" ? changedAt : null},
          failed_at = null,
          updated_at = ${changedAt}
      where id = ${deploymentId} and agent_id = ${agentId}
    `;

    if (stage === "ready") {
      await sql`
        update agents set status = 'running', desired_status = 'running', updated_at = ${changedAt}
        where id = ${agentId}
      `;
      await sql`
        insert into agent_runtime_reconciliations (
          agent_id, user_id, state, config_revision, operation_id, stable_since,
          last_observed_at, last_ready_at, next_attempt_at, created_at, updated_at
        )
        select id, user_id, 'observing', ${CONFIG_REVISION}, ${runnerOperationId}, ${changedAt},
               ${changedAt}, ${changedAt}, ${new Date(Date.parse(changedAt) + 60_000).toISOString()},
               ${changedAt}, ${changedAt}
        from agents where id = ${agentId}
        on conflict (agent_id) do update
        set state = 'observing', config_revision = excluded.config_revision,
            operation_id = excluded.operation_id, stable_since = excluded.stable_since,
            last_observed_at = excluded.last_observed_at,
            last_ready_at = excluded.last_ready_at, next_attempt_at = excluded.next_attempt_at,
            error_code = null, circuit_opened_at = null, updated_at = excluded.updated_at
      `;
    }
  });
}

async function stopDeployment(agentId: string, deploymentId: string): Promise<void> {
  const stoppedAt = new Date().toISOString();
  await withDatabase(async (sql) => {
    await sql`
      update agent_deployments
      set stage = 'failed', error_code = 'deployment_cancelled', error_detail = null,
          next_attempt_at = null, lease_owner = null, lease_expires_at = null,
          runner_operation_id = null, runner_accepted_at = null, canary_state = 'not_started',
          canary_attempted_at = null, canary_completed_at = null, completed_at = null,
          failed_at = ${stoppedAt}, updated_at = ${stoppedAt}
      where id = ${deploymentId} and agent_id = ${agentId}
    `;
    await sql`
      update agents set desired_status = 'stopped', status = 'stopped', updated_at = ${stoppedAt}
      where id = ${agentId}
    `;
  });
}

function stageNeedsRunnerOperation(stage: DeploymentStage): boolean {
  return ["starting_gateway", "verifying_model", "connecting_telegram", "ready"].includes(stage);
}

function deploymentSnapshot(input: {
  agentId: string;
  deploymentId: string;
  stage: Exclude<DeploymentStage, "failed">;
  createdAt: string;
}): DeploymentSnapshot {
  return {
    id: input.deploymentId,
    agentId: input.agentId,
    stage: input.stage,
    configRevision: CONFIG_REVISION,
    attemptCount: 0,
    error: null,
    nextAttemptAt: null,
    startedAt: input.createdAt,
    completedAt: input.stage === "ready" ? input.createdAt : null,
    failedAt: null,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

async function withPinnedDevelopmentUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;

    try {
      const [previous] = await sql<{ value: string }[]>`
        select value from app_metadata where key = 'local_development_user_id'
      `;
      await sql`
        insert into app_metadata (key, value)
        values ('local_development_user_id', ${userId})
        on conflict (key) do update set value = excluded.value, updated_at = now()
      `;

      try {
        return await run();
      } finally {
        if (previous) {
          await sql`
            update app_metadata set value = ${previous.value}, updated_at = now()
            where key = 'local_development_user_id'
          `;
        } else {
          await sql`delete from app_metadata where key = 'local_development_user_id'`;
        }
      }
    } finally {
      await sql`select pg_advisory_unlock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    }
  });
}

async function deleteFixture(fixture: Fixture): Promise<void> {
  const agentIds = [...fixture.agentIds];
  await withDatabase(async (sql) => {
    if (agentIds.length > 0) {
      await sql`delete from agent_runtime_reconciliations where agent_id in ${sql(agentIds)}`;
      await sql`delete from agent_usage_periods where agent_id in ${sql(agentIds)}`;
      await sql`delete from agent_events where agent_id in ${sql(agentIds)}`;
      await sql`delete from agent_secrets where agent_id in ${sql(agentIds)}`;
      await sql`delete from agent_deployments where agent_id in ${sql(agentIds)}`;
      await sql`delete from agent_configs where agent_id in ${sql(agentIds)}`;
      await sql`delete from agents where id in ${sql(agentIds)}`;
    }

    await sql`delete from users where id = ${fixture.userId}`;
  });
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";
  const sql = postgres(databaseUrl, { connect_timeout: 5, idle_timeout: 60, max: 1 });

  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
