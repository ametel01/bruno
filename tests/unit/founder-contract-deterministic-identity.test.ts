import { describe, expect, it } from "vitest";
import {
  createFounderContractIdentityHeaders,
  resolveFounderContractIdentity,
} from "@/src/server/founder-product-contract/deterministic-identity";

const ENV = {
  BRUNO_AUTH_MODE: "development",
  BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE: "deterministic",
  BRUNO_FOUNDER_CONTRACT_RUN_ID: "fpct-identity-envelope",
  BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: "a".repeat(40),
  BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: "s".repeat(64),
  NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3184",
};

describe("Founder Product Contract deterministic identity", () => {
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
});
