import { describe, expect, it } from "vitest";
import {
  assessFounderExternalBetaPromotionEvidence,
  FOUNDER_EXTERNAL_BETA_PROMOTION_EVIDENCE_SCHEMA,
} from "@/src/server/founder-product-contract/external-beta-promotion";

const APPLICATION_REVISION = "b".repeat(40);
const COHORT = "external-beta-378";
const START = new Date("2026-08-01T00:00:00.000Z");
const END = new Date("2026-08-15T00:00:00.000Z");

describe("External Beta promotion assessment", () => {
  it("requires five independent 14-day Founders and five recurring Lead-to-Client Loops", () => {
    const participants = roster(5);
    expect(
      assessFounderExternalBetaPromotionEvidence({
        value: evidence(participants),
        cohort: COHORT,
        applicationRevision: APPLICATION_REVISION,
        observedAt: END,
        participants,
      }),
    ).toMatchObject({
      promotionEligible: true,
      independentFounders: 5,
      recurringLeadToClientLoops: 5,
      classification: "product_hardening",
      founderAcceptanceEligible: false,
      automaticPromotion: false,
      extendCurrentCohort: false,
      newCohortRequired: false,
    });
  });

  it("holds a missed gate and requires a new cohort without extending participants", () => {
    const participants = roster(4);
    const assessment = assessFounderExternalBetaPromotionEvidence({
      value: evidence(participants),
      cohort: COHORT,
      applicationRevision: APPLICATION_REVISION,
      observedAt: END,
      participants,
    });
    expect(assessment).toMatchObject({
      promotionEligible: false,
      founderAcceptanceEligible: false,
      automaticPromotion: false,
      extendCurrentCohort: false,
      newCohortRequired: true,
    });
    expect(assessment.reasons).toContain("five_to_ten_independent_founders_required");
  });

  it("rejects coached use, reused evidence, and time short of the exact boundary", () => {
    const participants = roster(5);
    const value = evidence(participants);
    const [first, second] = value.participants;
    const firstLoop = first?.recurringLeadToClientLoops.at(0);
    const secondLoop = second?.recurringLeadToClientLoops.at(0);
    if (!first || !firstLoop || !secondLoop) throw new Error("Expected promotion fixtures.");
    first.attendedOperation = true;
    secondLoop.evidenceDigest = firstLoop.evidenceDigest;
    expect(
      assessFounderExternalBetaPromotionEvidence({
        value,
        cohort: COHORT,
        applicationRevision: APPLICATION_REVISION,
        observedAt: new Date(END.valueOf() - 1),
        participants,
      }),
    ).toMatchObject({
      promotionEligible: false,
      founderAcceptanceEligible: false,
      newCohortRequired: true,
    });
  });
});

function roster(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    userId: `00000000-0000-4000-8000-${(3780 + index).toString().padStart(12, "0")}`,
    operatorId: `00000000-0000-4000-8001-${(3780 + index).toString().padStart(12, "0")}`,
    admissionDecisionId: `00000000-0000-4000-8002-${(3780 + index).toString().padStart(12, "0")}`,
    admittedAt: START,
    accessExpiresAt: END,
    status: "expired",
    independenceEvidenceDigest: digest(100 + index),
  }));
}

function evidence(participants: ReturnType<typeof roster>) {
  return {
    schemaVersion: FOUNDER_EXTERNAL_BETA_PROMOTION_EVIDENCE_SCHEMA,
    stage: "external_beta",
    classification: "product_hardening",
    supportMode: "self_serve_reactive",
    applicationRevision: APPLICATION_REVISION,
    cohort: COHORT,
    participants: participants.map((participant, index) => ({
      userId: participant.userId,
      operatorId: participant.operatorId,
      admissionDecisionId: participant.admissionDecisionId,
      independentFounder: true,
      independenceEvidenceDigest: participant.independenceEvidenceDigest,
      selfServeOrdinaryUse: true,
      attendedOperation: false,
      recurringLeadToClientLoops: [
        {
          loopId: `lead-to-client-${index + 1}`,
          completedCycles: 2,
          evidenceDigest: digest(index + 1),
        },
      ],
    })),
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
