import "server-only";

import { and, eq, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderExternalBetaInvitations, founderReleaseDecisions } from "@/src/server/db/schema";
import { lockFounderExternalBetaCohortInTransaction } from "./external-beta-admission";
import { FOUNDER_EXTERNAL_BETA_CAPABILITIES } from "./external-beta-qualification";

export const FOUNDER_EXTERNAL_BETA_PROMOTION_EVIDENCE_SCHEMA =
  "bruno.external-beta-promotion-evidence.v1" as const;

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1_000;

export type FounderExternalBetaPromotionAssessment = {
  stage: "external_beta";
  classification: "product_hardening";
  promotionEligible: boolean;
  founderAcceptanceEligible: false;
  automaticPromotion: false;
  extendCurrentCohort: false;
  newCohortRequired: boolean;
  independentFounders: number;
  recurringLeadToClientLoops: number;
  evidenceDigests: readonly `sha256:${string}`[];
  reasons: readonly string[];
};

export async function assessFounderExternalBetaPromotionEvidenceForCohort(input: {
  value: unknown;
  cohort: string;
  applicationRevision: string;
  observedAt: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<FounderExternalBetaPromotionAssessment> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderExternalBetaCohortInTransaction(tx);
      const rows = await tx
        .select({
          userId: founderExternalBetaInvitations.participantUserId,
          operatorId: founderExternalBetaInvitations.participantOperatorId,
          admissionDecisionId: founderExternalBetaInvitations.admissionDecisionId,
          admittedAt: founderExternalBetaInvitations.admittedAt,
          accessExpiresAt: founderExternalBetaInvitations.accessExpiresAt,
          status: founderExternalBetaInvitations.status,
          independenceEvidenceDigest: founderExternalBetaInvitations.independenceEvidenceDigest,
          decisionStage: founderReleaseDecisions.stage,
          decisionOutcome: founderReleaseDecisions.outcome,
          decisionApplicationRevision: founderReleaseDecisions.applicationRevision,
          decisionOperatorId: founderReleaseDecisions.operatorId,
          decisionCohort: founderReleaseDecisions.externalBetaCohort,
          capabilityManifest: founderReleaseDecisions.capabilityManifest,
        })
        .from(founderExternalBetaInvitations)
        .innerJoin(
          founderReleaseDecisions,
          eq(founderReleaseDecisions.id, founderExternalBetaInvitations.admissionDecisionId),
        )
        .where(
          and(
            eq(founderExternalBetaInvitations.cohort, input.cohort),
            eq(founderExternalBetaInvitations.status, "expired"),
            eq(founderReleaseDecisions.stage, "external_beta"),
            eq(founderReleaseDecisions.applicationRevision, input.applicationRevision),
            lte(founderExternalBetaInvitations.admittedAt, input.observedAt),
          ),
        );
      const participants = rows.flatMap((row) =>
        row.userId &&
        row.operatorId &&
        row.admissionDecisionId &&
        row.admittedAt &&
        row.accessExpiresAt &&
        row.decisionStage === "external_beta" &&
        (row.decisionOutcome === "enter" || row.decisionOutcome === "resume") &&
        row.decisionApplicationRevision === input.applicationRevision &&
        row.decisionOperatorId === row.operatorId &&
        row.decisionCohort === input.cohort &&
        row.capabilityManifest.length === FOUNDER_EXTERNAL_BETA_CAPABILITIES.length &&
        FOUNDER_EXTERNAL_BETA_CAPABILITIES.every((capability) =>
          row.capabilityManifest.includes(capability),
        )
          ? [
              {
                ...row,
                userId: row.userId,
                operatorId: row.operatorId,
                admissionDecisionId: row.admissionDecisionId,
                admittedAt: row.admittedAt,
                accessExpiresAt: row.accessExpiresAt,
                independenceEvidenceDigest: row.independenceEvidenceDigest as `sha256:${string}`,
              },
            ]
          : [],
      );
      return assessFounderExternalBetaPromotionEvidence({ ...input, participants });
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function assessFounderExternalBetaPromotionEvidence(input: {
  value: unknown;
  cohort: string;
  applicationRevision: string;
  observedAt: Date;
  participants: readonly {
    userId: string;
    operatorId: string;
    admissionDecisionId: string;
    admittedAt: Date;
    accessExpiresAt: Date;
    status: string;
    independenceEvidenceDigest: `sha256:${string}`;
  }[];
}): FounderExternalBetaPromotionAssessment {
  if (!isRecord(input.value)) return denied(["evidence_missing"], input.participants.length, 0);
  const value = input.value;
  if (
    value.schemaVersion !== FOUNDER_EXTERNAL_BETA_PROMOTION_EVIDENCE_SCHEMA ||
    value.stage !== "external_beta" ||
    value.classification !== "product_hardening" ||
    value.supportMode !== "self_serve_reactive" ||
    value.applicationRevision !== input.applicationRevision ||
    value.cohort !== input.cohort
  ) {
    return denied(["classification_or_candidate_invalid"], input.participants.length, 0);
  }
  const reasons: string[] = [];
  const roster = new Map(
    input.participants.map((participant) => [participant.userId, participant]),
  );
  if (roster.size < 5 || roster.size > 10 || roster.size !== input.participants.length) {
    reasons.push("five_to_ten_independent_founders_required");
  }
  const evidenceParticipants = Array.isArray(value.participants) ? value.participants : [];
  const completedFounders = new Set<string>();
  const recurringLoops = new Set<string>();
  const evidenceDigests: `sha256:${string}`[] = [];

  for (const participantValue of evidenceParticipants) {
    if (!isRecord(participantValue)) {
      reasons.push("participant_evidence_invalid");
      continue;
    }
    const participant =
      typeof participantValue.userId === "string" ? roster.get(participantValue.userId) : undefined;
    if (
      !participant ||
      participantValue.operatorId !== participant.operatorId ||
      participantValue.admissionDecisionId !== participant.admissionDecisionId ||
      participantValue.independentFounder !== true ||
      participantValue.independenceEvidenceDigest !== participant.independenceEvidenceDigest ||
      participantValue.selfServeOrdinaryUse !== true ||
      participantValue.attendedOperation !== false ||
      participant.accessExpiresAt.valueOf() - participant.admittedAt.valueOf() !==
        FOURTEEN_DAYS_MS ||
      input.observedAt < participant.accessExpiresAt ||
      participant.status !== "expired"
    ) {
      reasons.push("complete_independent_fourteen_day_participant_required");
      continue;
    }
    completedFounders.add(participant.userId);
    evidenceDigests.push(participant.independenceEvidenceDigest);
    const loops = Array.isArray(participantValue.recurringLeadToClientLoops)
      ? participantValue.recurringLeadToClientLoops
      : [];
    for (const loop of loops) {
      if (
        !isRecord(loop) ||
        typeof loop.loopId !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(loop.loopId) ||
        loop.completedCycles !== 2 ||
        !isEvidenceDigest(loop.evidenceDigest) ||
        recurringLoops.has(loop.loopId)
      ) {
        reasons.push("recurring_lead_to_client_loop_invalid");
        continue;
      }
      recurringLoops.add(loop.loopId);
      evidenceDigests.push(loop.evidenceDigest);
    }
  }
  if (completedFounders.size !== roster.size) reasons.push("complete_cohort_evidence_required");
  if (recurringLoops.size < 5) reasons.push("five_recurring_lead_to_client_loops_required");
  if (new Set(evidenceDigests).size !== evidenceDigests.length)
    reasons.push("evidence_reuse_forbidden");
  if (value.unresolvedReleaseBlockers !== 0 || value.unresolvedCriticalFailures !== 0) {
    reasons.push("unresolved_release_blocker");
  }
  const uniqueReasons = [...new Set(reasons)];
  return {
    stage: "external_beta",
    classification: "product_hardening",
    promotionEligible: uniqueReasons.length === 0,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    extendCurrentCohort: false,
    newCohortRequired: uniqueReasons.length > 0,
    independentFounders: roster.size,
    recurringLeadToClientLoops: recurringLoops.size,
    evidenceDigests: uniqueReasons.length === 0 ? evidenceDigests : [],
    reasons: uniqueReasons,
  };
}

function denied(
  reasons: readonly string[],
  independentFounders: number,
  recurringLeadToClientLoops: number,
): FounderExternalBetaPromotionAssessment {
  return {
    stage: "external_beta",
    classification: "product_hardening",
    promotionEligible: false,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    extendCurrentCohort: false,
    newCohortRequired: true,
    independentFounders,
    recurringLeadToClientLoops,
    evidenceDigests: [],
    reasons,
  };
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
