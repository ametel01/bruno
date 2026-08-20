import { describe, expect, it } from "vitest";
import {
  createFounderProductContractClock,
  createFounderProductContractHarness,
  createFounderProductContractProviderDoubles,
  providerFailure,
  runRecordedFounderProductContractScenario,
  runFounderProductContractScenario,
  validateFounderProductContractScenarios,
} from "@/src/testing/founder-product-contract";

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
    const harness = createFounderProductContractHarness({
      application: {
        request: async ({ method, path }) => {
          requests.push({ method, path });
          return {
            status: 200,
            headers: { "cache-control": "no-store" },
            json: async () => ({ state: "persisted" }),
          };
        },
      },
    });

    await runFounderProductContractScenario(harness, async ({ application, clock }) => {
      const response = await application.request({ method: "GET", path: "/api/operator" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ state: "persisted" });
      clock.advance(60_000);
    });

    expect(requests).toEqual([{ method: "GET", path: "/api/operator" }]);
    expect(harness.clock.now().toISOString()).toBe("2026-01-01T00:01:00.000Z");
  });

  it("records exact-once scenarios and fails closed on missing, retry, stale, and mismatched results", async () => {
    const sourceRevision = "a".repeat(40);
    const harness = createFounderProductContractHarness({
      sourceRevision,
      application: { request: async () => ({ status: 204, headers: {}, json: async () => null }) },
    });

    await runFounderProductContractScenario(harness, "release_stage_admission", () => {});
    await runRecordedFounderProductContractScenario(
      harness,
      "product_entitlement_lifecycle",
      () => {},
    );
    await runRecordedFounderProductContractScenario(
      harness,
      "recovery_archive_lifecycle",
      () => {},
    );
    await runRecordedFounderProductContractScenario(harness, "infrastructure_retirement", () => {});
    const firstResult = harness.scenarioResults[0];
    if (!firstResult) throw new Error("Expected a recorded scenario result.");

    validateFounderProductContractScenarios({
      required: [
        "release_stage_admission",
        "product_entitlement_lifecycle",
        "recovery_archive_lifecycle",
        "infrastructure_retirement",
      ],
      results: harness.scenarioResults,
      sourceRevision,
      observedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(() =>
      validateFounderProductContractScenarios({
        required: ["missing"],
        results: harness.scenarioResults,
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("Required Founder Product Contract scenario missing was not present.");
    expect(() =>
      validateFounderProductContractScenarios({
        required: ["release_stage_admission"],
        results: [
          {
            ...firstResult,
            attempts: 2,
          },
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("was retried");
    expect(() =>
      validateFounderProductContractScenarios({
        required: ["release_stage_admission"],
        results: [
          {
            ...firstResult,
            observedAt: "2025-12-31T23:59:59.000Z",
          },
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("is stale");
    expect(() =>
      validateFounderProductContractScenarios({
        required: ["release_stage_admission"],
        results: [
          {
            ...firstResult,
            sourceRevision: "b".repeat(40),
          },
        ],
        sourceRevision,
        observedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow("revision mismatch");
  });
});
