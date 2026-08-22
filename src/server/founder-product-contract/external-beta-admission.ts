import "server-only";

import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, lte, sql } from "drizzle-orm";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderExternalBetaInvitations,
  founderPreviewQualifications,
  founderRecoveryArchives,
  founderReleaseDecisions,
  operators,
  users,
} from "@/src/server/db/schema";
import { requireFounderApplicationRevision } from "./application-revision";
import { founderProductContractDigest } from "./digest";
import { createEncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  type FounderExternalBetaCapability,
} from "./external-beta-qualification";
import { getFounderExternalBetaManifestForUser } from "./external-beta-manifest";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";
import {
  assessFounderTrustedPreviewPromotionEvidenceForCohort,
  type FounderTrustedPreviewPromotionAssessment,
} from "./trusted-preview-promotion";
import {
  getLatestFounderTrustedPreviewStageDecisionInTransaction,
  requireFounderTrustedPreviewCohortOwnerInTransaction,
} from "./trusted-preview-release-decision";

export const FOUNDER_EXTERNAL_BETA_COMPACT_VERSION = "bruno.external-beta-compact.v1" as const;
export const FOUNDER_EXTERNAL_BETA_INVITATION_MS = 7 * 24 * 60 * 60 * 1_000;
export const FOUNDER_EXTERNAL_BETA_ACCESS_MS = 14 * 24 * 60 * 60 * 1_000;
export const FOUNDER_EXTERNAL_BETA_RETIREMENT_MS = 60 * 60 * 1_000;
export const FOUNDER_EXTERNAL_BETA_COHORT_LOCK_KEY = "founder_external_beta_cohort:v1" as const;

const TOKEN_BYTES = 32;
const ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const EXPIRED_PAUSE_REASON =
  "External Beta access ended. Saved Bruno-local data remains available for export or deletion.";

export type FounderExternalBetaCompactAcceptance = {
  version: typeof FOUNDER_EXTERNAL_BETA_COMPACT_VERSION;
  instabilityAccepted: true;
  capabilityBoundaryAccepted: true;
  reactiveSupportAccepted: true;
  companyDataHandlingAccepted: true;
  feedbackBoundaryAccepted: true;
  withdrawalExportDeletionAccepted: true;
  freeNonconvertingBoundaryAccepted: true;
};

export type FounderExternalBetaAdmissionDependencies = {
  applicationRevision?: string;
  cohort?: string;
  createConnection?: () => DatabaseConnection;
  createProvider?: () => FounderRecoveryArchiveProvider | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  createInvitationToken?: () => string;
  beforeDecisionCommit?: () => Promise<void>;
};

export type FounderExternalBetaStatus =
  | { state: "unavailable" }
  | {
      state: "active" | "expired" | "withdrawn";
      stage: "External Beta";
      admittedAt: string;
      accessExpiresAt: string;
      workStoppedAt: string | null;
      remainingSeconds: number;
      support: "Self-serve onboarding and ordinary use, with reactive support";
      payment: "Free, no card, no renewal, and no automatic paid conversion";
      evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence";
      availableCapabilities: readonly FounderExternalBetaCapability[];
      unavailableCapabilities: readonly FounderExternalBetaCapability[];
      withdrawalAvailable: boolean;
      exportAvailable: true;
      deletionAvailable: true;
      retirementDueAt: string;
    };

export async function lockFounderExternalBetaCohortInTransaction(
  tx: FounderProductContractTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${FOUNDER_EXTERNAL_BETA_COHORT_LOCK_KEY}, 0))`,
  );
}

export async function enterFounderExternalBetaStage(
  cohortOwnerUserId: string,
  dependencies: FounderExternalBetaAdmissionDependencies = {},
): Promise<{ decisionId: string; cohort: string }> {
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("External Beta requires an authenticated Clerk release authority.");
  }
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "External Beta application revision is unavailable.",
  );
  const cohort = dependencies.cohort ?? environment.BRUNO_EXTERNAL_BETA_COHORT?.trim();
  if (!cohort || !isCohort(cohort)) throw new Error("External Beta cohort is unavailable.");
  const promotionEvidence = parseEvidence(
    environment.BRUNO_TRUSTED_PREVIEW_PROMOTION_EVIDENCE,
    "Trusted Preview promotion evidence is unavailable.",
  );
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, cohortOwnerUserId))
      .limit(1);
    if (!identity?.subject) throw new Error("External Beta requires a Clerk release authority.");
    const authority = await connection.db.transaction(async (tx) => {
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, cohortOwnerUserId);
      return requireReadyFounderOperatorAuthorityInTransaction(tx, cohortOwnerUserId);
    });
    const trustedDecision = await connection.db.transaction(async (tx) => {
      const decision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
        tx,
        cohortOwnerUserId,
      );
      if (
        !decision ||
        (decision.outcome !== "enter" && decision.outcome !== "resume") ||
        decision.applicationRevision !== applicationRevision ||
        decision.operatorId !== authority.operatorId ||
        decision.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("An active exact-candidate Trusted Preview decision is required.");
      }
      return decision;
    });
    const promotion = await assessFounderTrustedPreviewPromotionEvidenceForCohort({
      value: promotionEvidence,
      cohortOwnerUserId,
      applicationRevision,
      observedAt: now,
      createConnection: () => connection,
    });
    requireTrustedPromotion(promotion);
    const manifest = await getFounderExternalBetaManifestForUser(cohortOwnerUserId, now, {
      applicationRevision,
      cohort,
      createConnection: () => connection,
      env: environment,
    });
    if (
      !manifest.complete ||
      manifest.runtimeRevision !== authority.runtimeRevision ||
      manifest.qualifiedCapabilities.length !== FOUNDER_EXTERNAL_BETA_CAPABILITIES.length
    ) {
      throw new Error("The complete exact-candidate External Beta manifest is required.");
    }
    await dependencies.beforeDecisionCommit?.();

    const decisionId = await connection.db.transaction(async (tx) => {
      await lockFounderExternalBetaCohortInTransaction(tx);
      await lockFounderProductContractLifecycleInTransaction(tx, cohortOwnerUserId);
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, cohortOwnerUserId);
      const committedAt = clock();
      const committedAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        cohortOwnerUserId,
      );
      const committedTrustedDecision =
        await getLatestFounderTrustedPreviewStageDecisionInTransaction(tx, cohortOwnerUserId);
      if (
        !committedTrustedDecision ||
        committedTrustedDecision.id !== trustedDecision.id ||
        (committedTrustedDecision.outcome !== "enter" &&
          committedTrustedDecision.outcome !== "resume") ||
        committedTrustedDecision.applicationRevision !== applicationRevision ||
        committedAuthority.operatorId !== authority.operatorId ||
        committedAuthority.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("Trusted Preview authority changed during the External Beta decision.");
      }
      const qualificationDigests = await requireCurrentManifestInTransaction(tx, {
        cohort,
        applicationRevision,
        runtimeRevision: authority.runtimeRevision,
        now: committedAt,
      });
      const [decision] = await tx
        .insert(founderReleaseDecisions)
        .values({
          userId: cohortOwnerUserId,
          operatorId: authority.operatorId,
          stage: "external_beta",
          outcome: "enter",
          applicationRevision,
          runtimeRevision: authority.runtimeRevision,
          capabilityManifest: FOUNDER_EXTERNAL_BETA_CAPABILITIES,
          externalBetaCohort: cohort,
          evidenceDigests: [
            founderProductContractDigest(`clerk:${identity.subject}`),
            founderProductContractDigest(`trusted-preview-decision:${trustedDecision.id}`),
            ...promotion.evidenceDigests,
            ...qualificationDigests,
          ],
          decidedAt: committedAt,
          createdAt: committedAt,
        })
        .returning({ id: founderReleaseDecisions.id });
      if (!decision) throw new Error("External Beta Release Decision could not be persisted.");
      return decision.id;
    });
    return { decisionId, cohort };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function issueFounderExternalBetaInvitation(
  input: {
    cohortOwnerUserId: string;
    invitedClerkSubject: string;
    namedFounder: string;
    workspaceReference: string;
    independenceEvidenceDigest: `sha256:${string}`;
  },
  dependencies: FounderExternalBetaAdmissionDependencies = {},
): Promise<{
  invitationToken: string;
  workspaceReference: string;
  cohortSlot: number;
  expiresAt: string;
}> {
  validateBoundedPlainText(input.invitedClerkSubject, "Founder identity");
  validateBoundedPlainText(input.namedFounder, "Named Founder");
  validateBoundedPlainText(input.workspaceReference, "Workspace reference");
  if (!isEvidenceDigest(input.independenceEvidenceDigest)) {
    throw new Error("Independent-Founder evidence is invalid.");
  }
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("External Beta invitation requires authenticated Clerk release authority.");
  }
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "External Beta application revision is unavailable.",
  );
  const now = dependencies.now?.() ?? new Date();
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderExternalBetaCohortInTransaction(tx);
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, input.cohortOwnerUserId);
      const authority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        input.cohortOwnerUserId,
      );
      const decision = await requireActiveExternalBetaStageDecision(tx, {
        cohortOwnerUserId: input.cohortOwnerUserId,
        applicationRevision,
        runtimeRevision: authority.runtimeRevision,
      });
      const invitedClerkSubjectDigest = founderProductContractDigest(
        `clerk:${input.invitedClerkSubject}`,
      );
      const [owner] = await tx
        .select({ subject: users.clerkUserId })
        .from(users)
        .where(eq(users.id, input.cohortOwnerUserId))
        .limit(1);
      if (
        !owner?.subject ||
        founderProductContractDigest(`clerk:${owner.subject}`) === invitedClerkSubjectDigest
      ) {
        throw new Error("The release authority cannot occupy an independent Founder slot.");
      }
      const existing = await tx
        .select({ slot: founderExternalBetaInvitations.cohortSlot })
        .from(founderExternalBetaInvitations)
        .where(eq(founderExternalBetaInvitations.stageDecisionId, decision.id))
        .orderBy(asc(founderExternalBetaInvitations.cohortSlot));
      const cohortSlot = Array.from({ length: 10 }, (_, index) => index + 1).find(
        (slot) => !existing.some((row) => row.slot === slot),
      );
      if (!cohortSlot) throw new Error("External Beta is limited to ten independent Founders.");
      const invitationToken =
        dependencies.createInvitationToken?.() ?? randomBytes(TOKEN_BYTES).toString("base64url");
      validateInvitationToken(invitationToken);
      const expiresAt = new Date(now.valueOf() + FOUNDER_EXTERNAL_BETA_INVITATION_MS);
      await tx.insert(founderExternalBetaInvitations).values({
        cohortOwnerUserId: input.cohortOwnerUserId,
        stageDecisionId: decision.id,
        cohort: decision.externalBetaCohort,
        cohortSlot,
        invitationDigest: invitationDigest(invitationToken),
        invitedClerkSubjectDigest,
        namedFounderDigest: founderProductContractDigest(
          `external-beta-named-founder:${input.namedFounder}`,
        ),
        workspaceDigest: workspaceDigest(input.workspaceReference),
        independenceEvidenceDigest: input.independenceEvidenceDigest,
        invitedAt: now,
        invitationExpiresAt: expiresAt,
        createdAt: now,
        updatedAt: now,
      });
      return {
        invitationToken,
        workspaceReference: input.workspaceReference,
        cohortSlot,
        expiresAt: expiresAt.toISOString(),
      };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new Error("This Founder or workspace already has an External Beta invitation.");
    }
    throw error;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function admitFounderToExternalBeta(
  userId: string,
  input: {
    invitationToken: string;
    workspaceReference: string;
    compact: FounderExternalBetaCompactAcceptance;
  },
  dependencies: FounderExternalBetaAdmissionDependencies = {},
): Promise<{ accessExpiresAt: string; retirementDueAt: string }> {
  validateInvitationToken(input.invitationToken);
  validateBoundedPlainText(input.workspaceReference, "Workspace reference");
  validateCompact(input.compact);
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("External Beta admission requires an authenticated Clerk session.");
  }
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "External Beta application revision is unavailable.",
  );
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!identity?.subject) throw new Error("External Beta requires a Clerk identity.");
    const authority = await connection.db.transaction((tx) =>
      requireReadyFounderOperatorAuthorityInTransaction(tx, userId),
    );
    await precheckInvitation(connection, {
      userId,
      identitySubject: identity.subject,
      operatorId: authority.operatorId,
      runtimeRevision: authority.runtimeRevision,
      invitationToken: input.invitationToken,
      workspaceReference: input.workspaceReference,
      applicationRevision,
      now,
    });
    const provider = dependencies.createProvider
      ? dependencies.createProvider()
      : createEncryptedFounderRecoveryArchiveProvider();
    if (!provider) throw new Error("Recovery Archive provider is unavailable.");
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId, now, applicationRevision },
      provider,
      connection,
      clock,
    );

    return await connection.db.transaction(async (tx) => {
      await lockFounderExternalBetaCohortInTransaction(tx);
      await lockFounderProductContractLifecycleInTransaction(tx, userId);
      const committedAt = clock();
      const [invitation] = await tx
        .select()
        .from(founderExternalBetaInvitations)
        .where(
          and(
            eq(
              founderExternalBetaInvitations.invitationDigest,
              invitationDigest(input.invitationToken),
            ),
            eq(
              founderExternalBetaInvitations.invitedClerkSubjectDigest,
              founderProductContractDigest(`clerk:${identity.subject}`),
            ),
            eq(
              founderExternalBetaInvitations.workspaceDigest,
              workspaceDigest(input.workspaceReference),
            ),
            eq(founderExternalBetaInvitations.status, "invited"),
            gt(founderExternalBetaInvitations.invitationExpiresAt, committedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!invitation) throw new Error("External Beta invitation is invalid or expired.");
      if (invitation.cohortOwnerUserId === userId) {
        throw new Error("The release authority cannot occupy an independent Founder slot.");
      }
      const committedAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        userId,
      );
      if (
        committedAuthority.operatorId !== authority.operatorId ||
        committedAuthority.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("External Beta workspace authority changed during admission.");
      }
      const stageDecision = await requireActiveExternalBetaStageDecision(tx, {
        cohortOwnerUserId: invitation.cohortOwnerUserId,
        applicationRevision,
      });
      if (
        stageDecision.id !== invitation.stageDecisionId ||
        stageDecision.externalBetaCohort !== invitation.cohort
      ) {
        throw new Error("External Beta invitation does not match the active Release Decision.");
      }
      const qualificationDigests = await requireCurrentManifestInTransaction(tx, {
        cohort: invitation.cohort,
        applicationRevision,
        runtimeRevision: stageDecision.runtimeRevision,
        now: committedAt,
      });
      const [archive] = await tx
        .select({ id: founderRecoveryArchives.id })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.id, archiveId),
            eq(founderRecoveryArchives.userId, userId),
            eq(founderRecoveryArchives.operatorId, authority.operatorId),
            eq(founderRecoveryArchives.applicationRevision, applicationRevision),
            eq(founderRecoveryArchives.runtimeRevision, authority.runtimeRevision),
            eq(founderRecoveryArchives.status, "verified"),
            eq(founderRecoveryArchives.formatVersion, 1),
            eq(founderRecoveryArchives.restorableVerified, true),
            lte(founderRecoveryArchives.observedAt, committedAt),
            gt(
              founderRecoveryArchives.observedAt,
              new Date(committedAt.valueOf() - ARCHIVE_WINDOW_MS),
            ),
            gt(founderRecoveryArchives.expiresAt, committedAt),
          ),
        )
        .limit(1);
      if (!archive) throw new Error("A verified-restorable Recovery Archive is required.");
      const compactDigest = founderProductContractDigest(JSON.stringify(input.compact));
      const accessExpiresAt = new Date(committedAt.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS);
      const retirementDueAt = new Date(
        accessExpiresAt.valueOf() + FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
      );
      const [admissionDecision] = await tx
        .insert(founderReleaseDecisions)
        .values({
          userId,
          operatorId: authority.operatorId,
          stage: "external_beta",
          outcome: "enter",
          applicationRevision,
          runtimeRevision: authority.runtimeRevision,
          capabilityManifest: FOUNDER_EXTERNAL_BETA_CAPABILITIES,
          externalBetaCohort: invitation.cohort,
          evidenceDigests: [
            founderProductContractDigest(`clerk:${identity.subject}`),
            founderProductContractDigest(`external-beta-invitation:${invitation.id}`),
            invitation.namedFounderDigest as `sha256:${string}`,
            invitation.workspaceDigest as `sha256:${string}`,
            invitation.independenceEvidenceDigest as `sha256:${string}`,
            compactDigest,
            founderProductContractDigest(`recovery-archive:${archiveId}`),
            ...qualificationDigests,
          ],
          decidedAt: committedAt,
          createdAt: committedAt,
        })
        .returning({ id: founderReleaseDecisions.id });
      if (!admissionDecision) throw new Error("External Beta admission could not be persisted.");
      const [accepted] = await tx
        .update(founderExternalBetaInvitations)
        .set({
          status: "admitted",
          participantUserId: userId,
          participantOperatorId: authority.operatorId,
          admissionDecisionId: admissionDecision.id,
          betaCompactDigest: compactDigest,
          admittedAt: committedAt,
          accessExpiresAt,
          retirementDueAt,
          updatedAt: committedAt,
        })
        .where(
          and(
            eq(founderExternalBetaInvitations.id, invitation.id),
            eq(founderExternalBetaInvitations.status, "invited"),
          ),
        )
        .returning({ id: founderExternalBetaInvitations.id });
      if (!accepted) throw new Error("External Beta invitation acceptance could not be persisted.");
      return {
        accessExpiresAt: accessExpiresAt.toISOString(),
        retirementDueAt: retirementDueAt.toISOString(),
      };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderExternalBetaStatusForUser(
  userId: string,
  now: Date,
  dependencies: Pick<
    FounderExternalBetaAdmissionDependencies,
    "applicationRevision" | "createConnection"
  > = {},
): Promise<FounderExternalBetaStatus> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await reconcileFounderExternalBetaExpiry(userId, now, { createConnection: () => connection });
    const [membership] = await connection.db
      .select()
      .from(founderExternalBetaInvitations)
      .where(eq(founderExternalBetaInvitations.participantUserId, userId))
      .limit(1);
    if (!membership?.admittedAt || !membership.accessExpiresAt || !membership.retirementDueAt) {
      return { state: "unavailable" };
    }
    const applicationRevision = dependencies.applicationRevision;
    const availableCapabilities =
      membership.status === "admitted" && applicationRevision
        ? await currentParticipantCapabilities(connection, membership, applicationRevision, now)
        : [];
    return {
      state:
        membership.status === "admitted"
          ? "active"
          : membership.status === "withdrawn"
            ? "withdrawn"
            : "expired",
      stage: "External Beta",
      admittedAt: membership.admittedAt.toISOString(),
      accessExpiresAt: membership.accessExpiresAt.toISOString(),
      workStoppedAt:
        membership.status === "withdrawn"
          ? (membership.withdrawnAt?.toISOString() ?? null)
          : membership.status === "expired"
            ? (membership.expiredAt ?? membership.accessExpiresAt).toISOString()
            : null,
      remainingSeconds:
        membership.status === "admitted"
          ? Math.max(0, Math.ceil((membership.accessExpiresAt.valueOf() - now.valueOf()) / 1_000))
          : 0,
      support: "Self-serve onboarding and ordinary use, with reactive support",
      payment: "Free, no card, no renewal, and no automatic paid conversion",
      evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
      availableCapabilities,
      unavailableCapabilities: FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter(
        (capability) => !availableCapabilities.includes(capability),
      ),
      withdrawalAvailable: membership.status === "admitted",
      exportAvailable: true,
      deletionAvailable: true,
      retirementDueAt: membership.retirementDueAt.toISOString(),
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function withdrawFounderFromExternalBeta(
  userId: string,
  now: Date,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<{ retirementDueAt: string }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderExternalBetaCohortInTransaction(tx);
      await lockFounderProductContractLifecycleInTransaction(tx, userId);
      const [membership] = await tx
        .select()
        .from(founderExternalBetaInvitations)
        .where(
          and(
            eq(founderExternalBetaInvitations.participantUserId, userId),
            eq(founderExternalBetaInvitations.status, "admitted"),
          ),
        )
        .limit(1)
        .for("update");
      if (!membership?.participantOperatorId || !membership.accessExpiresAt) {
        throw new Error("Active External Beta access is required.");
      }
      const retirementDueAt = new Date(
        membership.accessExpiresAt.valueOf() + FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
      );
      await tx
        .update(founderExternalBetaInvitations)
        .set({ status: "withdrawn", withdrawnAt: now, updatedAt: now })
        .where(eq(founderExternalBetaInvitations.id, membership.id));
      await pauseExternalBetaWork(tx, membership.participantOperatorId, now);
      return { retirementDueAt: retirementDueAt.toISOString() };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function reconcileFounderExternalBetaExpiry(
  userId: string,
  now: Date,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, userId);
      const [membership] = await tx
        .select()
        .from(founderExternalBetaInvitations)
        .where(
          and(
            eq(founderExternalBetaInvitations.participantUserId, userId),
            eq(founderExternalBetaInvitations.status, "admitted"),
            lte(founderExternalBetaInvitations.accessExpiresAt, now),
          ),
        )
        .limit(1)
        .for("update");
      if (!membership?.participantOperatorId || !membership.accessExpiresAt) return false;
      await tx
        .update(founderExternalBetaInvitations)
        .set({ status: "expired", expiredAt: membership.accessExpiresAt, updatedAt: now })
        .where(eq(founderExternalBetaInvitations.id, membership.id));
      await pauseExternalBetaWork(tx, membership.participantOperatorId, membership.accessExpiresAt);
      return true;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function precheckInvitation(
  connection: DatabaseConnection,
  input: {
    userId: string;
    identitySubject: string;
    operatorId: string;
    runtimeRevision: string;
    invitationToken: string;
    workspaceReference: string;
    applicationRevision: string;
    now: Date;
  },
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(founderExternalBetaInvitations)
      .where(
        and(
          eq(
            founderExternalBetaInvitations.invitationDigest,
            invitationDigest(input.invitationToken),
          ),
          eq(
            founderExternalBetaInvitations.invitedClerkSubjectDigest,
            founderProductContractDigest(`clerk:${input.identitySubject}`),
          ),
          eq(
            founderExternalBetaInvitations.workspaceDigest,
            workspaceDigest(input.workspaceReference),
          ),
          eq(founderExternalBetaInvitations.status, "invited"),
          gt(founderExternalBetaInvitations.invitationExpiresAt, input.now),
        ),
      )
      .limit(1);
    if (!invitation || invitation.cohortOwnerUserId === input.userId) {
      throw new Error("External Beta invitation is invalid or expired.");
    }
    const stageDecision = await requireActiveExternalBetaStageDecision(tx, {
      cohortOwnerUserId: invitation.cohortOwnerUserId,
      applicationRevision: input.applicationRevision,
    });
    if (stageDecision.id !== invitation.stageDecisionId) {
      throw new Error("External Beta invitation does not match the active Release Decision.");
    }
  });
}

async function requireActiveExternalBetaStageDecision(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { cohortOwnerUserId: string; applicationRevision: string; runtimeRevision?: string },
) {
  const [decision] = await tx
    .select({
      id: founderReleaseDecisions.id,
      operatorId: founderReleaseDecisions.operatorId,
      outcome: founderReleaseDecisions.outcome,
      applicationRevision: founderReleaseDecisions.applicationRevision,
      runtimeRevision: founderReleaseDecisions.runtimeRevision,
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
      externalBetaCohort: founderReleaseDecisions.externalBetaCohort,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.cohortOwnerUserId),
        eq(founderReleaseDecisions.stage, "external_beta"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (
    !decision ||
    (decision.outcome !== "enter" && decision.outcome !== "resume") ||
    decision.applicationRevision !== input.applicationRevision ||
    (input.runtimeRevision !== undefined && decision.runtimeRevision !== input.runtimeRevision) ||
    !decision.externalBetaCohort ||
    decision.capabilityManifest.length !== FOUNDER_EXTERNAL_BETA_CAPABILITIES.length ||
    !FOUNDER_EXTERNAL_BETA_CAPABILITIES.every((capability) =>
      decision.capabilityManifest.includes(capability),
    )
  ) {
    throw new Error("An active exact-candidate External Beta Release Decision is required.");
  }
  return { ...decision, externalBetaCohort: decision.externalBetaCohort };
}

async function requireCurrentManifestInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { cohort: string; applicationRevision: string; runtimeRevision: string; now: Date },
): Promise<readonly `sha256:${string}`[]> {
  const rows = await tx
    .select({
      capability: founderPreviewQualifications.capability,
      evidenceDigest: founderPreviewQualifications.evidenceDigest,
      expiresAt: founderPreviewQualifications.expiresAt,
    })
    .from(founderPreviewQualifications)
    .where(
      and(
        eq(founderPreviewQualifications.stage, "external_beta"),
        eq(founderPreviewQualifications.cohort, input.cohort),
        eq(founderPreviewQualifications.applicationRevision, input.applicationRevision),
        eq(founderPreviewQualifications.runtimeRevision, input.runtimeRevision),
        lte(founderPreviewQualifications.observedAt, input.now),
        gt(founderPreviewQualifications.expiresAt, input.now),
      ),
    )
    .orderBy(desc(founderPreviewQualifications.observedAt));
  const selected = FOUNDER_EXTERNAL_BETA_CAPABILITIES.map((capability) =>
    rows.find((row) => row.capability === capability),
  );
  if (
    selected.some((row) => !row) ||
    new Set(selected.map((row) => row?.evidenceDigest)).size !== selected.length
  ) {
    throw new Error("The complete current External Beta manifest is required.");
  }
  return selected.map((row) => row?.evidenceDigest as `sha256:${string}`);
}

async function currentParticipantCapabilities(
  connection: DatabaseConnection,
  membership: typeof founderExternalBetaInvitations.$inferSelect,
  applicationRevision: string,
  now: Date,
): Promise<FounderExternalBetaCapability[]> {
  if (!membership.admissionDecisionId) return [];
  const [decision] = await connection.db
    .select({ runtimeRevision: founderReleaseDecisions.runtimeRevision })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.id, membership.stageDecisionId),
        eq(founderReleaseDecisions.stage, "external_beta"),
        eq(founderReleaseDecisions.applicationRevision, applicationRevision),
      ),
    )
    .limit(1);
  if (!decision) return [];
  const rows = await connection.db
    .select({ capability: founderPreviewQualifications.capability })
    .from(founderPreviewQualifications)
    .where(
      and(
        eq(founderPreviewQualifications.stage, "external_beta"),
        eq(founderPreviewQualifications.cohort, membership.cohort),
        eq(founderPreviewQualifications.applicationRevision, applicationRevision),
        eq(founderPreviewQualifications.runtimeRevision, decision.runtimeRevision),
        lte(founderPreviewQualifications.observedAt, now),
        gt(founderPreviewQualifications.expiresAt, now),
      ),
    );
  const available = new Set(rows.map((row) => row.capability));
  return FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter((capability) => available.has(capability));
}

async function pauseExternalBetaWork(
  tx: FounderProductContractTransaction,
  operatorId: string,
  at: Date,
): Promise<void> {
  await tx
    .update(operators)
    .set({
      externalActionPause: true,
      externalActionPauseReason: EXPIRED_PAUSE_REASON,
      externalActionPausedAt: at,
      updatedAt: at,
    })
    .where(eq(operators.id, operatorId));
}

function requireTrustedPromotion(assessment: FounderTrustedPreviewPromotionAssessment): void {
  if (
    !assessment.promotionEligible ||
    assessment.founderAcceptanceEligible ||
    assessment.automaticPromotion ||
    assessment.completedParticipants < 2
  ) {
    throw new Error("Trusted Preview promotion evidence is incomplete.");
  }
}

function validateCompact(value: FounderExternalBetaCompactAcceptance): void {
  if (
    value.version !== FOUNDER_EXTERNAL_BETA_COMPACT_VERSION ||
    [
      value.instabilityAccepted,
      value.capabilityBoundaryAccepted,
      value.reactiveSupportAccepted,
      value.companyDataHandlingAccepted,
      value.feedbackBoundaryAccepted,
      value.withdrawalExportDeletionAccepted,
      value.freeNonconvertingBoundaryAccepted,
    ].some((accepted) => accepted !== true)
  ) {
    throw new Error("The complete Beta Compact must be accepted before access.");
  }
}

function invitationDigest(token: string): `sha256:${string}` {
  return founderProductContractDigest(`external-beta-invitation-token:${token}`);
}

function workspaceDigest(reference: string): `sha256:${string}` {
  return founderProductContractDigest(`external-beta-workspace:${reference}`);
}

function validateInvitationToken(token: string): void {
  if (token.trim() !== token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("External Beta invitation token is invalid.");
  }
}

function validateBoundedPlainText(value: string, label: string): void {
  if (value.trim() !== value || value.length < 1 || value.length > 200) {
    throw new Error(`${label} is invalid.`);
  }
}

function parseEvidence(raw: string | undefined, unavailableMessage: string): unknown {
  if (!raw?.trim()) throw new Error(unavailableMessage);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(unavailableMessage);
  }
}

function isCohort(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "23505") return true;
  return "cause" in error && isUniqueViolation((error as { cause?: unknown }).cause);
}
