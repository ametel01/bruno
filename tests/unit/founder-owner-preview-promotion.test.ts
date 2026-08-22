import { describe, expect, it } from "vitest";
import {
  assessFounderOwnerPreviewPromotionEvidenceAgainstDecision,
  FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
} from "@/src/server/founder-product-contract/owner-preview-promotion";

const OWNER_ID = "00000000-0000-4000-8000-000000003750";
const OPERATOR_ID = "00000000-0000-4000-8000-000000003751";
const APPLICATION_REVISION = "a".repeat(40);
const RUNTIME_REVISION = "owner-preview-runtime-v1";
const OBSERVED_AT = new Date("2026-08-08T00:00:00.000Z");
const ACTIVE_PERIOD_STARTED_AT = new Date("2026-08-01T00:00:00.000Z");
const ACTIVE_DECISION_ID = "00000000-0000-4000-8000-000000003752";

describe("Owner Preview promotion evidence", () => {
  it("keeps a complete seven-day Owner journey classified only as a Learning Round", () => {
    const assessment = assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
      value: evidence(),
      ownerUserId: OWNER_ID,
      operatorId: OPERATOR_ID,
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: RUNTIME_REVISION,
      activeDecisionId: ACTIVE_DECISION_ID,
      activePeriodStartedAt: ACTIVE_PERIOD_STARTED_AT,
      observedAt: OBSERVED_AT,
    });

    expect(assessment).toMatchObject({
      stage: "owner_preview",
      classification: "learning_round",
      promotionEligible: true,
      founderAcceptanceEligible: false,
      automaticPromotion: false,
      reasons: [],
    });
    expect(assessment.evidenceDigests).toHaveLength(14);
  });

  it("denies incomplete, nonconsecutive, mismatched, or reclassified evidence", () => {
    const incomplete = evidence();
    incomplete.dailyBriefs.splice(3, 1);
    incomplete.unresolvedReleaseBlockers = 1;
    delete incomplete.journeys.provider_disconnect;
    expect(assess(incomplete)).toMatchObject({
      promotionEligible: false,
      automaticPromotion: false,
      reasons: expect.arrayContaining([
        "seven_consecutive_daily_briefs_required",
        "provider_disconnect_required",
        "unresolved_release_blocker",
      ]),
    });

    expect(assess({ ...evidence(), runtimeRevision: "different-runtime" })).toMatchObject({
      promotionEligible: false,
      reasons: ["candidate_mismatch"],
    });
    expect(assess({ ...evidence(), classification: "founder_acceptance" })).toMatchObject({
      promotionEligible: false,
      founderAcceptanceEligible: false,
      reasons: ["classification_invalid"],
    });
  });

  it("does not let one digest stand in for multiple required journeys", () => {
    const duplicated = evidence();
    const desktopActivation = duplicated.journeys.desktop_activation;
    if (!desktopActivation) throw new Error("Expected desktop activation evidence.");
    duplicated.journeys.phone_activation = desktopActivation;

    expect(assess(duplicated)).toMatchObject({
      promotionEligible: false,
      evidenceDigests: [],
      reasons: ["evidence_reuse_forbidden"],
    });
  });

  it("accepts a seven-day consecutive run inside a longer evidence window", () => {
    const extended = evidence();
    extended.dailyBriefs.unshift({
      day: "2026-07-30",
      occurredAt: "2026-07-30T12:00:00.000Z",
      evidenceDigest: digest(15),
    });

    expect(
      assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
        value: extended,
        ownerUserId: OWNER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: RUNTIME_REVISION,
        activeDecisionId: ACTIVE_DECISION_ID,
        activePeriodStartedAt: new Date("2026-07-30T00:00:00.000Z"),
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      promotionEligible: true,
      automaticPromotion: false,
      reasons: [],
    });
  });

  it("rejects evidence that predates the latest uninterrupted Owner Preview period", () => {
    expect(
      assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
        value: evidence(),
        ownerUserId: OWNER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: RUNTIME_REVISION,
        activeDecisionId: ACTIVE_DECISION_ID,
        activePeriodStartedAt: new Date("2026-08-03T00:00:00.000Z"),
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      promotionEligible: false,
      reasons: expect.arrayContaining(["active_owner_preview_period_required"]),
    });
  });

  it("rejects journey evidence captured before the active admission", () => {
    const staleJourney = evidence();
    staleJourney.journeys.desktop_activation = {
      occurredAt: new Date(ACTIVE_PERIOD_STARTED_AT.valueOf() - 1).toISOString(),
      evidenceDigest: digest(8),
    };

    expect(assess(staleJourney)).toMatchObject({
      promotionEligible: false,
      reasons: ["desktop_activation_required"],
    });
  });

  it("rejects a same-day daily brief captured before the active admission", () => {
    const staleBrief = evidence();
    staleBrief.dailyBriefs[0] = {
      day: "2026-08-01",
      occurredAt: "2026-08-01T08:00:00.000Z",
      evidenceDigest: digest(1),
    };

    expect(
      assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
        value: staleBrief,
        ownerUserId: OWNER_ID,
        operatorId: OPERATOR_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: RUNTIME_REVISION,
        activeDecisionId: ACTIVE_DECISION_ID,
        activePeriodStartedAt: new Date("2026-08-01T12:00:00.000Z"),
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      promotionEligible: false,
      reasons: expect.arrayContaining([
        "active_owner_preview_period_required",
        "seven_consecutive_daily_briefs_required",
      ]),
    });
  });
});

function assess(value: unknown) {
  return assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
    value,
    ownerUserId: OWNER_ID,
    operatorId: OPERATOR_ID,
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: RUNTIME_REVISION,
    activeDecisionId: ACTIVE_DECISION_ID,
    activePeriodStartedAt: ACTIVE_PERIOD_STARTED_AT,
    observedAt: OBSERVED_AT,
  });
}

function evidence() {
  const journeyNames = [
    "desktop_activation",
    "phone_activation",
    "interruption_recovery",
    "provider_reauthorization",
    "provider_disconnect",
    "founder_data_export",
    "bruno_data_deletion",
  ] as const;
  return {
    schemaVersion: FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
    stage: "owner_preview",
    classification: "learning_round",
    ownerUserId: OWNER_ID,
    operatorId: OPERATOR_ID,
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: RUNTIME_REVISION,
    activeDecisionId: ACTIVE_DECISION_ID,
    dailyBriefs: Array.from({ length: 7 }, (_, index) => ({
      day: `2026-08-${String(index + 1).padStart(2, "0")}`,
      occurredAt: new Date(Date.UTC(2026, 7, index + 1, 12)).toISOString(),
      evidenceDigest: digest(index + 1),
    })),
    journeys: Object.fromEntries(
      journeyNames.map((journey, index) => [
        journey,
        {
          occurredAt: new Date(
            ACTIVE_PERIOD_STARTED_AT.valueOf() + (index + 1) * 1_000,
          ).toISOString(),
          evidenceDigest: digest(index + 8),
        },
      ]),
    ) as Partial<
      Record<
        (typeof journeyNames)[number],
        { occurredAt: string; evidenceDigest: `sha256:${string}` }
      >
    >,
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
