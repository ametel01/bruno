import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_229;
const RUNTIME_REVISION_CANARY = "E2E-PRIVATE-RUNTIME-REVISION";

test.use({ screenshot: "off", trace: "off", video: "off" });

test("managed runtime truth overrides historical ready without browser reconciliation", async ({
  context,
  isMobile,
  page,
}) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      if (isMobile) {
        await page.setViewportSize({ width: 320, height: 720 });
      }
      await page.emulateMedia({ reducedMotion: "reduce" });

      const externalRequests: string[] = [];
      const runtimeRequests: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          await route.continue();
          return;
        }
        externalRequests.push(url.toString());
        await route.abort("blockedbyclient");
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/runtime")) {
          runtimeRequests.push(`${request.method()} ${url.pathname}`);
        }
      });

      const initialRuntimeRead = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/runtime"),
      );
      await page.goto(`/agents/${fixture.agentId}`);
      await initialRuntimeRead;
      await expect(page.locator("#runtime-status-title")).toHaveText("Ready");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
      await expectNoHorizontalOverflow(page);
      expect(await page.locator("body").innerText()).not.toContain(RUNTIME_REVISION_CANARY);

      await updateRuntime(fixture.agentId, "recovering_stop");
      const recoveryRead = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/runtime"),
      );
      await requestImmediateRuntimePoll(page);
      await recoveryRead;
      await expect(page.locator("#runtime-status-title")).toHaveText("Recovering");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Restart", exact: true })).toHaveCount(0);

      await updateRuntime(fixture.agentId, "circuit_open");
      const circuitRead = page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/runtime"),
      );
      await requestImmediateRuntimePoll(page);
      await circuitRead;
      await expect(page.locator("#runtime-status-title")).toHaveText("Attention required");
      await expect(
        page.getByText("Automatic recovery was paused after repeated failures."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
      await expectNoHorizontalOverflow(page);

      expect(runtimeRequests.length).toBeGreaterThanOrEqual(3);
      expect(runtimeRequests.every((request) => request.startsWith("GET "))).toBe(true);
      expect(externalRequests).toEqual([]);
      const browserState = await page.evaluate(() =>
        [
          document.documentElement.outerHTML,
          JSON.stringify({ ...localStorage }),
          JSON.stringify({ ...sessionStorage }),
        ].join("\n"),
      );
      expect(browserState).not.toContain(RUNTIME_REVISION_CANARY);
      expect(browserState).not.toMatch(
        /runtimeGeneration|runtimeOperation|runtimeLease|restartCount|circuitOpenedAt/,
      );
      expect(
        await page
          .locator(".agent-runtime-status-card")
          .evaluate((element) => element.getAnimations().length),
      ).toBe(0);
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function requestImmediateRuntimePoll(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const sizes = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth + 1);
}

async function createFixture(): Promise<{ userId: string; agentId: string }> {
  const userId = randomUUID();
  const agentId = randomUUID();
  const deploymentId = randomUUID();
  const operationId = randomUUID();
  const at = new Date().toISOString();

  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${at}, ${at})`;
    await sql`
      insert into agents (
        id, user_id, name, template_key, status, desired_status, created_at, updated_at
      ) values (
        ${agentId}, ${userId}, 'Durable runtime fixture', 'research_agent', 'running', 'running',
        ${at}, ${at}
      )
    `;
    await sql`
      insert into agent_configs (agent_id, system_prompt, model_provider, model_name)
      values (${agentId}, 'Fake-only runtime UI fixture.', 'openai-api', 'gpt-5.4')
    `;
    await sql`
      insert into agent_deployments (
        id, agent_id, user_id, stage, config_revision, idempotency_key,
        runner_operation_id, runner_accepted_at, canary_state, canary_attempted_at,
        canary_completed_at, started_at, completed_at, created_at, updated_at
      ) values (
        ${deploymentId}, ${agentId}, ${userId}, 'ready', 'historical-ready-v1', ${randomUUID()},
        ${operationId}, ${at}, 'passed', ${at}, ${at}, ${at}, ${at}, ${at}, ${at}
      )
    `;
    await sql`
      insert into agent_runtime_reconciliations (
        agent_id, user_id, state, config_revision, operation_id, stable_since,
        last_observed_at, last_ready_at, next_attempt_at, created_at, updated_at
      ) values (
        ${agentId}, ${userId}, 'observing', ${RUNTIME_REVISION_CANARY}, ${operationId}, ${at},
        ${at}, ${at}, ${new Date(Date.parse(at) + 60_000).toISOString()}, ${at}, ${at}
      )
    `;
  });

  return { userId, agentId };
}

async function updateRuntime(
  agentId: string,
  state: "recovering_stop" | "circuit_open",
): Promise<void> {
  const at = new Date().toISOString();
  await withDatabase(async (sql) => {
    await sql`
      update agent_runtime_reconciliations
      set state = ${state}, operation_id = null, stable_since = null,
          error_code = ${state === "circuit_open" ? "runtime_recovery_exhausted" : "runtime_gateway_unhealthy"},
          circuit_opened_at = ${state === "circuit_open" ? at : null},
          next_attempt_at = ${state === "circuit_open" ? null : at}, updated_at = ${at}
      where agent_id = ${agentId}
    `;
    await sql`
      update agents set status = ${state === "circuit_open" ? "error" : "restarting"}, updated_at = ${at}
      where id = ${agentId}
    `;
  });
}

async function withPinnedDevelopmentUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    try {
      const [previous] = await sql<{ value: string }[]>`
        select value from app_metadata where key = 'local_development_user_id'
      `;
      await sql`
        insert into app_metadata (key, value) values ('local_development_user_id', ${userId})
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

async function deleteFixture(fixture: { userId: string; agentId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from agent_runtime_reconciliations where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_deployments where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_configs where agent_id = ${fixture.agentId}`;
    await sql`delete from agents where id = ${fixture.agentId}`;
    await sql`delete from users where id = ${fixture.userId}`;
  });
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
  const sql = postgres(databaseUrl, { connect_timeout: 5, idle_timeout: 60, max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
