import "server-only";

import { and, eq, inArray, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { FOUNDER_TRUSTED_PREVIEW_CAPABILITIES } from "./trusted-preview-qualification";
import {
  getLatestFounderTrustedPreviewStageDecisionInTransaction,
  lockFounderTrustedPreviewCohortInTransaction,
  requireFounderTrustedPreviewCohortOwnerInTransaction,
} from "./trusted-preview-release-decision";

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

export async function assessFounderTrustedPreviewPromotionEvidenceForCohort(input: {
  value: unknown;
  cohortOwnerUserId: string;
  applicationRevision: string;
  observedAt: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<FounderTrustedPreviewPromotionAssessment> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderTrustedPreviewCohortInTransaction(tx);
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, input.cohortOwnerUserId);
      const stageDecision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
        tx,
        input.cohortOwnerUserId,
      );
      const [ownerAuthority] = await tx
        .select({
          operatorId: operators.id,
          runtimeRevision: operatorRuntimes.configRevision,
          runtimeStatus: operatorRuntimes.status,
        })
        .from(operators)
        .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
        .where(and(eq(operators.userId, input.cohortOwnerUserId), eq(operators.status, "active")))
        .limit(1);
      if (
        !stageDecision ||
        !ownerAuthority ||
        (stageDecision.outcome !== "enter" && stageDecision.outcome !== "resume") ||
        stageDecision.applicationRevision !== input.applicationRevision ||
        stageDecision.operatorId !== ownerAuthority.operatorId ||
        stageDecision.runtimeRevision !== ownerAuthority.runtimeRevision ||
        ownerAuthority.runtimeStatus !== "ready" ||
        stageDecision.capabilityManifest.length !== FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.length ||
        !FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.every((capability) =>
          stageDecision.capabilityManifest.includes(capability),
        ) ||
        !stageDecision.openAiQualificationExpiresAt ||
        stageDecision.openAiQualificationExpiresAt <= input.observedAt ||
        !stageDecision.calendarQualificationExpiresAt ||
        stageDecision.calendarQualificationExpiresAt <= input.observedAt
      ) {
        return deniedAssessment(["active_stage_decision_required"]);
      }
      const admittedRows = await tx
        .select({
          userId: founderTrustedPreviewInvitations.participantUserId,
          operatorId: founderTrustedPreviewInvitations.participantOperatorId,
          activeDecisionId: founderReleaseDecisions.id,
          admittedAt: founderTrustedPreviewInvitations.admittedAt,
          decisionApplicationRevision: founderReleaseDecisions.applicationRevision,
          decisionRuntimeRevision: founderReleaseDecisions.runtimeRevision,
          capabilityManifest: founderReleaseDecisions.capabilityManifest,
          runtimeRevision: operatorRuntimes.configRevision,
          runtimeStatus: operatorRuntimes.status,
        })
        .from(founderTrustedPreviewInvitations)
        .innerJoin(
          founderReleaseDecisions,
          eq(founderReleaseDecisions.id, founderTrustedPreviewInvitations.admissionDecisionId),
        )
        .innerJoin(
          operators,
          and(
            eq(operators.id, founderTrustedPreviewInvitations.participantOperatorId),
            eq(operators.userId, founderTrustedPreviewInvitations.participantUserId),
          ),
        )
        .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
        .where(
          and(
            eq(founderTrustedPreviewInvitations.cohortOwnerUserId, input.cohortOwnerUserId),
            eq(founderTrustedPreviewInvitations.status, "admitted"),
            lte(founderTrustedPreviewInvitations.admittedAt, input.observedAt),
            eq(founderReleaseDecisions.stage, "trusted_preview"),
            inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
            eq(founderReleaseDecisions.applicationRevision, input.applicationRevision),
            eq(operators.status, "active"),
          ),
        );
      const admittedParticipants = admittedRows.flatMap((row) => {
        if (
          !row.userId ||
          !row.operatorId ||
          !row.admittedAt ||
          row.userId === input.cohortOwnerUserId ||
          row.decisionApplicationRevision !== input.applicationRevision ||
          row.decisionRuntimeRevision !== row.runtimeRevision ||
          row.runtimeStatus !== "ready" ||
          row.capabilityManifest.length !== FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.length ||
          !FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.every((capability) =>
            row.capabilityManifest.includes(capability),
          )
        ) {
          return [];
        }
        return [
          {
            userId: row.userId,
            operatorId: row.operatorId,
            activeDecisionId: row.activeDecisionId,
            admittedAt: row.admittedAt,
          },
        ];
      });
      return assessFounderTrustedPreviewPromotionEvidence({
        value: input.value,
        admittedParticipants,
        applicationRevision: input.applicationRevision,
        observedAt: input.observedAt,
      });
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

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
