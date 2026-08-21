import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  createFounderProductContractProviderDoubles,
  createFounderProductContractScenarioLedger,
  runFounderProductContractPublicScenario,
  runFounderProductContractScenario,
  type FounderProductContractApplicationContext,
  type FounderProductContractClock,
} from "@/src/testing/founder-product-contract";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_365;

test("four persisted lifecycle scenarios drive API, browser, keyboard, and accessibility evidence", async ({
  page,
  request,
}, testInfo) => {
  const clock = createFounderProductContractClock("2026-08-20T00:00:00.000Z");
  const providers = createFounderProductContractProviderDoubles({ clock });
  providers.clerk.setResponse("authenticate", { ok: true, value: { subject: "founder-contract" } });
  providers.lemonSqueezy.setResponse("receive_webhook", { ok: true, value: { accepted: true } });
  providers.lemonSqueezy.setResponse("read_subscription", {
    ok: true,
    value: { status: "active" },
  });
  providers.digitalOcean.setResponse("observe_owned_resources", {
    ok: true,
    value: { resources: ["droplet", "firewall"] },
  });
  providers.digitalOcean.setResponse("delete_firewall", { ok: true, value: { deleted: true } });
  providers.digitalOcean.setResponse("delete_droplet", { ok: true, value: { deleted: true } });
  const fixture = await createFixture(clock);
  const contractSourceRevision =
    process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40);
  const harness = createFounderProductContractHarness({
    clock,
    providers,
    application: {
      request: async ({ method, path, body }, context) => {
        const providerFailure = await gateLifecycleRequest(body, path, context);
        if (providerFailure) return providerFailure;
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
    await runFounderProductContractPublicScenario(harness, async ({ application }) => {
      await withPinnedDevelopmentUser(fixture.userId, async () => {
        const apiResponse = await application.request({ method: "GET", path: "/api/operator" });
        expect(apiResponse.status).toBe(200);
        expect(apiResponse.headers["cache-control"]).toBe("no-store");
        const apiBody = (await apiResponse.json()) as { operator: { id: string } };
        expect(apiBody.operator.id).toBe(fixture.operatorId);

        for (const id of [
          "release_stage_admission",
          "product_entitlement_lifecycle",
          "recovery_archive_lifecycle",
          "infrastructure_retirement",
        ] as const) {
          await runFounderProductContractScenario(harness, id, async ({ application, clock }) => {
            const response = await application.request({
              method: "POST",
              path: "/api/operator/founder-product-contract/lifecycle",
              body: {
                action: id,
                runId: process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "local-founder-contract",
                sourceRevision: contractSourceRevision,
                now: clock.now().toISOString(),
                ...(id === "product_entitlement_lifecycle"
                  ? {
                      commerceEvent: signedCommerceEvent(
                        process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "local-founder-contract",
                      ),
                    }
                  : {}),
              },
            });
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              state: {
                infrastructure: string;
                releaseStage: string | null;
                entitlement: string | null;
              };
              providerCalls: string[];
            };
            expect(body.providerCalls.length).toBeGreaterThan(0);
            if (id === "release_stage_admission")
              expect(body.state.releaseStage).toBe("owner_preview");
            if (id === "product_entitlement_lifecycle")
              expect(body.state.entitlement).toBe("verified");
            if (id === "infrastructure_retirement")
              expect(body.state.infrastructure).toBe("retired");
            clock.advance(1);
            return {
              status: "passed",
              verified: true,
              resourcesBefore: id === "infrastructure_retirement" ? 2 : 0,
              resourcesAfter: 0,
              observedAt: clock.now().toISOString(),
            };
          });
        }

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
    if (testInfo.project.name === "desktop-chrome") {
      const sourceRevision = process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION;
      const runId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID;
      const observedAt = process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT;
      const signingSecret = process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET;
      const ledgerPath = process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH;
      if (sourceRevision && runId && observedAt && signingSecret && ledgerPath) {
        await mkdir(dirname(ledgerPath), { recursive: true });
        const ledger = createFounderProductContractScenarioLedger({
          sourceRevision,
          runId,
          observedAt,
          results: harness.scenarioResults,
          signingSecret,
        });
        await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
      }
    }
  } finally {
    await deleteFixture(fixture);
  }
});

function signedCommerceEvent(runId: string) {
  const event = { eventId: `${runId}:entitlement`, status: "active" as const };
  const secret =
    process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET ??
    "founder-contract-development-secret";
  return {
    ...event,
    signature: `hmac-sha256:${createHmac("sha256", secret)
      .update(JSON.stringify(event))
      .digest("hex")}`,
  };
}

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

async function gateLifecycleRequest(
  body: unknown,
  path: string,
  context: FounderProductContractApplicationContext | undefined,
): Promise<{
  status: number;
  headers: Record<string, string>;
  json: () => Promise<unknown>;
} | null> {
  if (
    path !== "/api/operator/founder-product-contract/lifecycle" ||
    !body ||
    typeof body !== "object"
  ) {
    return null;
  }
  const action = (body as { action?: unknown }).action;
  const providerResult =
    action === "release_stage_admission"
      ? await context?.providers.clerk.request("authenticate")
      : action === "product_entitlement_lifecycle"
        ? await context?.providers.lemonSqueezy.request("receive_webhook")
        : action === "infrastructure_retirement"
          ? await context?.providers.digitalOcean.request("observe_owned_resources")
          : null;
  if (providerResult && !providerResult.ok) {
    return {
      status: 503,
      headers: { "cache-control": "no-store" },
      json: async () => ({ error: { code: providerResult.code } }),
    };
  }
  return null;
}

async function deleteFixture(fixture: { userId: string; operatorId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from app_metadata where key like ${`founder_product_contract_lifecycle:%:${fixture.userId}`}`;
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
