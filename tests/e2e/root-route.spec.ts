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
