import { expect, test } from "@playwright/test";

test("operator transition keeps the sign-in route public and accessible", async ({ page }) => {
  const response = await page.goto("/sign-in");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Authentication is not available" }),
  ).toBeVisible();
  await expect(page.locator("p[role=alert]")).toContainText(
    "Clerk sign-in is not enabled in this environment.",
  );
});

test("operator transition keeps the sign-up route public and accessible", async ({ page }) => {
  const response = await page.goto("/sign-up");

  expect(response?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Authentication is not available" }),
  ).toBeVisible();
  await expect(page.locator("p[role=alert]")).toContainText("Operator access remains active.");
});

test("runner machine routes retain their own validation and authentication contracts", async ({
  request,
}) => {
  const registration = await request.post("/runner/v1/register", { data: {} });
  const heartbeat = await request.post("/runner/v1/heartbeat", { data: {} });
  const bootstrapEvent = await request.post("/runner/v1/bootstrap-events", { data: {} });

  expect(registration.status()).toBe(400);
  expect((await registration.json()).error.code).toBe("validation_failed");
  expect(heartbeat.status()).toBe(401);
  expect((await heartbeat.json()).error.code).toBe("runner_unauthorized");
  expect(bootstrapEvent.status()).toBe(400);
  expect((await bootstrapEvent.json()).error.code).toBe("validation_failed");
});
