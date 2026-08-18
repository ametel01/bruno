import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_345;

test.use({ screenshot: "off", trace: "off", video: "off" });

test("Founder confirms and corrects Relationship Records across desktop and mobile", async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const fixture = await createFixture();
  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await desktop.newPage();
        await page.goto("/operator");
        await expect(page.getByRole("heading", { name: "Relationship Records" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Relationship Candidates" })).toBeVisible();
        await expect(page.getByText("Morgan Lee", { exact: true })).toBeVisible();
        await expect(page.getByText(/domain needs confirmation/)).toBeVisible();
        await page.getByRole("button", { name: "Confirm relationship" }).click();
        await expect(
          page.getByRole("heading", { name: "Relationship Candidates" }),
        ).not.toBeVisible();
        await expect(page.getByRole("heading", { name: "Morgan Lee" })).toBeVisible();
        const evidence = {
          action: "ingest_evidence",
          observations: [
            {
              sourceKind: "calendar",
              connectionId: fixture.calendarConnectionId,
              provider: "google_calendar",
              providerItemId: "calendar-2",
              displayName: "Morgan Lee",
              company: "Acme Advisory",
              domain: "acme-advisory.example",
              observedAt: new Date().toISOString(),
            },
          ],
        };
        const ingested = await page.request.post("/api/operator/relationships", { data: evidence });
        expect(ingested.ok()).toBe(true);
        const duplicate = await page.request.post("/api/operator/relationships", {
          data: evidence,
        });
        expect(duplicate.ok()).toBe(true);
        const duplicateBody = (await duplicate.json()) as {
          relationships: { records: Array<{ evidence: unknown[] }> };
        };
        expect(duplicateBody.relationships.records[0]?.evidence).toHaveLength(2);
      } finally {
        await desktop.close();
      }

      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
      try {
        const page = await mobile.newPage();
        await page.goto("/operator");
        await expect(page.getByRole("heading", { name: "Relationship Records" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Morgan Lee" })).toBeVisible();
        await expect(page.getByText("Source current", { exact: true }).first()).toBeVisible();
        await page.getByLabel("Relationship state").selectOption("client");
        await page.getByLabel("Next action", { exact: true }).fill("Send the revised proposal");
        await page.getByRole("button", { name: "Save relationship" }).click();
        await expect(page.getByLabel("Relationship state")).toHaveValue("client");
        await expect(page.getByText("Correction revision 2", { exact: false })).toBeVisible();
      } finally {
        await mobile.close();
      }

      const secondDesktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      try {
        const page = await secondDesktop.newPage();
        await page.goto("/operator");
        await expect(page.getByLabel("Relationship state")).toHaveValue("client");
        await expect(page.getByLabel("Next action", { exact: true })).toHaveValue(
          "Send the revised proposal",
        );
      } finally {
        await secondDesktop.close();
      }
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function createFixture(): Promise<{
  userId: string;
  operatorId: string;
  calendarConnectionId: string;
}> {
  const userId = randomUUID();
  const operatorId = randomUUID();
  const preparationId = randomUUID();
  const runtimeId = randomUUID();
  const calendarConnectionId = randomUUID();
  const candidateId = randomUUID();
  const evidenceId = randomUUID();
  const createdAt = new Date(Date.now() - 2_000).toISOString();
  const at = new Date().toISOString();
  await withDatabase(async (sql) => {
    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${createdAt}, ${at})`;
    await sql`insert into operators (id, user_id, status, created_at, updated_at) values (${operatorId}, ${userId}, 'active', ${createdAt}, ${at})`;
    await sql`insert into operator_preparations (id, operator_id, status, timezone, timezone_confirmed_at, started_at, completed_at, created_at, updated_at) values (${preparationId}, ${operatorId}, 'ready', 'Asia/Manila', ${at}, ${at}, ${at}, ${createdAt}, ${at})`;
    await sql`insert into operator_runtimes (id, operator_id, status, transport_state, safety_state, config_revision, runtime_identity, attempt_count, started_at, ready_at, created_at, updated_at) values (${runtimeId}, ${operatorId}, 'ready', 'connected', 'verified', 'e2e-founder-relationships', 'e2e-founder-relationships', 1, ${at}, ${at}, ${createdAt}, ${at})`;
    await sql`insert into operator_calendar_connections (id, operator_id, provider, provider_subject_id, account_label, status, authorization_state, access_token_ciphertext, access_token_iv, access_token_auth_tag, refresh_token_ciphertext, refresh_token_iv, refresh_token_auth_tag, secret_key_version, authorized_at, last_verified_at, last_evidence_at, last_evidence_count, evidence_state, created_at, updated_at) values (${calendarConnectionId}, ${operatorId}, 'google_calendar', 'e2e-calendar-subject', 'founder@example.com', 'ready', 'authorized', 'a', 'b', 'c', 'd', 'e', 'f', 'e2e-test', ${at}, ${at}, ${at}, 1, 'current', ${createdAt}, ${at})`;
    await sql`insert into operator_relationship_candidates (id, operator_id, match_kind, status, display_name, company, domain, candidate_key, created_at, updated_at) values (${candidateId}, ${operatorId}, 'fuzzy_domain', 'pending', 'Morgan Lee', 'Acme Advisory', 'acme-advisory.example', 'fuzzy:morgan lee|acme advisory|acme-advisory.example', ${createdAt}, ${at})`;
    await sql`insert into operator_relationship_evidence (id, operator_id, candidate_id, source_kind, calendar_connection_id, provider, provider_item_id, display_name, company, domain, excerpt, evidence_state, observed_at, source_fingerprint, created_at, updated_at) values (${evidenceId}, ${operatorId}, ${candidateId}, 'calendar', ${calendarConnectionId}, 'google_calendar', 'calendar-1', 'Morgan Lee', 'Acme Advisory', 'acme-advisory.example', 'Discovery meeting', 'current', ${at}, ${`calendar:${calendarConnectionId}:calendar-1`}, ${createdAt}, ${at})`;
  });
  return { userId, operatorId, calendarConnectionId };
}

async function deleteFixture(fixture: { userId: string; operatorId: string }): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from operator_conversation_messages where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_conversation_works where conversation_id in (select id from operator_conversations where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_conversations where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_ai_connection_receipts where connection_id in (select id from operator_ai_connections where operator_id = ${fixture.operatorId})`;
    await sql`delete from operator_ai_connections where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_relationship_corrections where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_relationship_evidence where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_relationship_candidates where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_relationship_records where operator_id = ${fixture.operatorId}`;
    await sql`delete from operator_calendar_connections where operator_id = ${fixture.operatorId}`;
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
  const sql = postgres(process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno");
  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
