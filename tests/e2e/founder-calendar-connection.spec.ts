import { randomUUID } from "node:crypto";
import { type BrowserContext, expect, test } from "@playwright/test";
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
      const mailState: {
        status: "offer" | "selecting" | "ready";
        selected: boolean;
        offerDisposition: "unknown" | "enabled" | "dismissed";
      } = {
        status: "offer",
        selected: false,
        offerDisposition: "unknown",
      };
      await installCalendarRoutes(context, state);
      await installMailRoutes(context, mailState);
      await page.goto("/operator");

      await expect(page.getByText("Your Calendar Connection", { exact: true })).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Bring Mail evidence into your workspace?" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Review Gmail reading" }).click();
      await page.getByRole("button", { name: "Connect Gmail reading" }).click();
      await expect(
        page.getByText("Choose exactly which Gmail labels Bruno may read."),
      ).toBeVisible();
      await page.getByLabel("Inbox").check();
      await page.getByRole("button", { name: "Save and verify labels" }).click();
      await expect(page.getByRole("heading", { name: "Gmail reading is ready" })).toBeVisible();
      await expect(page.getByText("Bruno is using 1 selected Gmail label.")).toBeVisible();
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
        await closeContextAfterNetworkIdle(secondContext);
      }

      const dismissContext = await browser.newContext();
      try {
        const dismissPage = await dismissContext.newPage();
        const dismissMailState = {
          status: "offer" as const,
          selected: false,
          offerDisposition: "unknown" as const,
        };
        await installCalendarRoutes(dismissContext, state);
        await installMailRoutes(dismissContext, dismissMailState);
        await dismissPage.goto("/operator");
        await expect(
          dismissPage.getByRole("heading", { name: "Bring Mail evidence into your workspace?" }),
        ).toBeVisible();
        await dismissPage.getByRole("button", { name: "Not now" }).click();
        await expect(
          dismissPage.getByRole("heading", { name: "Bring Mail evidence into your workspace?" }),
        ).not.toBeVisible();
        await dismissPage.reload();
        await expect(
          dismissPage.getByRole("heading", { name: "Bring Mail evidence into your workspace?" }),
        ).not.toBeVisible();
      } finally {
        await closeContextAfterNetworkIdle(dismissContext);
      }
      await page.waitForLoadState("networkidle");
    });
  } finally {
    await page.close();
    await deleteFixture(fixture);
  }
});

test("founder resumes a persisted Core Operation on desktop and mobile", async ({ browser }) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();
  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        const context = await browser.newContext({ viewport });
        try {
          const page = await context.newPage();
          await page.emulateMedia({ reducedMotion: "reduce" });
          const state = { confirmed: false, activated: false, mode: "ready" as const };
          await installCoreRoutes(context, state);
          await page.goto("/operator");
          await expect(page.getByRole("heading", { name: "Core Operation" })).toBeVisible();
          await expect(page.getByText("Mail Sending is never required here.")).toBeVisible();
          await page.getByRole("checkbox", { name: /matched Calendar and selected Mail/ }).check();
          await page.getByRole("button", { name: "Confirm Core Operation" }).click();
          await expect(page.getByText("Mail Sending: not required")).toBeVisible();
          await page.getByRole("button", { name: "Open Founder Morning Brief" }).click();
          await expect(
            page.getByText("Founder Activation recorded. Conversation is your current workspace."),
          ).toBeVisible();
          await page.reload();
          await expect(
            page.getByText("Founder Activation recorded. Conversation is your current workspace."),
          ).toBeVisible();
          const workspace = page.getByRole("region", { name: "Current Founder workspace" });
          await expect(workspace.locator("#conversation")).toBeVisible();
          await expect(
            workspace.getByRole("heading", { name: "Founder Morning Brief" }),
          ).toBeVisible();
          await expect(workspace.locator("#needs-you")).toBeVisible();
          const layoutEvidence = await workspace.evaluate((element) => {
            const conversation = element.querySelector("#conversation");
            const brief = element.querySelector("#core-operation #core-brief-title");
            const proposed = element.querySelector("#core-operation [data-proposed-action-id]");
            const style = getComputedStyle(element);
            return {
              columns: style.gridTemplateColumns.split(" ").length,
              conversationBeforeBrief: Boolean(
                conversation &&
                  brief &&
                  conversation.compareDocumentPosition(brief) & Node.DOCUMENT_POSITION_FOLLOWING,
              ),
              briefBeforeProposed: Boolean(
                brief &&
                  proposed &&
                  brief.compareDocumentPosition(proposed) & Node.DOCUMENT_POSITION_FOLLOWING,
              ),
              noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
              scrollBehavior: style.scrollBehavior,
            };
          });
          expect(layoutEvidence.columns).toBe(viewport.width >= 760 ? 2 : 1);
          expect(layoutEvidence.conversationBeforeBrief).toBe(true);
          expect(layoutEvidence.briefBeforeProposed).toBe(true);
          expect(layoutEvidence.noHorizontalOverflow).toBe(true);
          expect(layoutEvidence.scrollBehavior).toBe("auto");
          const nowLink = page.getByRole("link", { name: "Now" });
          await nowLink.focus();
          await expect(nowLink).toBeFocused();
          await expect(nowLink).toHaveCSS("outline-style", "solid");
        } finally {
          await closeContextAfterNetworkIdle(context);
        }
      }
    });
  } finally {
    await deleteFixture(fixture);
  }
});

test("founder sees denied, partial, and stale onboarding facts on desktop and mobile", async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();
  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      for (const mode of ["denied", "partial", "stale"] as const) {
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          const context = await browser.newContext({ viewport });
          try {
            const page = await context.newPage();
            await installCoreRoutes(context, { confirmed: false, activated: false, mode });
            await page.goto("/operator");
            const step = mode === "denied" ? "ai" : mode === "partial" ? "calendar" : "mail";
            await expect(page.locator(`[data-next-step="${step}"]`)).toBeVisible();
            await expect(
              page.getByText(new RegExp(`AI: ${mode === "denied" ? "Not connected" : "Ready"}`)),
            ).toBeVisible();
            if (mode === "stale")
              await expect(page.getByText(/Mail: Needs a fresh check/)).toBeVisible();
          } finally {
            await closeContextAfterNetworkIdle(context);
          }
        }
      }
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function installCoreRoutes(
  context: import("@playwright/test").BrowserContext,
  state: {
    confirmed: boolean;
    activated: boolean;
    mode?: "ready" | "denied" | "partial" | "stale";
  },
): Promise<void> {
  await context.route("**/api/operator/onboarding", async (route) => {
    const mode = state.mode ?? "ready";
    const nextStep =
      mode === "denied"
        ? "ai"
        : mode === "partial"
          ? "calendar"
          : mode === "stale"
            ? "mail"
            : state.activated
              ? "conversation"
              : state.confirmed
                ? "brief"
                : "consent";
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        onboarding: {
          nextStep,
          defaultRoute: `/operator#onboarding-${nextStep}`,
          activated: state.activated,
          operation: "core",
          capabilities: {
            ai: mode === "denied" ? "missing" : "ready",
            calendar: mode === "partial" ? "missing" : "ready",
            mail: mode === "stale" ? "stale" : "ready",
            core: mode === "ready" ? "ready" : "missing",
          },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: true,
            processingConsent: state.confirmed,
            firstBriefReady: state.confirmed,
            primarySuiteIdentity: "google-founder",
          },
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
          connectedAt: "2026-08-19T01:00:00.000Z",
          lastVerifiedAt: "2026-08-19T01:00:00.000Z",
          workState: "available",
          recoveryMessage: null,
          receipt: null,
        },
      }),
    });
  });
  await context.route("**/api/operator/action-preview", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ preview: null }),
    });
  });
  await context.route("**/api/operator/proposed-actions", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ actions: [coreProposedAction()] }),
    });
  });
  await context.route("**/api/operator/calendar", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connection: dto({ selected: true, status: "ready" }) }),
    });
  });
  await context.route("**/api/operator/mail", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        connection: mailDto({ status: "ready", selected: true }),
        offerDisposition: "enabled",
      }),
    });
  });
  await context.route("**/api/operator/limited-operation", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ operation: null }),
    });
  });
  await context.route("**/api/operator/core-operation", async (route) => {
    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as { action?: string };
      if (body.action === "confirm_consent") state.confirmed = true;
      if (body.action === "open_brief") state.activated = true;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ operation: coreOperation(state) }),
    });
  });
}

function coreOperation(state: { confirmed: boolean; activated: boolean }) {
  return {
    name: "Core Operation",
    status: state.confirmed ? "core" : "awaiting_consent",
    mailIncluded: true,
    mailSendingRequired: false,
    suite: { status: "active", providerSubjectId: "google-founder" },
    access: { ai: "ready", calendar: "ready", mail: "ready", evidence: "current" },
    consent: {
      status: state.confirmed ? "active" : "missing",
      purpose: "core_operation",
      confirmedAt: state.confirmed ? "2026-08-19T01:02:00.000Z" : null,
    },
    authorityPolicy: state.confirmed
      ? {
          version: 1,
          observation: "always",
          preparation: "always",
          externalEffects: "approval_required",
          mailIncluded: false,
        }
      : null,
    brief: state.confirmed
      ? {
          id: "core-brief-1",
          generation: 1,
          status: state.activated ? "opened" : "prepared",
          evidenceState: "current",
          quiet: false,
          attentionCount: 1,
          content: "Your Primary Communications Suite is Current.",
          generatedAt: "2026-08-19T01:02:00.000Z",
          openedAt: state.activated ? "2026-08-19T01:03:00.000Z" : null,
        }
      : null,
    proposedAction: state.confirmed ? coreProposedAction() : null,
    activatedAt: state.activated ? "2026-08-19T01:03:00.000Z" : null,
  };
}

function coreProposedAction() {
  return {
    id: "core-proposed-action-1",
    version: 1,
    supersedesId: null,
    actionFamily: "external_communication" as const,
    actionSubtype: "one_to_one_follow_up",
    businessOutcome: "Send one exact follow-up to the known relationship.",
    connection: {
      companyConnectionId: null,
      connectionResourceId: null,
      accessVersion: null,
      processingConsentId: null,
      consentVersion: null,
    },
    destination: { recipient: "founder@example.com" },
    materialContent: { subject: "Founder follow-up", body: "A prepared note." },
    sideEffects: ["One external message after approval."],
    policy: { id: null, version: 1, mode: "approval_required" as const },
    productGuardrails: { version: 1, blocked: false, reason: null },
    preconditions: [
      { key: "connection", description: "A reviewed Founder connection is current." },
    ],
    validUntil: "2026-08-20T02:00:00.000Z",
    executionWindow: { start: null, end: null },
    idempotencyKey: "core-proposed-action-key",
    state: "awaiting_approval" as const,
    decision: null,
    authorization: null,
    createdAt: "2026-08-19T01:03:00.000Z",
    updatedAt: "2026-08-19T01:03:00.000Z",
  };
}

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

async function installMailRoutes(
  context: import("@playwright/test").BrowserContext,
  state: {
    status: "offer" | "selecting" | "ready";
    selected: boolean;
    offerDisposition: "unknown" | "enabled" | "dismissed";
  },
): Promise<void> {
  await context.route("**/api/operator/mail", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          connection: state.status === "offer" ? null : mailDto(state),
          offerDisposition: state.offerDisposition === "unknown" ? null : state.offerDisposition,
        }),
      });
      return;
    }
    const body = route.request().postDataJSON() as {
      action?: string;
      resourceIds?: string[];
      disposition?: "enabled" | "dismissed";
    };
    if (body.action === "offer") {
      state.offerDisposition = body.disposition ?? "dismissed";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: null, offerDisposition: state.offerDisposition }),
      });
      return;
    }
    if (body.action === "start") {
      state.offerDisposition = "enabled";
      state.status = "selecting";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: mailDto(state), authorization: null }),
      });
      return;
    }
    if (body.action === "select") {
      expect(body.resourceIds).toEqual(["INBOX"]);
      state.selected = true;
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: mailDto(state) }),
      });
      return;
    }
    if (body.action === "verify") {
      expect(state.selected).toBe(true);
      state.status = "ready";
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ connection: mailDto(state) }),
      });
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ connection: mailDto(state) }),
    });
  });
}

function mailDto(state: { status: "offer" | "selecting" | "ready"; selected: boolean }) {
  const ready = state.status === "ready";
  return {
    provider: "google_gmail",
    status: state.status === "offer" ? "selecting" : state.status,
    accountLabel: "founder@example.com",
    connectedAt: "2026-08-19T01:00:00.000Z",
    lastVerifiedAt: ready ? "2026-08-19T01:02:00.000Z" : null,
    evidenceState: ready ? "current" : "unknown",
    workState: ready ? "available" : "paused",
    recoveryMessage: null,
    suite: { status: "matched", grouped: ready, name: "Primary Communications Suite" },
    release: {
      qualified: true,
      requiredScope: "https://www.googleapis.com/auth/gmail.readonly",
      disclosure:
        "Bruno reads only the selected Gmail labels, keeps bounded evidence, and may send nothing through this connection.",
      retentionDays: 90,
      deletion:
        "Disconnect stops access; retained Bruno data follows the staged deletion controls.",
      aiLimitedUse:
        "Selected mail evidence may be processed only to prepare the Founder workspace and its bounded briefs.",
    },
    resources: [
      {
        providerResourceId: "INBOX",
        name: "Inbox",
        labelType: "system",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        selected: state.selected,
        status: "available",
      },
      {
        providerResourceId: "PROJECTS",
        name: "Projects",
        labelType: "user",
        messageListVisibility: "show",
        labelListVisibility: "labelShow",
        selected: false,
        status: "available",
      },
    ],
    receipt: ready
      ? {
          provider: "google_gmail",
          accountLabel: "founder@example.com",
          outcome: "verified",
          grantedScopes: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.readonly",
          ],
          selectedResourceCount: 1,
          evidenceState: "current",
          suiteStatus: "matched",
          issuedAt: "2026-08-19T01:02:00.000Z",
        }
      : null,
  };
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
    await sql`delete from operator_founder_activations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_governance_receipts where operator_id = ${fixture.operatorId}`;
    await sql`update operator_limited_operations set first_brief_id = null where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_morning_briefs where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_limited_operations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_processing_consents where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_authority_policies where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_primary_communications_suites where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_mail_connection_receipts where connection_id in (select id from operator_mail_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_mail_resources where connection_id in (select id from operator_mail_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_mail_connections where operator_id = ${fixture.operatorId}`;
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

async function closeContextAfterNetworkIdle(context: BrowserContext): Promise<void> {
  await Promise.all(
    context.pages().map((page) => page.waitForLoadState("networkidle").catch(() => undefined)),
  );
  await context.close();
}
