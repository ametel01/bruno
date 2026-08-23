import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";
import {
  appMetadata,
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
} from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
} from "./operator-authority";
import { FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY } from "./owner-preview-release-decision";
import { FOUNDER_TRUSTED_PREVIEW_CAPABILITIES } from "./trusted-preview-qualification";

export const FOUNDER_TRUSTED_PREVIEW_COHORT_LOCK_KEY = "founder_trusted_preview_cohort:v1" as const;

export type FounderTrustedPreviewStageDecision = {
  id: string;
  cohortOwnerUserId: string;
  operatorId: string;
  outcome: "enter" | "deny" | "hold" | "resume";
  applicationRevision: string;
  runtimeRevision: string;
  capabilityManifest: readonly string[];
  affectedCapabilities: readonly string[];
  evidenceDigests: readonly string[];
  openAiQualificationExpiresAt: Date | null;
  calendarQualificationExpiresAt: Date | null;
  decidedAt: Date;
};

export async function lockFounderTrustedPreviewCohortInTransaction(
  tx: FounderProductContractTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${FOUNDER_TRUSTED_PREVIEW_COHORT_LOCK_KEY}, 0))`,
  );
}

export async function requireFounderTrustedPreviewCohortOwnerInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<void> {
  const [mapping] = await tx
    .select({ userId: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY))
    .limit(1);
  if (mapping?.userId !== userId) {
    throw new Error("Trusted Preview Release Decisions require the mapped Bruno.Ai Owner.");
  }
}

export async function getFounderTrustedPreviewCohortOwnerIdInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
): Promise<string | null> {
  const [mapping] = await tx
    .select({ userId: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY))
    .limit(1);
  return mapping?.userId ?? null;
}

export async function getLatestFounderTrustedPreviewStageDecisionInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  cohortOwnerUserId: string,
): Promise<FounderTrustedPreviewStageDecision | null> {
  const [decision] = await tx
    .select({
      id: founderReleaseDecisions.id,
      cohortOwnerUserId: founderReleaseDecisions.userId,
      operatorId: founderReleaseDecisions.operatorId,
      outcome: founderReleaseDecisions.outcome,
      applicationRevision: founderReleaseDecisions.applicationRevision,
      runtimeRevision: founderReleaseDecisions.runtimeRevision,
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
      affectedCapabilities: founderReleaseDecisions.affectedCapabilities,
      evidenceDigests: founderReleaseDecisions.evidenceDigests,
      openAiQualificationExpiresAt: founderReleaseDecisions.openAiQualificationExpiresAt,
      calendarQualificationExpiresAt: founderReleaseDecisions.calendarQualificationExpiresAt,
      decidedAt: founderReleaseDecisions.decidedAt,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, cohortOwnerUserId),
        eq(founderReleaseDecisions.stage, "trusted_preview"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (!decision?.cohortOwnerUserId || !decision.operatorId) return null;
  return {
    ...decision,
    cohortOwnerUserId: decision.cohortOwnerUserId,
    operatorId: decision.operatorId,
  };
}

export async function persistQualifiedFounderTrustedPreviewStageDecisionInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    cohortOwnerUserId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    qualificationObservedAt: Date;
    qualificationExpiresAt: Readonly<Record<"openai" | "calendar_reading", Date>>;
    qualificationEvidenceDigests: readonly `sha256:${string}`[];
    promotionEvidenceDigests: readonly `sha256:${string}`[];
    identityEvidenceDigest: `sha256:${string}`;
    decidedAt: Date;
  },
): Promise<string> {
  validateExactDecisionInput(input);
  if (input.promotionEvidenceDigests.length === 0) {
    throw new Error("Trusted Preview requires complete Owner Preview promotion evidence.");
  }
  await lockFounderTrustedPreviewCohortInTransaction(tx);
  await lockFounderProductContractLifecycleInTransaction(tx, input.cohortOwnerUserId);
  await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, input.cohortOwnerUserId);
  const latestDecision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
    tx,
    input.cohortOwnerUserId,
  );
  const held = latestDecision?.outcome === "hold";
  if (held) {
    if (
      input.qualificationObservedAt <= latestDecision.decidedAt ||
      input.qualificationEvidenceDigests.some((digest) =>
        latestDecision.evidenceDigests.includes(digest),
      )
    ) {
      throw new Error("Trusted Preview Hold requires fresh Preview Qualification evidence.");
    }
  }
  const evidenceDigests = [
    input.identityEvidenceDigest,
    ...input.qualificationEvidenceDigests,
    ...input.promotionEvidenceDigests,
  ];
  const sameActiveDecision =
    (latestDecision?.outcome === "enter" || latestDecision?.outcome === "resume") &&
    latestDecision.applicationRevision === input.applicationRevision &&
    latestDecision.runtimeRevision === input.runtimeRevision &&
    evidenceDigests.every((digest) => latestDecision.evidenceDigests.includes(digest));
  if (sameActiveDecision) return latestDecision.id;
  const decidedAt =
    latestDecision && input.decidedAt <= latestDecision.decidedAt
      ? new Date(latestDecision.decidedAt.valueOf() + 1)
      : input.decidedAt;
  const [decision] = await tx
    .insert(founderReleaseDecisions)
    .values({
      userId: input.cohortOwnerUserId,
      operatorId: input.operatorId,
      stage: "trusted_preview",
      outcome: held ? "resume" : "enter",
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      capabilityManifest: FOUNDER_TRUSTED_PREVIEW_CAPABILITIES,
      openAiQualificationExpiresAt: input.qualificationExpiresAt.openai,
      calendarQualificationExpiresAt: input.qualificationExpiresAt.calendar_reading,
      evidenceDigests,
      decidedAt,
      createdAt: decidedAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!decision) throw new Error("Trusted Preview Release Decision could not be persisted.");
  return decision.id;
}

export async function persistFounderTrustedPreviewStageHoldInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    cohortOwnerUserId: string;
    applicationRevision: string;
    runtimeRevision: string;
    finding: "critical" | "release_blocking";
    affectedCapabilities: readonly (typeof FOUNDER_TRUSTED_PREVIEW_CAPABILITIES)[number][];
    evidenceDigests: readonly `sha256:${string}`[];
    decidedAt: Date;
  },
): Promise<string | null> {
  if (
    !/^[a-f0-9]{40}$/.test(input.applicationRevision) ||
    !input.runtimeRevision.trim() ||
    input.affectedCapabilities.length === 0 ||
    input.evidenceDigests.length === 0 ||
    !input.evidenceDigests.every(isEvidenceDigest)
  ) {
    throw new Error("Trusted Preview Hold evidence is invalid.");
  }
  await lockFounderTrustedPreviewCohortInTransaction(tx);
  await lockFounderProductContractLifecycleInTransaction(tx, input.cohortOwnerUserId);
  await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, input.cohortOwnerUserId);
  const latestDecision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
    tx,
    input.cohortOwnerUserId,
  );
  if (
    !latestDecision ||
    latestDecision.outcome === "deny" ||
    latestDecision.applicationRevision !== input.applicationRevision ||
    latestDecision.runtimeRevision !== input.runtimeRevision
  ) {
    return null;
  }
  const affectedCapabilities = FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.filter(
    (capability) =>
      input.affectedCapabilities.includes(capability) ||
      latestDecision.affectedCapabilities.includes(capability),
  );
  const findingDigest = founderProductContractDigest(
    JSON.stringify({ kind: "trusted_preview_finding", severity: input.finding }),
  );
  const evidenceDigests = [
    ...new Set([...latestDecision.evidenceDigests, ...input.evidenceDigests, findingDigest]),
  ];
  if (
    latestDecision.outcome === "hold" &&
    affectedCapabilities.length === latestDecision.affectedCapabilities.length &&
    evidenceDigests.length === latestDecision.evidenceDigests.length
  ) {
    return latestDecision.id;
  }
  const decidedAt =
    input.decidedAt > latestDecision.decidedAt
      ? input.decidedAt
      : new Date(latestDecision.decidedAt.valueOf() + 1);
  const [hold] = await tx
    .insert(founderReleaseDecisions)
    .values({
      userId: input.cohortOwnerUserId,
      operatorId: latestDecision.operatorId,
      stage: "trusted_preview",
      outcome: "hold",
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      capabilityManifest: FOUNDER_TRUSTED_PREVIEW_CAPABILITIES,
      openAiQualificationExpiresAt: latestDecision.openAiQualificationExpiresAt,
      calendarQualificationExpiresAt: latestDecision.calendarQualificationExpiresAt,
      affectedCapabilities,
      evidenceDigests,
      decidedAt,
      createdAt: decidedAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!hold) throw new Error("Trusted Preview Hold could not be persisted.");
  await tx
    .update(founderTrustedPreviewInvitations)
    .set({ status: "revoked", revokedAt: decidedAt })
    .where(
      and(
        eq(founderTrustedPreviewInvitations.cohortOwnerUserId, input.cohortOwnerUserId),
        eq(founderTrustedPreviewInvitations.status, "invited"),
      ),
    );
  return hold.id;
}

export async function reconcileFounderTrustedPreviewQualificationExpiryInTransaction(
  tx: FounderProductContractTransaction,
  input: { cohortOwnerUserId: string; applicationRevision: string; now: Date },
): Promise<string | null> {
  // Keep this lock for the enclosing work-authority transaction even when qualification is
  // current, so a concurrent Hold cannot commit between the access check and protected work.
  await lockFounderTrustedPreviewCohortInTransaction(tx);
  await lockFounderProductContractLifecycleInTransaction(tx, input.cohortOwnerUserId);
  const latestDecision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
    tx,
    input.cohortOwnerUserId,
  );
  if (
    !latestDecision ||
    latestDecision.outcome === "deny" ||
    latestDecision.applicationRevision !== input.applicationRevision
  ) {
    return null;
  }
  const expirations = {
    openai: latestDecision.openAiQualificationExpiresAt,
    calendar_reading: latestDecision.calendarQualificationExpiresAt,
  } as const;
  const affectedCapabilities = FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.filter(
    (capability) => !expirations[capability] || expirations[capability] <= input.now,
  );
  if (affectedCapabilities.length === 0) return null;
  return persistFounderTrustedPreviewStageHoldInTransaction(tx, {
    cohortOwnerUserId: input.cohortOwnerUserId,
    applicationRevision: latestDecision.applicationRevision,
    runtimeRevision: latestDecision.runtimeRevision,
    finding: "release_blocking",
    affectedCapabilities,
    evidenceDigests: affectedCapabilities.map((capability) =>
      founderProductContractDigest(
        JSON.stringify({
          kind: "trusted_preview_qualification_expired",
          capability,
          expiresAt: expirations[capability]?.toISOString() ?? null,
        }),
      ),
    ),
    decidedAt: input.now,
  });
}

function validateExactDecisionInput(input: {
  applicationRevision: string;
  runtimeRevision: string;
  qualificationObservedAt: Date;
  qualificationExpiresAt: Readonly<Record<"openai" | "calendar_reading", Date>>;
  qualificationEvidenceDigests: readonly `sha256:${string}`[];
  identityEvidenceDigest: `sha256:${string}`;
  decidedAt: Date;
}): void {
  if (
    !/^[a-f0-9]{40}$/.test(input.applicationRevision) ||
    !input.runtimeRevision.trim() ||
    Number.isNaN(input.qualificationObservedAt.valueOf()) ||
    Number.isNaN(input.decidedAt.valueOf()) ||
    input.qualificationEvidenceDigests.length !== FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.length ||
    !input.qualificationEvidenceDigests.every(isEvidenceDigest) ||
    !isEvidenceDigest(input.identityEvidenceDigest) ||
    input.qualificationExpiresAt.openai <= input.decidedAt ||
    input.qualificationExpiresAt.calendar_reading <= input.decidedAt
  ) {
    throw new Error("Trusted Preview Release Decision evidence is invalid.");
  }
}

function isEvidenceDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
