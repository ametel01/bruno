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
      await expect(page.getByText("Canonical Action Preview")).toHaveCount(3);
      await expect(
        page.locator(`[data-preview-id="${conversation.actionPreview.id}"]`),
      ).toHaveCount(3);
      await expect(
        page.locator(`[data-proposed-action-id="${conversation.proposedAction.id}"]`),
      ).toHaveCount(3);
      await expect(page.getByText("preview@example.com", { exact: false }).first()).toBeVisible();

      await page.getByLabel("Message Bruno").fill("Find the most important follow-up for today.");
      await page.getByRole("button", { name: "Send to Bruno" }).click();
      await expect(page.locator('[data-role="founder"]')).toContainText(
        "Find the most important follow-up for today.",
      );
      await expect(page.locator('[data-role="operator"]')).toContainText(
        "I found one follow-up worth reviewing today.",
      );

      await page.getByLabel("Content").fill("A revised prepared note.");
      await page.getByRole("button", { name: "Save as new draft" }).click();
      await expect(page.getByRole("heading", { name: /revision 2/ })).toBeVisible();

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
        await expect(
          secondPage.getByText("A revised prepared note.", { exact: true }).first(),
        ).toBeVisible();
      } finally {
        await closeContextAfterNetworkIdle(secondContext);
      }
      await page.waitForLoadState("networkidle");
    });
  } finally {
    await page.close();
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
  actionPreview: {
    id: string;
    current: {
      id: string;
      revision: number;
      state: "draft";
      recipient: { name: string; address: string };
      content: string;
      supportingEvidence: Array<{ label: string; detail: string }>;
      expectedExternalEffect: string;
      createdAt: string;
    };
    history: unknown[];
    authority: "none";
    executable: false;
    mailSendingOffer: "available" | "dismissed";
    createdAt: string;
    updatedAt: string;
  };
  proposedAction: {
    id: string;
    version: number;
    supersedesId: string | null;
    actionFamily: "external_communication";
    actionSubtype: string | null;
    businessOutcome: string;
    connection: {
      companyConnectionId: string | null;
      connectionResourceId: string | null;
      accessVersion: number | null;
      processingConsentId: string | null;
      consentVersion: number | null;
    };
    destination: Record<string, unknown>;
    materialContent: Record<string, unknown>;
    sideEffects: string[];
    policy: { id: string | null; version: number; mode: "approval_required" };
    productGuardrails: { version: number; blocked: boolean; reason: string | null };
    preconditions: Array<{ key: string; description: string }>;
    validUntil: string;
    executionWindow: { start: string | null; end: string | null };
    idempotencyKey: string;
    state: "awaiting_approval";
    decision: null;
    authorization: null;
    createdAt: string;
    updatedAt: string;
  };
  updatedAt: string;
};

function createConversation(): Conversation {
  return {
    id: randomUUID(),
    status: "active",
    messages: [],
    activeWork: null,
    actionPreview: {
      id: randomUUID(),
      current: {
        id: randomUUID(),
        revision: 1,
        state: "draft",
        recipient: { name: "Preview Recipient", address: "preview@example.com" },
        content: "A prepared note awaiting Founder review.",
        supportingEvidence: [{ label: "Calendar", detail: "Planning call" }],
        expectedExternalEffect: "Nothing is sent; this preview has no authority.",
        createdAt: new Date().toISOString(),
      },
      history: [],
      authority: "none",
      executable: false,
      mailSendingOffer: "available",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    proposedAction: {
      id: randomUUID(),
      version: 1,
      supersedesId: null,
      actionFamily: "external_communication",
      actionSubtype: "one_to_one_follow_up",
      businessOutcome: "Send one exact follow-up to the known relationship.",
      connection: {
        companyConnectionId: null,
        connectionResourceId: null,
        accessVersion: null,
        processingConsentId: null,
        consentVersion: null,
      },
      destination: { recipient: "preview@example.com" },
      materialContent: { body: "A proposed follow-up." },
      sideEffects: ["One message would be sent."],
      policy: { id: null, version: 1, mode: "approval_required" },
      productGuardrails: { version: 1, blocked: false, reason: null },
      preconditions: [{ key: "mail_sending_ready", description: "Mail Sending is Ready." }],
      validUntil: new Date(Date.now() + 86_400_000).toISOString(),
      executionWindow: { start: null, end: null },
      idempotencyKey: randomUUID(),
      state: "awaiting_approval",
      decision: null,
      authorization: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
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

  await context.route("**/api/operator/action-preview", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ preview: conversation.actionPreview }),
      });
      return;
    }
    const body = route.request().postDataJSON() as { action?: string; content?: string };
    if (body.action === "dismiss_mail_offer") {
      conversation.actionPreview.mailSendingOffer = "dismissed";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ preview: conversation.actionPreview }),
      });
      return;
    }
    conversation.actionPreview.current = {
      ...conversation.actionPreview.current,
      id: randomUUID(),
      revision: conversation.actionPreview.current.revision + 1,
      content: body.content ?? conversation.actionPreview.current.content,
    };
    conversation.actionPreview.history = [conversation.actionPreview.current];
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ preview: conversation.actionPreview }),
    });
  });

  await context.route("**/api/operator/proposed-actions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ actions: [conversation.proposedAction] }),
    });
  });

  await context.route("**/api/operator/limited-operation", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        operation: {
          name: "Calendar-only Limited Operation",
          status: "limited",
          mailIncluded: false,
          access: { ai: "ready", calendar: "ready", evidence: "current" },
          consent: {
            status: "active",
            purpose: "calendar_morning_brief",
            confirmedAt: new Date().toISOString(),
          },
          authorityPolicy: null,
          brief: null,
          actionPreview: conversation.actionPreview,
          proposedAction: conversation.proposedAction,
          activatedAt: null,
        },
      }),
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

async function closeContextAfterNetworkIdle(context: BrowserContext): Promise<void> {
  await Promise.all(
    context.pages().map((page) => page.waitForLoadState("networkidle").catch(() => undefined)),
  );
  await context.close();
}
