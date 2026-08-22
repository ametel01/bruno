import { describe, expect, it } from "vitest";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  createFounderProductContractProviderDoubles,
  providerFailure,
  runFounderProductContractPublicScenario,
  runFounderProductContractScenario,
  validateFounderProductContractScenarios,
} from "@/src/testing/founder-product-contract";
import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

describe("Founder Product Contract deterministic seam", () => {
  it("advances an injected clock without waiting on wall time", () => {
    const clock = createFounderProductContractClock("2026-08-20T00:00:00.000Z");

    const first = clock.now();
    first.setUTCDate(1);

    expect(clock.now().toISOString()).toBe("2026-08-20T00:00:00.000Z");
    expect(clock.advance(90_000).toISOString()).toBe("2026-08-20T00:01:30.000Z");
    expect(clock.set("2026-08-21T12:34:56.000Z").toISOString()).toBe("2026-08-21T12:34:56.000Z");
  });

  it("provides deterministic Clerk, commerce, runtime, AI, and Google boundaries", async () => {
    const clock = createFounderProductContractClock("2026-08-20T00:00:00.000Z");
    const providers = createFounderProductContractProviderDoubles({ clock });

    providers.clerk.setResponse("authenticate", { ok: true, value: { subject: "clerk-subject" } });
    providers.lemonSqueezy.setResponse("read_subscription", {
      ok: true,
      value: { status: "active" },
    });
    providers.digitalOcean.setResponse("observe_owned_resources", {
      ok: true,
      value: { droplet: "present", firewall: "present" },
    });
    providers.openai.setResponse("inference", { ok: true, value: { accepted: true } });
    providers.anthropic.setResponse("inference", { ok: true, value: { accepted: true } });
    providers.google.setResponse("send_mail", { ok: true, value: { messageId: "message-1" } });

    await expect(
      providers.clerk.request("authenticate", { session: "session-1" }),
    ).resolves.toEqual({ ok: true, value: { subject: "clerk-subject" } });
    await expect(
      providers.lemonSqueezy.request("read_subscription", { subscriptionId: "sub-1" }),
    ).resolves.toEqual({ ok: true, value: { status: "active" } });
    await expect(
      providers.digitalOcean.request("observe_owned_resources", { ownerId: "owner-1" }),
    ).resolves.toEqual({ ok: true, value: { droplet: "present", firewall: "present" } });
    await expect(providers.openai.request("inference", { prompt: "redacted" })).resolves.toEqual({
      ok: true,
      value: { accepted: true },
    });
    await expect(providers.anthropic.request("inference", { prompt: "redacted" })).resolves.toEqual(
      { ok: true, value: { accepted: true } },
    );
    await expect(
      providers.google.request("send_mail", { idempotencyKey: "effect-1" }),
    ).resolves.toEqual({ ok: true, value: { messageId: "message-1" } });

    expect(providers.google.calls).toEqual([
      {
        provider: "google",
        operation: "send_mail",
        input: { idempotencyKey: "effect-1" },
        at: "2026-08-20T00:00:00.000Z",
        idempotencyKey: null,
      },
    ]);

    providers.openai.setFailure("inference", providerFailure("provider_unavailable", true));
    await expect(providers.openai.request("inference")).resolves.toEqual({
      ok: false,
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("runs scenarios through the public application boundary", async () => {
    const requests: Array<{ method: string; path: string }> = [];
    let receivedClock: ReturnType<typeof createFounderProductContractClock> | undefined;
    const harness = createFounderProductContractHarness({
      application: {
        request: async ({ method, path }, context) => {
          requests.push({ method, path });
          receivedClock = context?.clock;
          return {
            status: 200,
            headers: { "cache-control": "no-store" },
            json: async () => ({ state: "persisted" }),
          };
        },
      },
    });

    await runFounderProductContractPublicScenario(harness, async ({ application, clock }) => {
      const response = await application.request({ method: "GET", path: "/api/operator" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "persisted" });
      clock.advance(60_000);
    });

    expect(requests).toEqual([{ method: "GET", path: "/api/operator" }]);
    expect(receivedClock).toBe(harness.clock);
    expect(harness.clock.now().toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("passes configured provider boundaries to the application adapter", async () => {
    const clock = createFounderProductContractClock();
    const providers = createFounderProductContractProviderDoubles({ clock });
    providers.clerk.setFailure("authenticate", providerFailure("provider_unavailable", true));
    let response: unknown;
    const harness = createFounderProductContractHarness({
      clock,
      providers,
      application: {
        request: async (_request, context) => {
          response = await context?.providers.clerk.request("authenticate");
          return { status: 200, headers: {}, json: async () => response };
        },
      },
    });

    await harness.application.request({ method: "GET", path: "/api/operator" });

    expect(response).toEqual({
      ok: false,
      code: "provider_unavailable",
      retryable: true,
    });
  });

  it("records exact-once scenarios and fails closed on missing, retry, stale, and mismatched results", async () => {
    const sourceRevision = "a".repeat(40);
    const clock = createFounderProductContractClock();
    const providers = createFounderProductContractProviderDoubles({ clock });
    const harness = createFounderProductContractHarness({
      sourceRevision,
      clock,
      providers,
      application: {
        request: async () => ({
          status: 200,
          headers: {},
          json: async () => ({ persisted: true }),
        }),
      },
    });

    for (const id of FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS) {
      await runFounderProductContractScenario(harness, id, async ({ application }) => {
        const response = await application.request({ method: "GET", path: "/api/operator" });
        expect(response.status).toBe(200);
        return {
          status: "passed",
          verified: true,
          resourcesBefore: 0,
          resourcesAfter: 0,
          observedAt: clock.now().toISOString(),
        };
      });
    }
    const firstResult = harness.scenarioResults[0];
    if (!firstResult) throw new Error("Expected a recorded scenario result.");

    validateFounderProductContractScenarios({
      required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
      results: harness.scenarioResults,
      sourceRevision,
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: harness.scenarioResults.slice(1),
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(
      "Required Founder Product Contract scenario release_stage_admission was not present.",
    );
    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: [
          {
            ...firstResult,
            attempts: 2,
          },
          ...harness.scenarioResults.slice(1),
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("was retried");
    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: [
          {
            ...firstResult,
            observedAt: "2025-12-31T00:00:00.000Z",
          },
          ...harness.scenarioResults.slice(1),
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("is stale");
    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: [
          {
            ...firstResult,
            cleanup: {
              ...firstResult.cleanup,
              observedAt: "2025-12-31T00:00:00.000Z",
            },
          },
          ...harness.scenarioResults.slice(1),
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("cleanup was stale");
    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: [
          {
            ...firstResult,
            sourceRevision: "b".repeat(40),
          },
          ...harness.scenarioResults.slice(1),
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("revision mismatch");

    validateFounderProductContractScenarios({
      required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
      results: harness.scenarioResults.map((result) => ({
        ...result,
        observedAt: "2026-01-01T00:00:00.001Z",
        cleanup: { ...result.cleanup, observedAt: "2026-01-01T00:00:00.001Z" },
      })),
      sourceRevision,
      observedAt: "2026-01-01T00:00:00.001Z",
    });

    expect(() =>
      validateFounderProductContractScenarios({
        required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
        results: harness.scenarioResults.map((result) => ({
          ...result,
          observedAt: "2026-01-01T00:00:00.001Z",
          cleanup: { ...result.cleanup, observedAt: "2026-01-01T00:00:00.001Z" },
        })),
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).not.toThrow();
  });
});
