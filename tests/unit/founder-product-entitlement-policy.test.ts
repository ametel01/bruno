import { describe, expect, it } from "vitest";
import { founderEntitlementPolicy } from "@/src/server/founder-product-contract/entitlement";

const OCCURRED_AT = "2026-08-21T08:00:00.000Z";

describe("Founder Product Entitlement policy", () => {
  it.each([
    ["past_due", 7 * 24 * 60 * 60 * 1_000, false],
    ["unpaid", 24 * 60 * 60 * 1_000, true],
    ["expired", 60 * 60 * 1_000, true],
    ["refunded", 24 * 60 * 60 * 1_000, true],
  ] as const)("applies the required %s retirement deadline", (status, delay, stopNewWork) => {
    const policy = founderEntitlementPolicy({
      status,
      occurredAt: OCCURRED_AT,
      endsAt: null,
      currentRetirementDueAt: null,
    });

    expect(policy).toEqual({
      retirementDueAt: new Date(new Date(OCCURRED_AT).valueOf() + delay),
      stopNewWork,
    });
  });

  it("retains cancelled operation only through the paid ends_at boundary", () => {
    const endsAt = "2026-08-28T08:00:00.000Z";
    expect(
      founderEntitlementPolicy({
        status: "cancelled",
        occurredAt: OCCURRED_AT,
        endsAt,
        currentRetirementDueAt: null,
      }),
    ).toEqual({ retirementDueAt: new Date(endsAt), stopNewWork: false });
  });

  it("never extends an existing retirement clock", () => {
    const existing = new Date("2026-08-22T08:00:00.000Z");
    expect(
      founderEntitlementPolicy({
        status: "past_due",
        occurredAt: "2026-08-23T08:00:00.000Z",
        endsAt: null,
        currentRetirementDueAt: existing,
      }).retirementDueAt,
    ).toEqual(existing);
  });
});
