import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFounderContractIdentityHeaders,
  resolveFounderContractIdentity,
} from "@/src/server/founder-product-contract/deterministic-identity";
import {
  cancelDeterministicFounderContractSubscription,
  deterministicFounderLifecycleProviders,
  deterministicFounderContractGoogleConnectionRevoked,
  revokeDeterministicFounderContractGoogleConnection,
} from "@/src/server/founder-product-contract/deterministic-providers";

const ENV = {
  BRUNO_AUTH_MODE: "development",
  BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE: "deterministic",
  BRUNO_FOUNDER_CONTRACT_RUN_ID: "fpct-identity-envelope",
  BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: "a".repeat(40),
  BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: "s".repeat(64),
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3184",
};

describe("Founder Product Contract deterministic identity", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a short-lived signed opaque subject for the exact local run", () => {
    const headers = new Headers(createFounderContractIdentityHeaders("clerk:replacement", ENV));
    expect(resolveFounderContractIdentity(headers, ENV)).toEqual({
      present: true,
      valid: true,
      subject: "clerk:replacement",
    });
  });

  it("fails closed on tampering, expiry, non-loopback, Clerk mode, or Vercel", () => {
    const valid = createFounderContractIdentityHeaders("clerk:replacement", ENV);
    expect(
      resolveFounderContractIdentity(
        new Headers({ ...valid, "x-bruno-founder-contract-clerk-signature": "0".repeat(64) }),
        ENV,
      ),
    ).toEqual({ present: true, valid: false });

    const expired = createFounderContractIdentityHeaders(
      "clerk:replacement",
      ENV,
      new Date(Date.now() - 6 * 60 * 1_000),
    );
    expect(resolveFounderContractIdentity(new Headers(expired), ENV)).toEqual({
      present: true,
      valid: false,
    });

    for (const environment of [
      { ...ENV, NEXT_PUBLIC_APP_URL: "https://preview.example.com" },
      { ...ENV, BRUNO_AUTH_MODE: "clerk" },
      { ...ENV, VERCEL_ENV: "preview" },
    ]) {
      expect(resolveFounderContractIdentity(new Headers(valid), environment)).toEqual({
        present: true,
        valid: false,
      });
    }
  });

  it("does not treat an ordinary request as a deterministic identity", () => {
    expect(resolveFounderContractIdentity(new Headers(), ENV)).toEqual({ present: false });
  });

  it("accepts only the exact run, Owner, kind, and decrypted deterministic Google grant", async () => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    const userId = "00000000-0000-4000-8000-000000000384";
    deterministicFounderLifecycleProviders({
      runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
      userId,
      now: new Date("2026-08-23T00:00:00.000Z"),
      failures: [],
      subscriptionStatus: "active",
    });
    await expect(
      revokeDeterministicFounderContractGoogleConnection({
        runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
        userId,
        connectionKind: "calendar",
        token: "wrong-decrypted-token",
      }),
    ).rejects.toThrow("Deterministic Founder connection revocation is unavailable.");
    expect(
      deterministicFounderContractGoogleConnectionRevoked({
        runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
        userId,
        connectionKind: "calendar",
      }),
    ).toBe(false);

    await expect(
      revokeDeterministicFounderContractGoogleConnection({
        runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
        userId,
        connectionKind: "calendar",
        token: `founder-contract-google:${ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID}:${userId}:calendar:refresh`,
      }),
    ).resolves.toEqual({ providerRevoked: true });
  });

  it("cancels only the exact provider subscription bound to the contract run", async () => {
    for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
    const userId = "00000000-0000-4000-8000-000000000385";
    const providers = deterministicFounderLifecycleProviders({
      runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
      userId,
      now: new Date("2026-08-23T00:00:00.000Z"),
      failures: [],
      subscriptionStatus: "active",
    });
    const expectedSubscriptionId = `${ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID}:subscription`;

    await expect(
      cancelDeterministicFounderContractSubscription({
        runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
        userId,
        subscriptionId: `${ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID}:different-subscription`,
      }),
    ).rejects.toThrow("Deterministic Founder commerce cancellation is unavailable.");
    await expect(
      providers.readSubscription({ subscriptionId: expectedSubscriptionId }),
    ).resolves.toEqual({ status: "active" });

    await expect(
      cancelDeterministicFounderContractSubscription({
        runId: ENV.BRUNO_FOUNDER_CONTRACT_RUN_ID,
        userId,
        subscriptionId: expectedSubscriptionId,
      }),
    ).resolves.toBeUndefined();
    await expect(
      providers.readSubscription({ subscriptionId: expectedSubscriptionId }),
    ).resolves.toEqual({ status: "cancelled" });
  });
});
