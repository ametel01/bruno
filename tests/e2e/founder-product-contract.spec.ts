import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createFounderProductContractClock } from "@/src/testing/founder-product-contract";
import {
  createFounderProductContractFixture,
  deleteFounderProductContractFixture,
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

      await page.reload();
      const resumedResponse = await request.get("/api/operator");
      const resumedBody = (await resumedResponse.json()) as { operator: { id: string } };
      expect(resumedBody.operator.id).toBe(fixture.operatorId);
      await expect(page.getByText("Your Operator is ready.")).toBeVisible();
      await page.waitForLoadState("networkidle");
      expect(pageErrors).toEqual([]);
    });
  } finally {
    await deleteFounderProductContractFixture(fixture);
  }
});
