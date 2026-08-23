import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { createFounderProductContractClock } from "@/src/testing/founder-product-contract";
import {
  createFounderProductContractFixture,
  deleteFounderProductContractFixture,
  founderContractIdentityHeaders,
  prepareFounderExternalBetaBrowserFixture,
  prepareFounderIdentityRecoveryBrowserPreconditions,
  sendFounderIdentityLossWebhook,
  withPinnedFounderDevelopmentUser,
} from "./founder-product-contract-fixture";

test("Operator UI remains usable across the required browser matrix", async ({ page, request }) => {
  const clock = createFounderProductContractClock(
    process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT ?? new Date().toISOString(),
  );
  const fixture = await createFounderProductContractFixture(clock);
  const pageErrors: string[] = [];
  const connectionGets: string[] = [];
  const connectionPosts: unknown[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (outgoingRequest) => {
    const outgoingUrl = new URL(outgoingRequest.url());
    if (
      outgoingRequest.method() === "GET" &&
      outgoingUrl.pathname === "/api/operator/connections"
    ) {
      connectionGets.push(outgoingUrl.searchParams.get("provider") ?? "");
    }
    if (
      outgoingRequest.method() === "POST" &&
      outgoingUrl.pathname === "/api/operator/connections"
    ) {
      connectionPosts.push(outgoingRequest.postDataJSON());
    }
  });

  try {
    await withPinnedFounderDevelopmentUser(fixture.userId, async () => {
      const apiResponse = await request.get("/api/operator");
      expect(apiResponse.status()).toBe(200);
      expect(apiResponse.headers()["cache-control"]).toBe("no-store");
      const apiBody = (await apiResponse.json()) as { operator: { id: string } };
      expect(apiBody.operator.id).toBe(fixture.operatorId);
      const eligibility = await request.post("/api/operator/general-release", {
        data: {
          action: "confirm_eligibility",
          serviceBusinessConfirmed: true,
          geographyCode: "PH",
        },
      });
      expect(eligibility.status()).toBe(200);

      await page.goto("/operator");
      await expect(page.getByRole("heading", { name: "Bruno.Ai Operator" })).toBeVisible();
      await expect(page.getByText("Your Operator is ready.")).toBeVisible();
      await expect(page.getByText("Next step: Confirm Processing Consent")).toBeVisible();
      const ownerPreview = page.getByRole("region", { name: "Owner Preview" });
      await expect(ownerPreview.getByRole("heading", { name: "Owner Preview" })).toBeVisible();
      await expect(
        ownerPreview.getByText("Available now: OpenAI and Calendar reading."),
      ).toBeVisible();
      await expect(ownerPreview.getByText(/Gmail|Anthropic|Core Operation/)).toHaveCount(0);
      await expect(page.getByText(/Support is fully attended/)).toBeVisible();
      await expect(page.getByText(/never promotes Bruno automatically/)).toBeVisible();
      await expect(page.getByRole("heading", { name: "OpenAI is ready" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Connect Anthropic" })).toBeVisible();
      expect(connectionGets).toEqual(expect.arrayContaining(["openai", "anthropic"]));

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

      await page.getByRole("button", { name: "Connect Anthropic" }).click();
      await expect
        .poll(() => connectionPosts)
        .toEqual(expect.arrayContaining([{ action: "start", provider: "anthropic" }]));

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
      const initialPrivacyResponse = await request.get("/api/operator/external-beta/privacy");
      expect(initialPrivacyResponse.status()).toBe(200);
      await expect(initialPrivacyResponse.json()).resolves.toMatchObject({
        privacy: {
          state: "available",
          collection: { autocapture: false, sessionReplay: false, personProfiles: false },
          consent: { measurement: "not_granted", recording: "not_granted" },
          recordingRetentionDays: 30,
          accessUnaffectedByRefusal: true,
          evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
        },
      });
      const refusal = await request.post("/api/operator/external-beta/privacy", {
        data: { action: "decide_consent", purpose: "recording", decision: "refuse" },
      });
      expect(refusal.status()).toBe(200);
      await expect(
        request.get("/api/operator/external-beta").then((response) => response.json()),
      ).resolves.toMatchObject({
        externalBeta: { state: "active", withdrawalAvailable: true },
      });
      await page.reload();
      const externalBetaStatus = page.getByRole("heading", { name: /remaining$/ }).locator("..");
      await expect(externalBetaStatus.getByText("External Beta", { exact: true })).toBeVisible();
      await expect(page.getByText(/Your exact access window ends/)).toBeVisible();
      await expect(page.getByText(/Free, no card, no renewal/)).toBeVisible();
      await expect(page.getByText(/Self-serve onboarding and ordinary use/)).toBeVisible();
      await expect(page.getByText(/Product-hardening only/).first()).toBeVisible();
      await expect(page.getByRole("link", { name: "Create Founder Data Export" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Request Bruno Data Deletion" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Withdraw from External Beta" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "External Beta privacy" })).toBeVisible();
      await expect(page.getByText(/Nothing is measured until you opt in/)).toBeVisible();
      await expect(page.getByText(/Message bodies/)).toBeVisible();
      await expect(page.getByText(/deleted within 30 days/)).toBeVisible();
      await expect(page.getByText(/never reduces your 14-day access/)).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Export External Beta privacy data" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Delete External Beta measurements" }),
      ).toBeVisible();
      const externalBetaAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(externalBetaAccessibility.violations).toEqual([]);

      const runId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "browser";
      const browserRunId = `${runId}:${test.info().project.name}`;
      await prepareFounderIdentityRecoveryBrowserPreconditions(fixture, {
        runId: browserRunId,
        providerRunId: runId,
        now: clock.now(),
      });
      const currentSubject = `clerk:${fixture.userId}`;
      const currentIdentityHeaders = founderContractIdentityHeaders(currentSubject);
      await page.setExtraHTTPHeaders(currentIdentityHeaders);
      await page.goto("/operator/privacy");
      const credentialResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/operator/identity-recovery") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Create Identity Recovery code" }).click();
      expect((await credentialResponse).status()).toBe(200);
      const recoveryCode =
        (
          await page
            .locator("code")
            .filter({ hasText: /^bruno_recovery_/ })
            .textContent()
        )?.trim() ?? "";
      expect(recoveryCode.length).toBeGreaterThan(20);

      await sendFounderIdentityLossWebhook(request, {
        subject: currentSubject,
        eventId: `browser:${browserRunId}:clerk-user-deleted`,
      });
      expect((await request.get("/api/operator/privacy")).status()).toBe(401);
      expect(
        (await request.get("/api/operator/privacy", { headers: currentIdentityHeaders })).status(),
      ).toBe(401);
      expect(
        (
          await request.get("/api/operator/privacy", {
            headers: {
              ...currentIdentityHeaders,
              "x-bruno-founder-contract-clerk-signature": "0".repeat(64),
            },
          })
        ).status(),
      ).toBe(401);

      const attackerSubject = `clerk:attacker:${fixture.userId}`;
      await page.setExtraHTTPHeaders(founderContractIdentityHeaders(attackerSubject));
      await page.goto("/identity-recovery");
      const wrongCode = `${recoveryCode.slice(0, -1)}${recoveryCode.endsWith("x") ? "y" : "x"}`;
      await page.getByLabel("Identity Recovery code").fill(wrongCode);
      const deniedResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/identity-recovery") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Recover my Founder workspace" }).click();
      expect((await deniedResponse).status()).toBe(403);
      await expect(
        page.getByRole("alert").filter({ hasText: "Recovery was denied" }),
      ).toBeVisible();

      const replacementSubject = `clerk:recovered:${fixture.userId}`;
      const replacementIdentityHeaders = founderContractIdentityHeaders(replacementSubject);
      await page.setExtraHTTPHeaders(replacementIdentityHeaders);
      await page.getByLabel("Identity Recovery code").fill(recoveryCode);
      const recoveredResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/identity-recovery") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Recover my Founder workspace" }).click();
      expect((await recoveredResponse).status()).toBe(200);
      await expect(page.getByText("Identity recovered.", { exact: false })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Identity Recovery receipts" })).toBeVisible();
      await expect(page.getByText("Identity loss recorded", { exact: false })).toBeVisible();
      await expect(page.getByText("Recovery attempt denied", { exact: false })).toBeVisible();
      await expect(
        page.getByText("Identity rebound to the same Owner", { exact: false }),
      ).toBeVisible();

      await page.goto("/operator/privacy");
      await expect(page.getByText("Identity Recovery receipts")).toBeVisible();
      page.once("dialog", (dialog) => dialog.accept());
      const closureResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/operator/privacy") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Request Account Closure" }).click();
      expect((await closureResponse).status()).toBe(200);
      await expect(page.getByRole("heading", { name: /Account Closure Receipt/ })).toBeVisible();
      await expect(page.getByText("Commerce cancellation", { exact: true })).toBeVisible();
      await expect(page.getByText(/Lemon Squeezy subscription: succeeded/)).toBeVisible();
      await expect(page.getByText(/Refund started: no/)).toBeVisible();
      await expect(page.getByText("Provider revocation", { exact: true })).toBeVisible();
      await expect(page.getByText(/calendar: succeeded/)).toBeVisible();
      await expect(page.getByText("Identity Recovery receipts")).toBeVisible();
      await expect(page.getByText("Identity loss recorded", { exact: false })).toBeVisible();
      await expect(page.getByText("Recovery attempt denied", { exact: false })).toBeVisible();
      await expect(
        page.getByText("Identity rebound to the same Owner", { exact: false }),
      ).toBeVisible();
      const identityRecoveryAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      expect(identityRecoveryAccessibility.violations).toEqual([]);
      await page.waitForLoadState("networkidle");
      expect(pageErrors).toEqual([]);
    });
  } finally {
    await deleteFounderProductContractFixture(fixture);
  }
});
