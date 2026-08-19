import { describe, expect, it } from "vitest";
import {
  deriveFounderConnectionRecovery,
  deriveFounderConversationRecovery,
  deriveFounderRecovery,
  FOUNDER_RECOVERY_BUDGETS,
} from "@/src/server/operators/founder-recovery";

const START = new Date("2026-08-20T00:00:00.000Z");

describe("Founder bounded recovery", () => {
  it("uses one explicit budget per capability", () => {
    expect(Object.keys(FOUNDER_RECOVERY_BUDGETS)).toEqual([
      "ai",
      "calendar",
      "mail",
      "mail_sending",
      "brief",
      "conversation",
      "external_effect",
    ]);
    expect(FOUNDER_RECOVERY_BUDGETS.external_effect.maxAttempts).toBe(1);
  });

  it.each([
    "ai",
    "calendar",
    "mail",
    "mail_sending",
    "brief",
    "conversation",
    "external_effect",
  ] as const)("bounds injected durable failure recovery for %s", (capability) => {
    const budget = FOUNDER_RECOVERY_BUDGETS[capability];
    expect(
      deriveFounderRecovery({
        capability,
        now: START,
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
        safeToRetry: true,
      }),
    ).toMatchObject({
      capability,
      state: budget.maxAttempts === 1 ? "recovery_exhausted" : "recovering",
    });
    expect(
      deriveFounderRecovery({
        capability,
        now: START,
        startedAt: START,
        attemptCount: budget.maxAttempts,
        durableFailure: true,
        safeToRetry: true,
      }),
    ).toMatchObject({ capability, state: "recovery_exhausted" });
  });

  it("returns Recovering while durable work remains safe and within budget", () => {
    expect(
      deriveFounderRecovery({
        capability: "conversation",
        now: new Date(START.getTime() + 30_000),
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
        safeToRetry: true,
        message: "The provider did not answer yet.",
      }),
    ).toMatchObject({
      state: "recovering",
      attemptCount: 1,
      maxAttempts: 3,
      action: null,
    });
  });

  it("waits on a provider without presenting a retry action", () => {
    expect(
      deriveFounderRecovery({
        capability: "calendar",
        now: new Date(START.getTime() + 30_000),
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
        waitingOnProvider: true,
        message: "Calendar evidence is temporarily unavailable.",
      }),
    ).toMatchObject({ state: "waiting_on_provider", action: null });
    expect(
      deriveFounderRecovery({
        capability: "external_effect",
        now: START,
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
        waitingOnProvider: true,
        safeToRetry: false,
      }),
    ).toMatchObject({ state: "waiting_on_provider", action: null });
  });

  it("gives Needs you exactly one plain action", () => {
    expect(
      deriveFounderRecovery({
        capability: "mail",
        startedAt: START,
        now: START,
        durableFailure: true,
        needsFounder: true,
        message: "Choose the labels Bruno may read.",
      }),
    ).toMatchObject({
      state: "needs_you",
      action: { label: "Review Mail access", href: "/operator#mail" },
    });
  });

  it("never turns a transient browser-only failure into exhaustion", () => {
    expect(
      deriveFounderRecovery({
        capability: "ai",
        now: new Date(START.getTime() + 2 * 60 * 60 * 1000),
        startedAt: START,
        attemptCount: 100,
        durableFailure: false,
      }),
    ).toBeNull();
  });

  it("derives exhaustion from durable attempts or elapsed time", () => {
    expect(
      deriveFounderRecovery({
        capability: "ai",
        now: new Date(START.getTime() + 30_000),
        startedAt: START,
        attemptCount: 3,
        durableFailure: true,
        safeToRetry: true,
      }),
    ).toMatchObject({ state: "recovery_exhausted", action: null });
    expect(
      deriveFounderRecovery({
        capability: "brief",
        now: new Date(START.getTime() + 16 * 60 * 1000),
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
      }),
    ).toMatchObject({ state: "recovery_exhausted" });
  });

  it("preserves an uncertain external effect as terminal and actionless", () => {
    expect(
      deriveFounderRecovery({
        capability: "external_effect",
        now: START,
        startedAt: START,
        attemptCount: 1,
        durableFailure: true,
        outcomeUncertain: true,
        needsFounder: true,
        action: { label: "Retry", href: null },
      }),
    ).toMatchObject({ state: "outcome_uncertain", action: null });
  });

  it("does not misclassify completed conversation work with a started effect", () => {
    expect(
      deriveFounderConversationRecovery({
        state: "running",
        externalEffectStarted: false,
        startedAt: START,
        now: START,
      }),
    ).toBeNull();
    expect(
      deriveFounderConversationRecovery({
        state: "completed",
        externalEffectStarted: true,
        startedAt: START,
        attemptCount: 1,
        now: START,
      }),
    ).toBeNull();
    expect(
      deriveFounderConversationRecovery({
        state: "paused",
        externalEffectStarted: true,
        startedAt: START,
        attemptCount: 1,
        now: START,
      }),
    ).toMatchObject({ state: "outcome_uncertain", action: null });
  });

  it("maps local connection statuses to the shared vocabulary", () => {
    expect(
      deriveFounderConnectionRecovery({
        capability: "calendar",
        status: "selecting",
        createdAt: new Date("2020-01-01T00:00:00.000Z"),
        updatedAt: START,
        now: START,
      }),
    ).toMatchObject({ state: "needs_you", action: { label: "Review Calendar access" } });
    expect(
      deriveFounderConnectionRecovery({
        capability: "mail",
        status: "verifying",
        createdAt: START,
        updatedAt: START,
      }),
    ).toMatchObject({ state: "waiting_on_provider", action: null });
  });
});
