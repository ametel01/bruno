import { expect, test } from "@playwright/test";

const retiredPages = ["/dashboard", "/agents", "/agents/example", "/settings"] as const;
const retiredApis = [
  "/api/agents",
  "/api/agents/example/secrets",
  "/api/approvals/example/approve",
  "/api/runners",
  "/api/runners/registration-tokens",
] as const;

for (const pathname of retiredPages) {
  test(`${pathname} redirects to the Founder workspace`, async ({ page }) => {
    await page.goto(pathname);

    await expect(page).toHaveURL(/\/operator(?:#.*)?$/);
    await expect(page.getByRole("heading", { name: "Bruno.Ai Operator" })).toBeVisible();
  });
}

for (const pathname of retiredApis) {
  test(`${pathname} cannot collect legacy Founder configuration`, async ({ request }) => {
    const response = await request.post(pathname, {
      data: {
        apiKey: "must-not-be-accepted",
        cronExpression: "0 * * * *",
        model: "must-not-be-accepted",
        runnerId: "must-not-be-accepted",
        telegramBotToken: "must-not-be-accepted",
      },
    });

    expect(response.status()).toBe(410);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(await response.json()).toEqual({
      error: {
        code: "legacy_founder_surface_retired",
        message: "This legacy setup surface is no longer available. Use the Founder workspace.",
      },
    });
  });
}

test("server-owned infrastructure routes remain outside the retired Founder boundary", async ({
  request,
}) => {
  const response = await request.post("/api/internal/agent-deployments/reconcile");

  expect(response.status()).not.toBe(410);
});
