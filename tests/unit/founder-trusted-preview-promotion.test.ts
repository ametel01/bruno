import { describe, expect, it } from "vitest";
import {
  assessFounderTrustedPreviewPromotionEvidence,
  FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
} from "@/src/server/founder-product-contract/trusted-preview-promotion";

const APPLICATION_REVISION = "7".repeat(40);
const OBSERVED_AT = new Date("2026-08-23T12:00:00.000Z");
const PARTICIPANTS = [1, 2, 3].map((index) => ({
  userId: `00000000-0000-4000-8000-00000000376${index}`,
  operatorId: `00000000-0000-4000-8000-00000000377${index}`,
  activeDecisionId: `00000000-0000-4000-8000-00000000378${index}`,
  admittedAt: new Date(`2026-08-2${index}T00:00:00.000Z`),
}));

describe("Trusted Preview promotion evidence", () => {
  it("requires two attended participants to complete all five journeys", () => {
    expect(
      assessFounderTrustedPreviewPromotionEvidence({
        value: evidence([1, 2]),
        admittedParticipants: PARTICIPANTS,
        applicationRevision: APPLICATION_REVISION,
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      stage: "trusted_preview",
      classification: "learning_round",
      promotionEligible: true,
      founderAcceptanceEligible: false,
      automaticPromotion: false,
      completedParticipants: 2,
      reasons: [],
    });
  });

  it("rejects one participant, missing journeys, unresolved findings, and evidence reuse", () => {
    const incomplete = evidence([1]);
    incomplete.unresolvedCriticalFailures = 1;
    const participant = incomplete.participants[0];
    if (!participant) throw new Error("Expected participant evidence.");
    delete (participant.journeys as Partial<typeof participant.journeys>).privacy;

    expect(
      assessFounderTrustedPreviewPromotionEvidence({
        value: incomplete,
        admittedParticipants: PARTICIPANTS,
        applicationRevision: APPLICATION_REVISION,
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      promotionEligible: false,
      founderAcceptanceEligible: false,
      completedParticipants: 0,
      reasons: expect.arrayContaining([
        "privacy_required",
        "two_completed_participants_required",
        "unresolved_release_blocker",
      ]),
    });

    const reused = evidence([1, 2]);
    const first = reused.participants[0]?.journeys.activation;
    if (!first || !reused.participants[1]) throw new Error("Expected journey evidence.");
    reused.participants[1].journeys.activation = {
      ...reused.participants[1].journeys.activation,
      evidenceDigest: first.evidenceDigest,
    };
    expect(
      assessFounderTrustedPreviewPromotionEvidence({
        value: reused,
        admittedParticipants: PARTICIPANTS,
        applicationRevision: APPLICATION_REVISION,
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({ promotionEligible: false, reasons: ["evidence_reuse_forbidden"] });
  });

  it("never accepts self-serve or Founder Acceptance reclassification", () => {
    expect(
      assessFounderTrustedPreviewPromotionEvidence({
        value: { ...evidence([1, 2]), supportMode: "self_serve" },
        admittedParticipants: PARTICIPANTS,
        applicationRevision: APPLICATION_REVISION,
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({ promotionEligible: false, reasons: ["classification_invalid"] });
    expect(
      assessFounderTrustedPreviewPromotionEvidence({
        value: { ...evidence([1, 2]), classification: "founder_acceptance" },
        admittedParticipants: PARTICIPANTS,
        applicationRevision: APPLICATION_REVISION,
        observedAt: OBSERVED_AT,
      }),
    ).toMatchObject({
      promotionEligible: false,
      founderAcceptanceEligible: false,
      reasons: ["classification_invalid"],
    });
  });
});

function evidence(indices: readonly number[]) {
  return {
    schemaVersion: FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
    stage: "trusted_preview",
    classification: "learning_round",
    supportMode: "attended",
    applicationRevision: APPLICATION_REVISION,
    participants: indices.map((index) => {
      const admission = PARTICIPANTS[index - 1];
      if (!admission) throw new Error("Unknown participant.");
      return {
        userId: admission.userId,
        operatorId: admission.operatorId,
        activeDecisionId: admission.activeDecisionId,
        attendedObservation: true,
        journeys: Object.fromEntries(
          ["activation", "recurring_use", "authority", "recovery", "privacy"].map(
            (journey, journeyIndex) => [
              journey,
              {
                occurredAt: new Date(
                  admission.admittedAt.valueOf() + (journeyIndex + 1) * 1_000,
                ).toISOString(),
                evidenceDigest: digest(index * 10 + journeyIndex),
              },
            ],
          ),
        ) as Record<
          "activation" | "recurring_use" | "authority" | "recovery" | "privacy",
          { occurredAt: string; evidenceDigest: `sha256:${string}` }
        >,
      };
    }),
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
