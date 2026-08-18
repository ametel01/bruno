import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_341;

test.use({ screenshot: "off", trace: "off", video: "off" });

test("founder explicitly selects calendars and sees bounded verification evidence", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      const state: {
        selected: boolean;
        status: "selecting" | "verifying" | "ready";
        limited: boolean;
        activated: boolean;
      } = {
        selected: false,
        status: "selecting",
        limited: false,
        activated: false,
      };
      await installCalendarRoutes(context, state);
      await page.goto("/operator");

      await expect(page.getByText("Your Calendar Connection", { exact: true })).toBeVisible();
      await expect(page.getByText("Choose exactly which calendars Bruno may read.")).toBeVisible();
      await expect(page.getByLabel("Primary")).not.toBeChecked();
      await expect(
        page.getByText("newly discovered calendars unselected", { exact: false }),
      ).toBeVisible();

      await page.getByLabel("Primary").check();
      await page.getByRole("button", { name: "Save and verify calendars" }).click();
      await expect(page.getByRole("heading", { name: "Google Calendar is ready" })).toBeVisible();
      await expect(page.getByText("Google granted read-only Calendar access.")).toBeVisible();
      await expect(page.getByText("Bruno is using 1 selected calendar.")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Calendar-only Limited Operation" }),
      ).toBeVisible();
      await page.getByRole("checkbox", { name: /I confirm that my Ready AI Connection/ }).check();
      await page.getByRole("button", { name: "Confirm Processing Consent" }).click();
      await expect(page.getByText("Safe Authority Policy · v1")).toBeVisible();
      await expect(page.getByText("verified quiet brief")).toBeVisible();
      await page.getByRole("button", { name: "Open Founder Morning Brief" }).click();
      await expect(page.getByText("Founder Activation recorded.")).toBeVisible();

      const secondContext = await browser.newContext();
      try {
        const secondPage = await secondContext.newPage();
        await installCalendarRoutes(secondContext, state);
        await secondPage.goto("/operator");
        await expect(
          secondPage.getByRole("heading", { name: "Google Calendar is ready" }),
        ).toBeVisible();
        await expect(secondPage.getByText("Bruno is using 1 selected calendar.")).toBeVisible();
        await expect(secondPage.getByText("Founder Activation recorded.")).toBeVisible();
      } finally {
        await secondContext.close();
      }
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function installCalendarRoutes(
  context: import("@playwright/test").BrowserContext,
  state: {
    selected: boolean;
    status: "selecting" | "verifying" | "ready";
    limited: boolean;
    activated: boolean;
  },
): Promise<void> {
  await context.route("**/api/operator/calendar", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: dto(state) }),
      });
      return;
    }
    const body = route.request().postDataJSON() as { action?: string; resourceIds?: string[] };
    if (body.action === "select") {
      expect(body.resourceIds).toEqual(["primary"]);
      state.selected = true;
      state.status = "verifying";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: dto(state) }),
      });
      return;
    }
    if (body.action === "verify") {
      expect(state.selected).toBe(true);
      state.status = "ready";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: dto(state) }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connection: dto(state) }),
    });
  });

  await context.route("**/api/operator/limited-operation", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ operation: limitedOperation(state) }),
      });
      return;
    }
    const body = route.request().postDataJSON() as { action?: string };
    if (body.action === "confirm_consent") state.limited = true;
    if (body.action === "open_brief") state.activated = true;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ operation: limitedOperation(state) }),
    });
  });

  await context.route("**/api/operator/connections", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connection: {
          provider: "openai",
          status: "ready",
          accountLabel: "Founder OpenAI",
          connectedAt: new Date().toISOString(),
          lastVerifiedAt: new Date().toISOString(),
          workState: "available",
          recoveryMessage: null,
          receipt: null,
        },
      }),
    });
  });
}

function dto(state: { selected: boolean; status: "selecting" | "verifying" | "ready" }) {
  const status = state.status;
  const isReady = status === "ready";
  return {
    provider: "google_calendar",
    status,
    accountLabel: "founder@example.com",
    connectedAt: "2026-08-19T01:00:00.000Z",
    lastVerifiedAt: isReady ? "2026-08-19T01:02:00.000Z" : null,
    evidenceState: isReady ? "current" : "unknown",
    workState: isReady ? "available" : "paused",
    recoveryMessage: null,
    resources: [
      {
        providerResourceId: "primary",
        summary: "Primary",
        timeZone: "Asia/Manila",
        accessRole: "owner",
        primaryCalendar: true,
        selected: state.selected,
        status: "available",
      },
      {
        providerResourceId: "team",
        summary: "Team calendar",
        timeZone: "Asia/Manila",
        accessRole: "reader",
        primaryCalendar: false,
        selected: false,
        status: "available",
      },
    ],
    receipt: isReady
      ? {
          provider: "google_calendar",
          accountLabel: "founder@example.com",
          outcome: "verified",
          grantedScopes: ["https://www.googleapis.com/auth/calendar.readonly"],
          selectedResourceCount: 1,
          evidenceState: "current",
          issuedAt: "2026-08-19T01:02:00.000Z",
        }
      : null,
  };
}

function limitedOperation(state: { limited?: boolean; activated?: boolean }) {
  return {
    name: "Calendar-only Limited Operation",
    status: state.limited ? "limited" : "awaiting_consent",
    mailIncluded: false,
    access: { ai: "ready", calendar: "ready", evidence: "current" },
    consent: {
      status: state.limited ? "active" : "missing",
      purpose: "calendar_morning_brief",
      confirmedAt: state.limited ? "2026-08-19T01:02:00.000Z" : null,
    },
    authorityPolicy: state.limited
      ? {
          version: 1,
          observation: "always",
          preparation: "always",
          externalEffects: "approval_required",
          mailIncluded: false,
        }
      : null,
    brief: state.limited
      ? {
          id: "brief-1",
          generation: 1,
          status: state.activated ? "opened" : "prepared",
          evidenceState: "current",
          quiet: true,
          content:
            "Nothing needs attention in your selected Calendar right now. This is a verified quiet brief.",
          generatedAt: "2026-08-19T01:02:00.000Z",
          openedAt: state.activated ? "2026-08-19T01:03:00.000Z" : null,
        }
      : null,
    activatedAt: state.activated ? "2026-08-19T01:03:00.000Z" : null,
  };
}

async function createFixture(): Promise<{ userId: string; operatorId: string }> {
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const createdAt = new Date(Date.now() - 2_000).toISOString();
  const at = new Date().toISOString();
  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${at})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${at})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${at}, ${at}, ${at}, ${createdAt}, ${at})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', 'e2e-founder-calendar', 'e2e-founder-calendar', 1, ${at}, ${at}, ${createdAt}, ${at})`;
  });
  return { userId, operatorId };
}

async function deleteFixture(fixture: { userId: string; operatorId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from operator_conversation_messages where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_conversation_works where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_calendar_connection_receipts where connection_id in (select id from operator_calendar_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_calendar_resources where connection_id in (select id from operator_calendar_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_calendar_connections where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_ai_connection_receipts where connection_id in (select id from operator_ai_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_ai_connections where operator_id = ${fixture.operatorId}`;
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
      if (previous)
        await sql`update app_metadata set value = ${previous.value}, updated_at = now() where key = 'local_development_user_id'`;
      else await sql`delete from app_metadata where key = 'local_development_user_id'`;
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
