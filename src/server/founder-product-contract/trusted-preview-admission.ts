import "server-only";

import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, inArray, lte, ne } from "drizzle-orm";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchives,
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
  users,
} from "@/src/server/db/schema";
import { evaluateFounderGoogleCalendarRelease } from "@/src/server/operators/founder-google-reading-release";
import { evaluateFounderOpenAiRelease } from "@/src/server/operators/founder-openai-release";
import { requireFounderApplicationRevision } from "./application-revision";
import { founderProductContractDigest } from "./digest";
import { createEncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import {
  assessFounderOwnerPreviewPromotionEvidenceAgainstDecision,
  assessFounderOwnerPreviewPromotionEvidenceForUser,
} from "./owner-preview-promotion";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";
import { getFounderOwnerPreviewAccessInTransaction } from "./release-stage-access";
import {
  FOUNDER_TRUSTED_PREVIEW_CAPABILITIES,
  requireFounderTrustedPreviewQualifications,
} from "./trusted-preview-qualification";
import {
  getLatestFounderTrustedPreviewStageDecisionInTransaction,
  lockFounderTrustedPreviewCohortInTransaction,
  persistQualifiedFounderTrustedPreviewStageDecisionInTransaction,
  requireFounderTrustedPreviewCohortOwnerInTransaction,
} from "./trusted-preview-release-decision";

const TRUSTED_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const TRUSTED_PREVIEW_INVITATION_TOKEN_BYTES = 32;

export type FounderTrustedPreviewAdmissionDependencies = {
  applicationRevision?: string;
  createConnection?: () => DatabaseConnection;
  createProvider?: () => FounderRecoveryArchiveProvider | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  beforeDecisionCommit?: () => Promise<void>;
};

export async function enterFounderTrustedPreviewStage(
  cohortOwnerUserId: string,
  dependencies: FounderTrustedPreviewAdmissionDependencies = {},
): Promise<{ decisionId: string }> {
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("Trusted Preview requires an authenticated Clerk release authority.");
  }
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "Trusted Preview application revision is unavailable.",
  );
  const promotionEvidenceRaw = environment.BRUNO_OWNER_PREVIEW_PROMOTION_EVIDENCE?.trim();
  if (!promotionEvidenceRaw) {
    throw new Error("Owner Preview promotion evidence is unavailable.");
  }
  let promotionEvidence: unknown;
  try {
    promotionEvidence = JSON.parse(promotionEvidenceRaw);
  } catch {
    throw new Error("Owner Preview promotion evidence is invalid.");
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, cohortOwnerUserId))
      .limit(1);
    if (!identity?.subject) throw new Error("Trusted Preview requires a Clerk identity.");
    const authority = await connection.db.transaction(async (tx) => {
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, cohortOwnerUserId);
      return requireReadyFounderOperatorAuthorityInTransaction(tx, cohortOwnerUserId);
    });
    const ownerAccess = await connection.db.transaction((tx) =>
      getFounderOwnerPreviewAccessInTransaction(tx, {
        userId: cohortOwnerUserId,
        now,
        applicationRevision,
      }),
    );
    if (
      !ownerAccess.admitted ||
      !FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.every((capability) =>
        ownerAccess.availableCapabilities.includes(capability),
      )
    ) {
      throw new Error("Owner Preview must remain qualified before Trusted Preview can enter.");
    }
    const openAIQualification = evaluateFounderOpenAiRelease(environment, now);
    const calendarQualification = evaluateFounderGoogleCalendarRelease(environment, now);
    if (!openAIQualification.released || !calendarQualification.released) {
      throw new Error("Trusted Preview provider qualification is unavailable.");
    }
    requireFounderTrustedPreviewQualifications(
      {
        cohortOwnerUserId,
        operatorId: authority.operatorId,
        applicationRevision,
        runtimeRevision: authority.runtimeRevision,
        now,
      },
      environment,
    );
    const promotion = await assessFounderOwnerPreviewPromotionEvidenceForUser({
      value: promotionEvidence,
      ownerUserId: cohortOwnerUserId,
      applicationRevision,
      runtimeRevision: authority.runtimeRevision,
      observedAt: now,
      createConnection: () => connection,
    });
    if (!promotion.promotionEligible || promotion.founderAcceptanceEligible) {
      throw new Error("Owner Preview promotion evidence is incomplete.");
    }
    await dependencies.beforeDecisionCommit?.();
    const decisionId = await connection.db.transaction(async (tx) => {
      await lockFounderTrustedPreviewCohortInTransaction(tx);
      await lockFounderProductContractLifecycleInTransaction(tx, cohortOwnerUserId);
      const committedAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        cohortOwnerUserId,
      );
      if (
        committedAuthority.operatorId !== authority.operatorId ||
        committedAuthority.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("Trusted Preview release authority changed during the decision.");
      }
      const committedAt = clock();
      const committedOwnerAccess = await getFounderOwnerPreviewAccessInTransaction(tx, {
        userId: cohortOwnerUserId,
        now: committedAt,
        applicationRevision,
      });
      if (
        !committedOwnerAccess.admitted ||
        !FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.every((capability) =>
          committedOwnerAccess.availableCapabilities.includes(capability),
        )
      ) {
        throw new Error("Owner Preview must remain qualified before Trusted Preview can enter.");
      }
      const [committedOwnerDecision] = await tx
        .select({
          id: founderReleaseDecisions.id,
          operatorId: founderReleaseDecisions.operatorId,
          applicationRevision: founderReleaseDecisions.applicationRevision,
          runtimeRevision: founderReleaseDecisions.runtimeRevision,
          decidedAt: founderReleaseDecisions.decidedAt,
        })
        .from(founderReleaseDecisions)
        .where(
          and(
            eq(founderReleaseDecisions.userId, cohortOwnerUserId),
            eq(founderReleaseDecisions.stage, "owner_preview"),
            inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
          ),
        )
        .orderBy(desc(founderReleaseDecisions.decidedAt))
        .limit(1);
      if (
        !committedOwnerDecision ||
        committedOwnerDecision.applicationRevision !== applicationRevision ||
        committedOwnerDecision.runtimeRevision !== committedAuthority.runtimeRevision ||
        committedOwnerDecision.operatorId !== committedAuthority.operatorId
      ) {
        throw new Error("Owner Preview promotion evidence is incomplete.");
      }
      const committedPromotion = assessFounderOwnerPreviewPromotionEvidenceAgainstDecision({
        value: promotionEvidence,
        ownerUserId: cohortOwnerUserId,
        operatorId: committedOwnerDecision.operatorId,
        applicationRevision,
        runtimeRevision: committedAuthority.runtimeRevision,
        activeDecisionId: committedOwnerDecision.id,
        activePeriodStartedAt: committedOwnerDecision.decidedAt,
        observedAt: committedAt,
      });
      if (!committedPromotion.promotionEligible || committedPromotion.founderAcceptanceEligible) {
        throw new Error("Owner Preview promotion evidence is incomplete.");
      }
      const committedQualifications = requireFounderTrustedPreviewQualifications(
        {
          cohortOwnerUserId,
          operatorId: authority.operatorId,
          applicationRevision,
          runtimeRevision: authority.runtimeRevision,
          now: committedAt,
        },
        environment,
      );
      return persistQualifiedFounderTrustedPreviewStageDecisionInTransaction(tx, {
        cohortOwnerUserId,
        operatorId: authority.operatorId,
        applicationRevision,
        runtimeRevision: authority.runtimeRevision,
        qualificationObservedAt: new Date(
          Math.min(
            ...committedQualifications.map((qualification) =>
              new Date(qualification.qualifiedAt).valueOf(),
            ),
          ),
        ),
        qualificationExpiresAt: qualificationExpiry(committedQualifications),
        qualificationEvidenceDigests: committedQualifications.map(
          (qualification) => qualification.evidenceDigest,
        ),
        promotionEvidenceDigests: committedPromotion.evidenceDigests,
        identityEvidenceDigest: founderProductContractDigest(`clerk:${identity.subject}`),
        decidedAt: committedAt,
      });
    });
    return { decisionId };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function issueFounderTrustedPreviewInvitation(
  input: {
    cohortOwnerUserId: string;
    invitedClerkSubject: string;
    serviceBusinessEvidenceDigest: `sha256:${string}`;
  },
  dependencies: FounderTrustedPreviewAdmissionDependencies & {
    createInvitationToken?: () => string;
  } = {},
): Promise<{ invitationToken: string; cohortSlot: 1 | 2 | 3 }> {
  if (
    !input.invitedClerkSubject.trim() ||
    input.invitedClerkSubject.trim() !== input.invitedClerkSubject ||
    !isEvidenceDigest(input.serviceBusinessEvidenceDigest)
  ) {
    throw new Error("Trusted Preview invitation evidence is invalid.");
  }
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("Trusted Preview invitation requires authenticated Clerk release authority.");
  }
  const now = dependencies.now?.() ?? new Date();
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "Trusted Preview application revision is unavailable.",
  );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await requireFounderTrustedPreviewCohortOwnerInTransaction(tx, input.cohortOwnerUserId);
      await lockFounderTrustedPreviewCohortInTransaction(tx);
      const authority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        input.cohortOwnerUserId,
      );
      const [cohortOwnerIdentity] = await tx
        .select({ subject: users.clerkUserId })
        .from(users)
        .where(eq(users.id, input.cohortOwnerUserId))
        .limit(1);
      if (!cohortOwnerIdentity?.subject) {
        throw new Error("Trusted Preview requires a Clerk release authority.");
      }
      const stageDecision = await requireActiveTrustedPreviewStageDecision(
        tx,
        input.cohortOwnerUserId,
        applicationRevision,
        now,
      );
      if (
        stageDecision.operatorId !== authority.operatorId ||
        stageDecision.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("Trusted Preview Release Decision no longer matches Owner authority.");
      }
      const invitedClerkSubjectDigest = founderProductContractDigest(
        `clerk:${input.invitedClerkSubject}`,
      );
      if (
        invitedClerkSubjectDigest ===
        founderProductContractDigest(`clerk:${cohortOwnerIdentity.subject}`)
      ) {
        throw new Error("The Bruno.Ai Owner cannot occupy a trusted-contact cohort slot.");
      }
      const existingInvitations = await tx
        .select({
          slot: founderTrustedPreviewInvitations.cohortSlot,
          clerkSubjectDigest: founderTrustedPreviewInvitations.invitedClerkSubjectDigest,
        })
        .from(founderTrustedPreviewInvitations)
        .where(ne(founderTrustedPreviewInvitations.status, "revoked"));
      if (
        existingInvitations.some(
          (invitation) => invitation.clerkSubjectDigest === invitedClerkSubjectDigest,
        )
      ) {
        throw new Error("This trusted contact already has a cohort invitation.");
      }
      const cohortSlot = ([1, 2, 3] as const).find(
        (slot) => !existingInvitations.some((invitation) => invitation.slot === slot),
      );
      if (!cohortSlot) throw new Error("Trusted Preview is limited to three contacts.");
      const invitationToken =
        dependencies.createInvitationToken?.() ??
        randomBytes(TRUSTED_PREVIEW_INVITATION_TOKEN_BYTES).toString("base64url");
      validateInvitationToken(invitationToken);
      await tx.insert(founderTrustedPreviewInvitations).values({
        cohortOwnerUserId: input.cohortOwnerUserId,
        stageDecisionId: stageDecision.id,
        cohortSlot,
        invitationDigest: trustedPreviewInvitationDigest(invitationToken),
        invitedClerkSubjectDigest,
        serviceBusinessEvidenceDigest: input.serviceBusinessEvidenceDigest,
        invitedAt: now,
        createdAt: now,
      });
      return { invitationToken, cohortSlot };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function admitFounderToTrustedPreview(
  userId: string,
  invitationToken: string,
  dependencies: FounderTrustedPreviewAdmissionDependencies = {},
): Promise<{ archiveId: string; cohortSlot: 1 | 2 | 3 }> {
  validateInvitationToken(invitationToken);
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
  const environment = dependencies.env ?? process.env;
  if (resolveAuthMode(environment).mode !== "clerk") {
    throw new Error("Trusted Preview admission requires an authenticated Clerk session.");
  }
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "Trusted Preview application revision is unavailable.",
  );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!identity?.subject) throw new Error("Trusted Preview requires a Clerk identity.");
    const authority = await connection.db.transaction((tx) =>
      requireReadyFounderOperatorAuthorityInTransaction(tx, userId),
    );
    await connection.db.transaction(async (tx) => {
      const [invitation] = await tx
        .select({
          cohortOwnerUserId: founderTrustedPreviewInvitations.cohortOwnerUserId,
          stageDecisionId: founderTrustedPreviewInvitations.stageDecisionId,
        })
        .from(founderTrustedPreviewInvitations)
        .where(
          and(
            eq(
              founderTrustedPreviewInvitations.invitationDigest,
              trustedPreviewInvitationDigest(invitationToken),
            ),
            eq(
              founderTrustedPreviewInvitations.invitedClerkSubjectDigest,
              founderProductContractDigest(`clerk:${identity.subject}`),
            ),
            eq(founderTrustedPreviewInvitations.status, "invited"),
          ),
        )
        .limit(1);
      if (!invitation) {
        throw new Error("Trusted Preview requires a valid invitation for this Clerk identity.");
      }
      if (userId === invitation.cohortOwnerUserId) {
        throw new Error("The Bruno.Ai Owner cannot be admitted as a trusted contact.");
      }
      const stageDecision = await requireActiveTrustedPreviewStageDecision(
        tx,
        invitation.cohortOwnerUserId,
        applicationRevision,
        now,
      );
      const cohortOwnerAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        invitation.cohortOwnerUserId,
      );
      if (
        stageDecision.id !== invitation.stageDecisionId ||
        stageDecision.operatorId !== cohortOwnerAuthority.operatorId ||
        stageDecision.runtimeRevision !== cohortOwnerAuthority.runtimeRevision
      ) {
        throw new Error("Trusted Preview invitation does not match current release authority.");
      }
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
    const cohortSlot = await connection.db.transaction(async (tx) => {
      await lockFounderTrustedPreviewCohortInTransaction(tx);
      const [invitation] = await tx
        .select()
        .from(founderTrustedPreviewInvitations)
        .where(
          and(
            eq(
              founderTrustedPreviewInvitations.invitationDigest,
              trustedPreviewInvitationDigest(invitationToken),
            ),
            eq(
              founderTrustedPreviewInvitations.invitedClerkSubjectDigest,
              founderProductContractDigest(`clerk:${identity.subject}`),
            ),
            eq(founderTrustedPreviewInvitations.status, "invited"),
          ),
        )
        .limit(1)
        .for("update");
      if (!invitation) {
        throw new Error("Trusted Preview requires a valid invitation for this Clerk identity.");
      }
      if (userId === invitation.cohortOwnerUserId) {
        throw new Error("The Bruno.Ai Owner cannot be admitted as a trusted contact.");
      }
      const stageDecision = await requireActiveTrustedPreviewStageDecision(
        tx,
        invitation.cohortOwnerUserId,
        applicationRevision,
        clock(),
      );
      const cohortOwnerAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        invitation.cohortOwnerUserId,
      );
      if (
        stageDecision.operatorId !== cohortOwnerAuthority.operatorId ||
        stageDecision.runtimeRevision !== cohortOwnerAuthority.runtimeRevision
      ) {
        throw new Error("Trusted Preview Release Decision no longer matches Owner authority.");
      }
      if (stageDecision.id !== invitation.stageDecisionId) {
        throw new Error("Trusted Preview invitation does not match the active Release Decision.");
      }
      const committedAuthority = await requireReadyFounderOperatorAuthorityInTransaction(
        tx,
        userId,
      );
      if (
        committedAuthority.operatorId !== authority.operatorId ||
        committedAuthority.runtimeRevision !== authority.runtimeRevision
      ) {
        throw new Error("Trusted Preview participant authority changed during admission.");
      }
      const committedAt = clock();
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
              new Date(committedAt.valueOf() - TRUSTED_PREVIEW_ARCHIVE_WINDOW_MS),
            ),
            gt(founderRecoveryArchives.expiresAt, committedAt),
          ),
        )
        .limit(1);
      if (!archive) throw new Error("A verified-restorable Recovery Archive is required.");
      const [decision] = await tx
        .insert(founderReleaseDecisions)
        .values({
          userId,
          operatorId: authority.operatorId,
          stage: "trusted_preview",
          outcome: "enter",
          applicationRevision,
          runtimeRevision: authority.runtimeRevision,
          capabilityManifest: FOUNDER_TRUSTED_PREVIEW_CAPABILITIES,
          openAiQualificationExpiresAt: stageDecision.openAiQualificationExpiresAt,
          calendarQualificationExpiresAt: stageDecision.calendarQualificationExpiresAt,
          evidenceDigests: [
            founderProductContractDigest(`clerk:${identity.subject}`),
            founderProductContractDigest(`trusted-preview-invitation:${invitation.id}`),
            invitation.serviceBusinessEvidenceDigest,
            founderProductContractDigest(`trusted-preview-stage-decision:${stageDecision.id}`),
            founderProductContractDigest(`recovery-archive:${archiveId}`),
          ],
          decidedAt: committedAt,
          createdAt: committedAt,
        })
        .returning({ id: founderReleaseDecisions.id });
      if (!decision) throw new Error("Trusted Preview admission decision could not be persisted.");
      const [accepted] = await tx
        .update(founderTrustedPreviewInvitations)
        .set({
          status: "admitted",
          participantUserId: userId,
          participantOperatorId: authority.operatorId,
          admissionDecisionId: decision.id,
          admittedAt: committedAt,
        })
        .where(
          and(
            eq(founderTrustedPreviewInvitations.id, invitation.id),
            eq(founderTrustedPreviewInvitations.status, "invited"),
          ),
        )
        .returning({ cohortSlot: founderTrustedPreviewInvitations.cohortSlot });
      if (!accepted || !isCohortSlot(accepted.cohortSlot)) {
        throw new Error("Trusted Preview invitation acceptance could not be persisted.");
      }
      return accepted.cohortSlot;
    });
    return { archiveId, cohortSlot };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function requireActiveTrustedPreviewStageDecision(
  tx: FounderProductContractTransaction,
  cohortOwnerUserId: string,
  applicationRevision: string,
  now: Date,
) {
  const decision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
    tx,
    cohortOwnerUserId,
  );
  if (
    !decision ||
    (decision.outcome !== "enter" && decision.outcome !== "resume") ||
    decision.applicationRevision !== applicationRevision ||
    decision.capabilityManifest.length !== FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.length ||
    !FOUNDER_TRUSTED_PREVIEW_CAPABILITIES.every((capability) =>
      decision.capabilityManifest.includes(capability),
    ) ||
    !decision.openAiQualificationExpiresAt ||
    decision.openAiQualificationExpiresAt <= now ||
    !decision.calendarQualificationExpiresAt ||
    decision.calendarQualificationExpiresAt <= now
  ) {
    throw new Error("An active exact-revision Trusted Preview Release Decision is required.");
  }
  return decision;
}

function qualificationExpiry(
  qualifications: readonly {
    capability: "openai" | "calendar_reading";
    expiresAt: string;
  }[],
): Readonly<Record<"openai" | "calendar_reading", Date>> {
  const openAI = qualifications.find((qualification) => qualification.capability === "openai");
  const calendar = qualifications.find(
    (qualification) => qualification.capability === "calendar_reading",
  );
  if (!openAI || !calendar) throw new Error("Trusted Preview Qualifications are incomplete.");
  return { openai: new Date(openAI.expiresAt), calendar_reading: new Date(calendar.expiresAt) };
}

function trustedPreviewInvitationDigest(token: string): `sha256:${string}` {
  return founderProductContractDigest(`trusted-preview-invitation-token:${token}`);
}

function validateInvitationToken(token: string): void {
  if (token.trim() !== token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    throw new Error("Trusted Preview invitation token is invalid.");
  }
}

function isEvidenceDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function isCohortSlot(value: number): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}
