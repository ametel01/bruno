import { expect, test } from "@playwright/test";

const shellRoutes = [
  { path: "/", heading: "Operational dashboard" },
  { path: "/dashboard", heading: "Operational dashboard" },
  { path: "/agents", heading: "Agent inventory" },
  { path: "/agents/test-agent", heading: "test-agent" },
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

test("/agents creates and refreshes a persisted stopped agent", async ({ page }, testInfo) => {
  const name = `Research Agent ${testInfo.project.name}`;

  await page.goto("/agents");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Template").selectOption("research_agent");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Agent created.");
  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*research_agent.*stopped`) }),
  ).toBeVisible();

  await page.reload();

  await expect(page.getByRole("link", { name })).toBeVisible();
  await expect(
    page.getByRole("row", { name: new RegExp(`${name}.*research_agent.*stopped`) }),
  ).toBeVisible();
});

test("/agents shows safe client validation for invalid create input", async ({ page }) => {
  await page.goto("/agents");
  await page.getByLabel("Name").fill("   ");
  await page.getByRole("button", { name: "Create agent" }).click();

  await expect(page.getByRole("status")).toContainText("Name is required.");
  await expect(page.getByRole("status")).not.toContainText("postgres://");
});
