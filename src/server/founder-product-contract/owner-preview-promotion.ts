import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderReleaseDecisions } from "@/src/server/db/schema";

export const FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA =
  "bruno.owner-preview-promotion-evidence.v1" as const;
export const FOUNDER_OWNER_PREVIEW_MINIMUM_CONSECUTIVE_DAYS = 7;

const REQUIRED_JOURNEYS = [
  "desktop_activation",
  "phone_activation",
  "interruption_recovery",
  "provider_reauthorization",
  "provider_disconnect",
  "founder_data_export",
  "bruno_data_deletion",
] as const;

export type FounderOwnerPreviewPromotionAssessment = {
  stage: "owner_preview";
  classification: "learning_round";
  promotionEligible: boolean;
  founderAcceptanceEligible: false;
  automaticPromotion: false;
  evidenceDigests: readonly `sha256:${string}`[];
  reasons: readonly string[];
};

export async function assessFounderOwnerPreviewPromotionEvidenceForUser(input: {
  value: unknown;
  ownerUserId: string;
  applicationRevision: string;
  runtimeRevision: string;
  observedAt: Date;
  createConnection?: () => DatabaseConnection;
}): Promise<FounderOwnerPreviewPromotionAssessment> {
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  try {
    const [decision] = await connection.db
      .select({
        id: founderReleaseDecisions.id,
        operatorId: founderReleaseDecisions.operatorId,
        outcome: founderReleaseDecisions.outcome,
        applicationRevision: founderReleaseDecisions.applicationRevision,
        runtimeRevision: founderReleaseDecisions.runtimeRevision,
        decidedAt: founderReleaseDecisions.decidedAt,
      })
      .from(founderReleaseDecisions)
      .where(
        and(
          eq(founderReleaseDecisions.userId, input.ownerUserId),
          eq(founderReleaseDecisions.stage, "owner_preview"),
        ),
      )
      .orderBy(desc(founderReleaseDecisions.decidedAt))
      .limit(1);
    if (
      !decision ||
      (decision.outcome !== "enter" && decision.outcome !== "resume") ||
      !decision.operatorId ||
      decision.applicationRevision !== input.applicationRevision ||
      decision.runtimeRevision !== input.runtimeRevision
    ) {
      return deniedPromotionAssessment(["active_owner_preview_period_required"]);
    }
    return assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
      value: input.value,
      ownerUserId: input.ownerUserId,
      operatorId: decision.operatorId,
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      activeDecisionId: decision.id,
      activePeriodStartedAt: decision.decidedAt,
      observedAt: input.observedAt,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function assessFounderOwnerPreviewPromotionEvidenceAgainstDecision(input: {
  value: unknown;
  ownerUserId: string;
  operatorId: string;
  applicationRevision: string;
  runtimeRevision: string;
  activeDecisionId: string;
  activePeriodStartedAt: Date;
  observedAt: Date;
}): FounderOwnerPreviewPromotionAssessment {
  if (!isRecord(input.value)) return deniedPromotionAssessment(["evidence_missing"]);
  const value = input.value;
  if (
    value.schemaVersion !== FOUNDER_OWNER_PREVIEW_PROMOTION_EVIDENCE_SCHEMA ||
    value.stage !== "owner_preview" ||
    value.classification !== "learning_round"
  ) {
    return deniedPromotionAssessment(["classification_invalid"]);
  }
  if (
    value.ownerUserId !== input.ownerUserId ||
    value.operatorId !== input.operatorId ||
    value.applicationRevision !== input.applicationRevision ||
    value.runtimeRevision !== input.runtimeRevision ||
    value.activeDecisionId !== input.activeDecisionId
  ) {
    return deniedPromotionAssessment(["candidate_mismatch"]);
  }
  if (
    Number.isNaN(input.observedAt.valueOf()) ||
    Number.isNaN(input.activePeriodStartedAt.valueOf()) ||
    input.activePeriodStartedAt > input.observedAt
  ) {
    return deniedPromotionAssessment(["observation_invalid"]);
  }
  const dailyBriefs = Array.isArray(value.dailyBriefs) ? value.dailyBriefs : [];
  const dayEvidence = dailyBriefs
    .map((evidence) =>
      readDailyBriefEvidence(evidence, input.activePeriodStartedAt, input.observedAt),
    )
    .filter(
      (
        evidence,
      ): evidence is {
        day: string;
        occurredAt: Date;
        evidenceDigest: `sha256:${string}`;
      } => Boolean(evidence),
    )
    .sort((left, right) => left.day.localeCompare(right.day));
  const reasons: string[] = [];
  if (
    dailyBriefs.some((evidence) =>
      dailyBriefPredatesActivePeriod(evidence, input.activePeriodStartedAt),
    )
  ) {
    reasons.push("active_owner_preview_period_required");
  }
  if (
    dayEvidence.length < FOUNDER_OWNER_PREVIEW_MINIMUM_CONSECUTIVE_DAYS ||
    dayEvidence.length !== dailyBriefs.length ||
    longestConsecutiveDayRun(dayEvidence.map((evidence) => evidence.day)) <
      FOUNDER_OWNER_PREVIEW_MINIMUM_CONSECUTIVE_DAYS
  ) {
    reasons.push("seven_consecutive_daily_briefs_required");
  }
  const journeys = isRecord(value.journeys) ? value.journeys : {};
  const journeyEvidence = REQUIRED_JOURNEYS.map((journey) => ({
    journey,
    evidence: readJourneyEvidence(journeys[journey], input.activePeriodStartedAt, input.observedAt),
  }));
  for (const evidence of journeyEvidence) {
    if (!evidence.evidence) reasons.push(`${evidence.journey}_required`);
  }
  if (value.unresolvedReleaseBlockers !== 0 || value.unresolvedCriticalFailures !== 0) {
    reasons.push("unresolved_release_blocker");
  }
  const evidenceDigests = [
    ...dayEvidence.map((evidence) => evidence.evidenceDigest),
    ...journeyEvidence.flatMap((evidence) =>
      evidence.evidence ? [evidence.evidence.evidenceDigest] : [],
    ),
  ];
  if (new Set(evidenceDigests).size !== evidenceDigests.length) {
    reasons.push("evidence_reuse_forbidden");
  }
  return {
    stage: "owner_preview",
    classification: "learning_round",
    promotionEligible: reasons.length === 0,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    evidenceDigests: reasons.length === 0 ? evidenceDigests : [],
    reasons,
  };
}

function deniedPromotionAssessment(
  reasons: readonly string[],
): FounderOwnerPreviewPromotionAssessment {
  return {
    stage: "owner_preview",
    classification: "learning_round",
    promotionEligible: false,
    founderAcceptanceEligible: false,
    automaticPromotion: false,
    evidenceDigests: [],
    reasons,
  };
}

function readJourneyEvidence(
  value: unknown,
  activePeriodStartedAt: Date,
  observedAt: Date,
): { occurredAt: Date; evidenceDigest: `sha256:${string}` } | null {
  if (!isRecord(value) || typeof value.occurredAt !== "string") return null;
  const occurredAt = new Date(value.occurredAt);
  if (
    Number.isNaN(occurredAt.valueOf()) ||
    occurredAt.toISOString() !== value.occurredAt ||
    occurredAt < activePeriodStartedAt ||
    occurredAt > observedAt ||
    !isEvidenceDigest(value.evidenceDigest)
  ) {
    return null;
  }
  return { occurredAt, evidenceDigest: value.evidenceDigest };
}

function readDailyBriefEvidence(
  value: unknown,
  activePeriodStartedAt: Date,
  observedAt: Date,
): { day: string; occurredAt: Date; evidenceDigest: `sha256:${string}` } | null {
  const day =
    isRecord(value) && typeof value.day === "string"
      ? new Date(`${value.day}T00:00:00.000Z`)
      : null;
  const occurredAt =
    isRecord(value) && typeof value.occurredAt === "string" ? new Date(value.occurredAt) : null;
  if (
    !isRecord(value) ||
    typeof value.day !== "string" ||
    typeof value.occurredAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
    !day ||
    Number.isNaN(day.valueOf()) ||
    day.toISOString().slice(0, 10) !== value.day ||
    !occurredAt ||
    Number.isNaN(occurredAt.valueOf()) ||
    occurredAt.toISOString() !== value.occurredAt ||
    occurredAt.toISOString().slice(0, 10) !== value.day ||
    occurredAt < activePeriodStartedAt ||
    occurredAt > observedAt ||
    !isEvidenceDigest(value.evidenceDigest)
  ) {
    return null;
  }
  return { day: value.day, occurredAt, evidenceDigest: value.evidenceDigest };
}

function dailyBriefPredatesActivePeriod(value: unknown, activePeriodStartedAt: Date): boolean {
  if (!isRecord(value) || typeof value.occurredAt !== "string") return false;
  const occurredAt = new Date(value.occurredAt);
  return !Number.isNaN(occurredAt.valueOf()) && occurredAt < activePeriodStartedAt;
}

function longestConsecutiveDayRun(days: readonly string[]): number {
  if (new Set(days).size !== days.length) return 0;
  let longest = days.length > 0 ? 1 : 0;
  let current = longest;
  for (let index = 1; index < days.length; index += 1) {
    const day = days[index];
    const prior = days[index - 1];
    if (!day || !prior) return 0;
    current =
      new Date(`${day}T00:00:00.000Z`).valueOf() - new Date(`${prior}T00:00:00.000Z`).valueOf() ===
      24 * 60 * 60 * 1_000
        ? current + 1
        : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
