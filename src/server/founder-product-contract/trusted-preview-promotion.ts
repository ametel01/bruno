import "server-only";

export const FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA =
  "bruno.trusted-preview-promotion-evidence.v1" as const;

const REQUIRED_JOURNEYS = [
  "activation",
  "recurring_use",
  "authority",
  "recovery",
  "privacy",
] as const;

export type FounderTrustedPreviewPromotionAssessment = {
  stage: "trusted_preview";
  classification: "learning_round";
  promotionEligible: boolean;
  founderAcceptanceEligible: false;
  automaticPromotion: false;
  completedParticipants: number;
  evidenceDigests: readonly `sha256:${string}`[];
  reasons: readonly string[];
};

export function assessFounderTrustedPreviewPromotionEvidence(input: {
  value: unknown;
  admittedParticipants: readonly {
    userId: string;
    operatorId: string;
    activeDecisionId: string;
    admittedAt: Date;
  }[];
  applicationRevision: string;
  observedAt: Date;
}): FounderTrustedPreviewPromotionAssessment {
  if (!isRecord(input.value)) return deniedAssessment(["evidence_missing"]);
  const value = input.value;
  if (
    value.schemaVersion !== FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA ||
    value.stage !== "trusted_preview" ||
    value.classification !== "learning_round" ||
    value.supportMode !== "attended"
  ) {
    return deniedAssessment(["classification_invalid"]);
  }
  if (value.applicationRevision !== input.applicationRevision) {
    return deniedAssessment(["candidate_mismatch"]);
  }
  if (input.admittedParticipants.length > 3) {
    return deniedAssessment(["cohort_capacity_exceeded"]);
  }
  const participantEvidence = Array.isArray(value.participants) ? value.participants : [];
  const reasons: string[] = [];
  const completedParticipants: string[] = [];
  const evidenceDigests: `sha256:${string}`[] = [];

  for (const participant of participantEvidence) {
    if (!isRecord(participant)) {
      reasons.push("participant_evidence_invalid");
      continue;
    }
    const admission = input.admittedParticipants.find(
      (candidate) =>
        participant.userId === candidate.userId &&
        participant.operatorId === candidate.operatorId &&
        participant.activeDecisionId === candidate.activeDecisionId,
    );
    if (!admission || participant.attendedObservation !== true) {
      reasons.push("admitted_attended_participant_required");
      continue;
    }
    const journeys = isRecord(participant.journeys) ? participant.journeys : {};
    const participantDigests: `sha256:${string}`[] = [];
    let complete = true;
    for (const journey of REQUIRED_JOURNEYS) {
      const evidence = readJourneyEvidence(
        journeys[journey],
        admission.admittedAt,
        input.observedAt,
      );
      if (!evidence) {
        reasons.push(`${journey}_required`);
        complete = false;
      } else {
        participantDigests.push(evidence.evidenceDigest);
      }
    }
    if (complete) {
      completedParticipants.push(admission.userId);
      evidenceDigests.push(...participantDigests);
    }
  }

  if (new Set(completedParticipants).size < 2) {
    reasons.push("two_completed_participants_required");
  }
  if (value.unresolvedReleaseBlockers !== 0 || value.unresolvedCriticalFailures !== 0) {
    reasons.push("unresolved_release_blocker");
  }
  if (new Set(evidenceDigests).size !== evidenceDigests.length) {
    reasons.push("evidence_reuse_forbidden");
  }
  const uniqueReasons = [...new Set(reasons)];
  return {
    stage: "trusted_preview",
    classification: "learning_round",
    promotionEligible: uniqueReasons.length === 0,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    completedParticipants: new Set(completedParticipants).size,
    evidenceDigests: uniqueReasons.length === 0 ? evidenceDigests : [],
    reasons: uniqueReasons,
  };
}

function deniedAssessment(reasons: readonly string[]): FounderTrustedPreviewPromotionAssessment {
  return {
    stage: "trusted_preview",
    classification: "learning_round",
    promotionEligible: false,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    completedParticipants: 0,
    evidenceDigests: [],
    reasons,
  };
}

function readJourneyEvidence(
  value: unknown,
  admittedAt: Date,
  observedAt: Date,
): { occurredAt: Date; evidenceDigest: `sha256:${string}` } | null {
  if (!isRecord(value) || typeof value.occurredAt !== "string") return null;
  const occurredAt = new Date(value.occurredAt);
  if (
    Number.isNaN(occurredAt.valueOf()) ||
    occurredAt.toISOString() !== value.occurredAt ||
    occurredAt < admittedAt ||
    occurredAt > observedAt ||
    !isEvidenceDigest(value.evidenceDigest)
  ) {
    return null;
  }
  return { occurredAt, evidenceDigest: value.evidenceDigest };
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
