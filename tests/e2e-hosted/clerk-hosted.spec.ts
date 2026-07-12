import { clerk } from "@clerk/testing/playwright";
import { expect, test, type Page } from "@playwright/test";

const userAEmail = process.env.E2E_CLERK_TEST_USER_A_EMAIL;
const userBEmail = process.env.E2E_CLERK_TEST_USER_B_EMAIL;

test.describe.configure({ mode: "serial" });

test("email-code sign-in exposes the current-user surface and signs out", async ({ page }) => {
  await signInWithEmailCode(page, requireTestIdentity(userAEmail));

  await expect(page.getByText("Current user", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in/);

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/sign-in/);
});

test("two email-code identities keep independent browser sessions", async ({ browser }) => {
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();

  try {
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    await signInWithEmailCode(pageA, requireTestIdentity(userAEmail));
    await signInWithEmailCode(pageB, requireTestIdentity(userBEmail));

    await expect(pageA.getByText("Current user", { exact: true })).toBeVisible();
    await expect(pageB.getByText("Current user", { exact: true })).toBeVisible();

    await pageA.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(pageA).toHaveURL(/\/sign-in/);

    await pageB.goto("/dashboard");
    await expect(pageB).toHaveURL(/\/dashboard/);
    await expect(pageB.getByText("Current user", { exact: true })).toBeVisible();
  } finally {
    await Promise.all([contextA.close(), contextB.close()]);
  }
});

async function signInWithEmailCode(page: Page, identifier: string): Promise<void> {
  await page.goto("/sign-in", { waitUntil: "domcontentloaded" });
  await clerk.signIn({
    page,
    signInParams: {
      strategy: "email_code",
      identifier,
    },
  });
  await page.goto("/dashboard");
  await expectResolvedIdentity(page, identifier);
}

async function expectResolvedIdentity(page: Page, expectedIdentity: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate((expected) => {
          const clerk = (
            window as unknown as {
              Clerk?: {
                user?: {
                  primaryEmailAddress?: { emailAddress?: string | null } | null;
                } | null;
              };
            }
          ).Clerk;

          return (
            clerk?.user?.primaryEmailAddress?.emailAddress?.toLowerCase() === expected.toLowerCase()
          );
        }, expectedIdentity),
      { timeout: 15_000 },
    )
    .toBe(true);
}

function requireTestIdentity(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("Hosted Clerk E2E test identity capability is missing.");
  }

  return value;
}
