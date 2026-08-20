import { randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  createFounderProductContractLifecycleApplication,
  createFounderProductContractProviderDoubles,
  runFounderProductContractLifecycleScenarios,
  runFounderProductContractScenario,
  type FounderProductContractClock,
} from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

test("one persisted Operator scenario drives API, browser, keyboard, and accessibility evidence", async ({
  page,
  request,
}) => {
  const clock = createFounderProductContractClock("2026-08-20T00:00:00.000Z");
  const providers = createFounderProductContractProviderDoubles({ clock });
  const fixture = await createFixture(clock);
  const lifecycleHarness = createFounderProductContractHarness({
    clock,
    providers,
    application: createFounderProductContractLifecycleApplication({ clock, providers }),
  });
  const harness = createFounderProductContractHarness({
    clock,
    providers,
    application: {
      request: async ({ method, path, body }) => {
        const response = await request.fetch(path, {
          method,
          ...(body === undefined ? {} : { data: body as object }),
        });
        return {
          status: response.status(),
          headers: response.headers(),
          json: () => response.json(),
        };
      },
    },
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await runFounderProductContractLifecycleScenarios(lifecycleHarness);
    await runFounderProductContractScenario(harness, async ({ application }) => {
      await withPinnedDevelopmentUser(fixture.userId, async () => {
        const apiResponse = await application.request({ method: "GET", path: "/api/operator" });
        expect(apiResponse.status).toBe(200);
        expect(apiResponse.headers["cache-control"]).toBe("no-store");
        const apiBody = (await apiResponse.json()) as { operator: { id: string } };
        expect(apiBody.operator.id).toBe(fixture.operatorId);

        await page.goto("/operator");
        await expect(page.getByRole("heading", { name: "Bruno.Ai Operator" })).toBeVisible();
        await expect(page.getByText("Your Operator is ready.")).toBeVisible();
        await expect(page.getByText("Next step: Connect your Ready AI Connection")).toBeVisible();

        const forbiddenTechnicalControl =
          /agent template|manage api keys?|connect telegram|numeric allowlist|cron expression|runner management|deployment configuration|view raw logs?|open terminal/i;
        await expect(
          page
            .getByRole("button", { name: forbiddenTechnicalControl })
            .or(page.getByRole("link", { name: forbiddenTechnicalControl })),
        ).toHaveCount(0);
        await expect(page.getByRole("heading", { name: forbiddenTechnicalControl })).toHaveCount(0);

        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).not.toBe(
          "body",
        );

        const accessibility = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
          .analyze();
        expect(accessibility.violations).toEqual([]);

        await page.reload();
        const resumedResponse = await application.request({ method: "GET", path: "/api/operator" });
        const resumedBody = (await resumedResponse.json()) as { operator: { id: string } };
        expect(resumedBody.operator.id).toBe(fixture.operatorId);
        await expect(page.getByText("Your Operator is ready.")).toBeVisible();
        await page.waitForLoadState("networkidle");
        expect(pageErrors).toEqual([]);
        await page.close();
      });
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function createFixture(clock: FounderProductContractClock): Promise<{
  userId: string;
  operatorId: string;
}> {
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const createdAt = clock.now().toISOString();
  const readyAt = clock.advance(1_000).toISOString();

  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${readyAt})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${readyAt})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${createdAt}, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', 'founder-contract-v1', 'founder-contract-runtime', 1, ${createdAt}, ${readyAt}, ${createdAt}, ${readyAt})`;
  });

  return { userId, operatorId };
}

async function deleteFixture(fixture: { userId: string; operatorId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_runtimes where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_preparations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operators where id = ${fixture.operatorId}`;
    await sql`delete from users where id = ${fixture.userId}`;
  });
}

async function withPinnedDevelopmentUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    const [previous] = await sql<
      { value: string }[]
    >`select value from app_metadata where key = 'local_development_user_id'`;
    await sql`insert into app_metadata (key, value) values ('local_development_user_id', ${userId}) on conflict (key) do update set value = excluded.value, updated_at = now()`;
    try {
      return await run();
    } finally {
      if (previous) {
        await sql`update app_metadata set value = ${previous.value}, updated_at = now() where key = 'local_development_user_id'`;
      } else {
        await sql`delete from app_metadata where key = 'local_development_user_id'`;
      }
      await sql`select pg_advisory_unlock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    }
  });
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno", {
    connect_timeout: 5,
    idle_timeout: 60,
    max: 1,
  });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
