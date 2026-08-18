import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_340;

test.use({ screenshot: "off", trace: "off", video: "off" });

test("founder can converse with Bruno and see the same history after reload and on another device", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      const conversation = createConversation();
      await installConversationRoutes(context, conversation);

      await page.goto("/operator");
      await expect(
        page.getByRole("heading", { name: "What should we handle today?" }),
      ).toBeVisible();
      await expect(page.getByText("Your Operator is ready.")).toBeVisible();
      await expect(
        page.getByText("Conversation is saved across reloads and devices."),
      ).toBeVisible();

      await page.getByLabel("Message Bruno").fill("Find the most important follow-up for today.");
      await page.getByRole("button", { name: "Send to Bruno" }).click();
      await expect(page.locator('[data-role="founder"]')).toContainText(
        "Find the most important follow-up for today.",
      );
      await expect(page.locator('[data-role="operator"]')).toContainText(
        "I found one follow-up worth reviewing today.",
      );

      await page.reload();
      await expect(page.locator('[data-role="founder"]')).toContainText(
        "Find the most important follow-up for today.",
      );

      const secondContext = await browser.newContext();
      try {
        const secondPage = await secondContext.newPage();
        await installConversationRoutes(secondContext, conversation);
        await secondPage.goto("/operator");
        await expect(secondPage.locator('[data-role="operator"]')).toContainText(
          "I found one follow-up worth reviewing today.",
        );
        await expect(secondPage.locator('[data-role="founder"]')).toContainText(
          "Find the most important follow-up for today.",
        );
      } finally {
        await secondContext.close();
      }
    });
  } finally {
    await deleteFixture(fixture);
  }
});

type Conversation = {
  id: string;
  status: "active" | "paused";
  messages: Array<{
    id: string;
    workId: string | null;
    sequence: number;
    role: "founder" | "operator";
    status: "complete" | "paused";
    body: string;
    createdAt: string;
  }>;
  activeWork: null;
  updatedAt: string;
};

function createConversation(): Conversation {
  return {
    id: randomUUID(),
    status: "active",
    messages: [],
    activeWork: null,
    updatedAt: new Date().toISOString(),
  };
}

async function installConversationRoutes(
  context: BrowserContext,
  conversation: Conversation,
): Promise<void> {
  await context.route("**/api/operator/conversation", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ conversation }),
      });
      return;
    }

    const body = route.request().postDataJSON() as { message?: unknown; requestId?: unknown };
    expect(body.message).toBe("Find the most important follow-up for today.");
    expect(body.requestId).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/));
    const now = new Date().toISOString();
    const workId = randomUUID();
    conversation.messages = [
      {
        id: randomUUID(),
        workId,
        sequence: 1,
        role: "founder",
        status: "complete",
        body: body.message as string,
        createdAt: now,
      },
      {
        id: randomUUID(),
        workId,
        sequence: 2,
        role: "operator",
        status: "complete",
        body: "I found one follow-up worth reviewing today.",
        createdAt: now,
      },
    ];
    conversation.updatedAt = now;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ conversation }),
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

async function createFixture(): Promise<{ userId: string; operatorId: string }> {
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const createdAt = new Date(Date.now() - 2_000).toISOString();
  const at = new Date().toISOString();

  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${at})`;
    await sql`
      insert into operators (id, user_id, status, created_at, updated_at)
      values (${operatorId}, ${userId}, 'active', ${createdAt}, ${at})
    `;
    await sql`
      insert into operator_preparations (
        id, operator_id, status, timezone, timezone_confirmed_at,
        started_at, completed_at, created_at, updated_at
      ) values (
        ${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${at},
        ${at}, ${at}, ${createdAt}, ${at}
      )
    `;
    await sql`
      insert into operator_runtimes (
        id, operator_id, status, transport_state, safety_state,
        config_revision, runtime_identity, attempt_count, started_at, ready_at,
        created_at, updated_at
      ) values (
        ${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified',
        'e2e-founder-conversation', 'e2e-founder-conversation', 1, ${at}, ${at},
        ${createdAt}, ${at}
      )
    `;
  });

  return { userId, operatorId };
}

async function deleteFixture(fixture: { userId: string; operatorId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`
      delete from operator_conversation_messages
      where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})
    `;
    await sql`
      delete from operator_conversation_works
      where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})
    `;
    await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
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

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
  const sql = postgres(databaseUrl, { connect_timeout: 5, idle_timeout: 60, max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
