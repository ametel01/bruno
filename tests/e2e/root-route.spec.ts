import { expect, test } from "@playwright/test";
import postgres from "postgres";

const createdAgentIds = new Set<string>();

test.afterEach(async () => {
  const agentIds = [...createdAgentIds];
  createdAgentIds.clear();

  if (agentIds.length > 0) {
    await deleteCreatedAgents(agentIds);
  }
});

const shellRoutes = [
  { path: "/", heading: "Operational dashboard" },
  { path: "/dashboard", heading: "Operational dashboard" },
  { path: "/agents", heading: "Agent inventory" },
  { path: "/settings", heading: "Workspace settings" },
] as const;

for (const route of shellRoutes) {
  test(`${route.path} renders the AgentBay shell`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.getByRole("link", { name: "AgentBay dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    await expect(page.getByRole("heading", { name: route.heading })).toBeVisible();
    await expect(page.getByRole("link", { name: "Health JSON" })).toHaveAttribute(
      "href",
      "/health",
    );
  });
}

test("/health returns reachable database JSON in the browser", async ({ page }) => {
  await page.goto("/health");

  await expect(page.locator("body")).toContainText('"status":"ok"');
  await expect(page.locator("body")).toContainText('"database":"reachable"');
});

test("/agents creates Research Agent and persists it across read surfaces", async ({
  isMobile,
  page,
}) => {
  test.skip(isMobile, "final exact-name Milestone 1 smoke path runs once on desktop");

  const name = "Research Agent";

  await page.goto("/agents");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Template").selectOption("research_agent");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Agent created.");
  const agentLink = page.getByRole("link", { name });
  await expect(agentLink).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();
  const agentHref = await agentLink.getAttribute("href");
  expect(agentHref).toMatch(/^\/agents\/[0-9a-f-]+$/);
  trackAgentHref(agentHref);

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

  await page.reload();

  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*Research Agent.*stopped`) }),
  ).toBeVisible();

  expect(agentHref).not.toBeNull();
  await page.goto(agentHref ?? "/agents/missing");
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("stopped")).toBeVisible();
  await expect(page.getByText("research_agent")).toBeVisible();
  await expect(page.getByText("Created")).toBeVisible();
  await expect(page.getByText("Updated")).toBeVisible();

  await page.reload();

  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText("stopped")).toBeVisible();
});

test("/agents shows safe client validation for invalid create input", async ({ page }) => {
  await page.goto("/agents");
  await page.getByLabel("Name").fill("   ");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Name is required.");
  await expect(page.getByRole("status")).not.toContainText("postgres://");
});

test("/agents detail returns not found for missing, malformed, and soft-deleted IDs", async ({
  page,
  request,
}, testInfo) => {
  const missingResponse = await page.goto("/agents/00000000-0000-4000-8000-000000000000");

  expect(missingResponse?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText("No record lookup is performed");

  const malformedResponse = await page.goto("/agents/not-a-uuid");

  expect(malformedResponse?.status()).toBe(404);
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

  const deletedResponse = await page.goto(`/agents/${created.agent.id}`);

  expect(deletedResponse?.status()).toBe(404);
  await expect(page.locator("body")).not.toContainText("Soft Deleted Agent");
  await expect(page.locator("body")).not.toContainText("No record lookup is performed");
});

function trackAgentHref(agentHref: string | null): void {
  const agentId = agentHref?.match(/^\/agents\/([0-9a-f-]+)$/)?.[1];

  if (agentId) {
    createdAgentIds.add(agentId);
  }
}

async function markAgentDeleted(agentId: string): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`update agents set deleted_at = now() where id = ${agentId}`;
  });
}

async function deleteCreatedAgents(agentIds: string[]): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from agent_events where agent_id in ${sql(agentIds)}`;
    await sql`delete from agents where id in ${sql(agentIds)}`;
  });
}

async function withDatabase(run: (sql: postgres.Sql) => Promise<void>): Promise<void> {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/agentbay";
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
  });

  try {
    await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
