import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createFounderProductContractClock } from "@/src/testing/founder-product-contract";
import {
  createFounderProductContractFixture,
  deleteFounderProductContractFixture,
  prepareFounderExternalBetaBrowserFixture,
  withPinnedFounderDevelopmentUser,
} from "./founder-product-contract-fixture";

test("Operator UI remains usable across the required browser matrix", async ({ page, request }) => {
  const clock = createFounderProductContractClock(
    process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT ?? new Date().toISOString(),
  );
  const fixture = await createFounderProductContractFixture(clock);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await withPinnedFounderDevelopmentUser(fixture.userId, async () => {
      const apiResponse = await request.get("/api/operator");
      expect(apiResponse.status()).toBe(200);
      expect(apiResponse.headers()["cache-control"]).toBe("no-store");
      const apiBody = (await apiResponse.json()) as { operator: { id: string } };
      expect(apiBody.operator.id).toBe(fixture.operatorId);

      await page.goto("/operator");
      await expect(page.getByRole("heading", { name: "Bruno.Ai Operator" })).toBeVisible();
      await expect(page.getByText("Your Operator is ready.")).toBeVisible();
      await expect(page.getByText("Next step: Connect your Ready AI Connection")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Owner Preview" })).toBeVisible();
      await expect(page.getByText("Available now: OpenAI and Calendar reading.")).toBeVisible();
      await expect(page.getByText(/Core Operation/)).toHaveCount(0);
      await expect(page.getByText(/Support is fully attended/)).toBeVisible();
      await expect(page.getByText(/never promotes Bruno automatically/)).toBeVisible();

      const forbiddenTechnicalControl =
        /agent template|manage api keys?|connect telegram|numeric allowlist|cron expression|runner management|deployment configuration|view raw logs?|open terminal/i;
      await expect(
        page
          .getByRole("button", { name: forbiddenTechnicalControl })
          .or(page.getByRole("link", { name: forbiddenTechnicalControl })),
      ).toHaveCount(0);
      await expect(page.getByRole("heading", { name: forbiddenTechnicalControl })).toHaveCount(0);

      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).not.toBe(
        "body",
      );

      const accessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(accessibility.violations).toEqual([]);

      const externalBeta = await prepareFounderExternalBetaBrowserFixture(fixture, {
        runId: `${process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "browser"}:${test.info().project.name}`,
        applicationRevision: process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? "a".repeat(40),
        now: clock.now(),
      });
      const externalBetaResponse = await request.get("/api/operator/external-beta");
      expect(externalBetaResponse.status()).toBe(200);
      expect(externalBetaResponse.headers()["cache-control"]).toBe("no-store");
      await expect(externalBetaResponse.json()).resolves.toMatchObject({
        externalBeta: {
          state: "active",
          stage: "External Beta",
          accessExpiresAt: externalBeta.accessExpiresAt,
          retirementDueAt: externalBeta.retirementDueAt,
          workStoppedAt: null,
          payment: "Free, no card, no renewal, and no automatic paid conversion",
          support: "Self-serve onboarding and ordinary use, with reactive support",
          evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
          withdrawalAvailable: true,
          exportAvailable: true,
          deletionAvailable: true,
        },
      });
      await page.reload();
      const externalBetaStatus = page.getByRole("heading", { name: /remaining$/ }).locator("..");
      await expect(externalBetaStatus.getByText("External Beta", { exact: true })).toBeVisible();
      await expect(page.getByText(/Your exact access window ends/)).toBeVisible();
      await expect(page.getByText(/Free, no card, no renewal/)).toBeVisible();
      await expect(page.getByText(/Self-serve onboarding and ordinary use/)).toBeVisible();
      await expect(page.getByText(/Product-hardening only/)).toBeVisible();
      await expect(page.getByRole("link", { name: "Create Founder Data Export" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Request Bruno Data Deletion" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Withdraw from External Beta" })).toBeVisible();
      const externalBetaAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(externalBetaAccessibility.violations).toEqual([]);

      await page.route("**/api/identity-recovery", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            recovery: {
              state: "recovered",
              recoveredAt: clock.now().toISOString(),
              receipts: [
                { kind: "identity_loss_recorded", occurredAt: clock.now().toISOString() },
                { kind: "recovery_denied", occurredAt: clock.now().toISOString() },
                { kind: "identity_rebound", occurredAt: clock.now().toISOString() },
              ],
            },
          }),
        });
      });
      await page.goto("/identity-recovery");
      await expect(page.getByRole("heading", { name: "Identity Recovery receipts" })).toBeVisible();
      await expect(page.getByText("Identity loss recorded", { exact: false })).toBeVisible();
      await expect(page.getByText("Recovery attempt denied", { exact: false })).toBeVisible();
      await expect(
        page.getByText("Identity rebound to the same Owner", { exact: false }),
      ).toBeVisible();
      await expect(page.getByText("Account Closure stays separate")).toBeVisible();
      const identityRecoveryAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(identityRecoveryAccessibility.violations).toEqual([]);
      await page.unroute("**/api/identity-recovery");

      const resumedResponse = await request.get("/api/operator");
      const resumedBody = (await resumedResponse.json()) as { operator: { id: string } };
      expect(resumedBody.operator.id).toBe(fixture.operatorId);
      await page.goto("/operator");
      await expect(page.getByText("Your Operator is ready.")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(pageErrors).toEqual([]);
    });
  } finally {
    await deleteFounderProductContractFixture(fixture);
  }
});
