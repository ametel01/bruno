import "server-only";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type { AuthModeDecision } from "@/src/auth/auth-mode";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  appMetadata,
  founderRecoveryArchives,
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { readFounderApplicationRevision } from "./application-revision";
import type { FounderProductContractTransaction } from "./operator-authority";
import { FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY } from "./owner-preview-release-decision";
import {
  FOUNDER_OWNER_PREVIEW_CAPABILITIES,
  type FounderOwnerPreviewCapability,
  type FounderOwnerPreviewCapabilityRequirement,
} from "./preview-qualification";
import { reconcileFounderOwnerPreviewQualificationExpiryInTransaction } from "./release-stage-hold";
import {
  getFounderTrustedPreviewCohortOwnerIdInTransaction,
  getLatestFounderTrustedPreviewStageDecisionInTransaction,
  reconcileFounderTrustedPreviewQualificationExpiryInTransaction,
} from "./trusted-preview-release-decision";

const OWNER_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type FounderOwnerPreviewAccess = {
  admitted: boolean;
  availableCapabilities: readonly FounderOwnerPreviewCapability[];
  stage?: "owner_preview" | "trusted_preview" | null;
  cohortSlot?: 1 | 2 | 3;
};

export type FounderOwnerPreviewAccessRequirement =
  | "workspace"
  | "workspace_with_mail"
  | FounderOwnerPreviewCapabilityRequirement;

export function requiresFounderReleaseStageAuthority(mode: AuthModeDecision["mode"]): boolean {
  return mode !== "development";
}

export class FounderReleaseStageAccessError extends Error {
  readonly code: "owner_preview_access_required" | "trusted_preview_access_required";
  readonly status = 403 as const;

  constructor(stage: "owner_preview" | "trusted_preview" = "owner_preview") {
    super(
      stage === "trusted_preview"
        ? "Trusted Preview is unavailable until Clerk identity, invitation admission, exact-revision authority, and current Recovery Archive protection are verified."
        : "Owner Preview is unavailable until exact-revision admission and current Recovery Archive protection are verified.",
    );
    this.code =
      stage === "trusted_preview"
        ? "trusted_preview_access_required"
        : "owner_preview_access_required";
    this.name = "FounderReleaseStageAccessError";
  }
}

export async function getFounderOwnerPreviewAccessForUser(
  userId: string,
  now: Date,
  dependencies: {
    applicationRevision?: string;
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<FounderOwnerPreviewAccess> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await getFounderOwnerPreviewAccessInTransaction(connection.db, {
      userId,
      now,
      applicationRevision: readFounderApplicationRevision(dependencies) ?? "",
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function requireFounderOwnerPreviewAccessForUser(
  userId: string,
  now: Date,
  dependencies: {
    applicationRevision?: string;
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
  requirement: FounderOwnerPreviewAccessRequirement,
): Promise<void> {
  if (requirement === "workspace" || requirement === "workspace_with_mail") {
    const access = await getFounderOwnerPreviewAccessForUser(userId, now, dependencies);
    if (!access.admitted) throw new FounderReleaseStageAccessError(access.stage ?? "owner_preview");
    if (requirement === "workspace_with_mail" && access.stage === "trusted_preview") {
      throw new FounderReleaseStageAccessError("trusted_preview");
    }
    return;
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const applicationRevision = readFounderApplicationRevision(dependencies) ?? "";
    const access = await connection.db.transaction(async (tx) => {
      await reconcileFounderPreviewQualificationExpiryInTransaction(tx, {
        userId,
        now,
        applicationRevision,
      });
      return getFounderOwnerPreviewAccessInTransaction(tx, { userId, now, applicationRevision });
    });
    if (!requirementsAvailable(access.availableCapabilities, requirement)) {
      throw new FounderReleaseStageAccessError(access.stage ?? "owner_preview");
    }
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function reconcileFounderPreviewQualificationExpiryInTransaction(
  tx: FounderProductContractTransaction,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<void> {
  const cohortOwnerUserId = await getFounderTrustedPreviewCohortOwnerIdInTransaction(tx);
  if (cohortOwnerUserId === input.userId) {
    await reconcileFounderOwnerPreviewQualificationExpiryInTransaction(tx, input);
  } else if (cohortOwnerUserId) {
    await reconcileFounderTrustedPreviewQualificationExpiryInTransaction(tx, {
      cohortOwnerUserId,
      now: input.now,
      applicationRevision: input.applicationRevision,
    });
  }
}

export async function requireFounderOwnerPreviewAccessInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    userId: string;
    now: Date;
    applicationRevision: string;
    requiredCapabilities: FounderOwnerPreviewCapabilityRequirement;
  },
): Promise<void> {
  const access = await getFounderOwnerPreviewAccessInTransaction(tx, input);
  if (!requirementsAvailable(access.availableCapabilities, input.requiredCapabilities)) {
    throw new FounderReleaseStageAccessError(access.stage ?? "owner_preview");
  }
}

export async function getFounderOwnerPreviewAccessInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<FounderOwnerPreviewAccess> {
  const unavailable = { admitted: false, availableCapabilities: [] } as const;
  if (!/^[a-f0-9]{40}$/.test(input.applicationRevision)) return unavailable;
  const [ownerMapping] = await tx
    .select({ userId: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY))
    .limit(1);
  if (ownerMapping?.userId !== input.userId) {
    if (!ownerMapping) return unavailable;
    return getFounderTrustedPreviewAccessInTransaction(tx, {
      ...input,
      cohortOwnerUserId: ownerMapping.userId,
    });
  }
  const [authority] = await tx
    .select({
      operatorId: operators.id,
      runtimeStatus: operatorRuntimes.status,
      runtimeRevision: operatorRuntimes.configRevision,
    })
    .from(operators)
    .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
    .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
    .limit(1);
  if (!authority?.runtimeRevision) return unavailable;

  const [latestDecision] = await tx
    .select({
      operatorId: founderReleaseDecisions.operatorId,
      outcome: founderReleaseDecisions.outcome,
      applicationRevision: founderReleaseDecisions.applicationRevision,
      runtimeRevision: founderReleaseDecisions.runtimeRevision,
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
      affectedCapabilities: founderReleaseDecisions.affectedCapabilities,
      openAiQualificationExpiresAt: founderReleaseDecisions.openAiQualificationExpiresAt,
      calendarQualificationExpiresAt: founderReleaseDecisions.calendarQualificationExpiresAt,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  const [priorAdmission] = await tx
    .select({ capabilityManifest: founderReleaseDecisions.capabilityManifest })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, authority.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
        eq(founderReleaseDecisions.applicationRevision, input.applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, authority.runtimeRevision),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  const exactDecision = (decision: typeof latestDecision) => {
    if (!decision) return false;
    return (
      decision.operatorId === authority.operatorId &&
      decision.applicationRevision === input.applicationRevision &&
      decision.runtimeRevision === authority.runtimeRevision &&
      decision.capabilityManifest.length === FOUNDER_OWNER_PREVIEW_CAPABILITIES.length &&
      FOUNDER_OWNER_PREVIEW_CAPABILITIES.every((capability) =>
        decision.capabilityManifest.includes(capability),
      )
    );
  };
  if (
    !priorAdmission ||
    priorAdmission.capabilityManifest.length !== FOUNDER_OWNER_PREVIEW_CAPABILITIES.length ||
    !FOUNDER_OWNER_PREVIEW_CAPABILITIES.every((capability) =>
      priorAdmission.capabilityManifest.includes(capability),
    )
  ) {
    return unavailable;
  }
  const [archive] = await tx
    .select({ id: founderRecoveryArchives.id })
    .from(founderRecoveryArchives)
    .where(
      and(
        eq(founderRecoveryArchives.userId, input.userId),
        eq(founderRecoveryArchives.operatorId, authority.operatorId),
        eq(founderRecoveryArchives.applicationRevision, input.applicationRevision),
        eq(founderRecoveryArchives.runtimeRevision, authority.runtimeRevision),
        eq(founderRecoveryArchives.status, "verified"),
        eq(founderRecoveryArchives.formatVersion, 1),
        eq(founderRecoveryArchives.restorableVerified, true),
        lte(founderRecoveryArchives.observedAt, input.now),
        gt(
          founderRecoveryArchives.observedAt,
          new Date(input.now.valueOf() - OWNER_PREVIEW_ARCHIVE_WINDOW_MS),
        ),
        gt(founderRecoveryArchives.expiresAt, input.now),
      ),
    )
    .orderBy(desc(founderRecoveryArchives.observedAt))
    .limit(1);
  if (
    authority.runtimeStatus !== "ready" ||
    !archive ||
    !latestDecision ||
    !exactDecision(latestDecision)
  ) {
    return { admitted: true, availableCapabilities: [] };
  }
  if (latestDecision.outcome === "enter" || latestDecision.outcome === "resume") {
    return {
      admitted: true,
      availableCapabilities: latestDecision.capabilityManifest.filter(
        (capability): capability is FounderOwnerPreviewCapability =>
          isFounderOwnerPreviewCapability(capability) &&
          priorAdmission.capabilityManifest.includes(capability) &&
          qualificationIsCurrent(latestDecision, capability, input.now),
      ),
    };
  }
  if (latestDecision.outcome === "hold") {
    return {
      admitted: true,
      availableCapabilities: priorAdmission.capabilityManifest.filter(
        (capability): capability is FounderOwnerPreviewCapability =>
          isFounderOwnerPreviewCapability(capability) &&
          !latestDecision.affectedCapabilities.includes(capability) &&
          qualificationIsCurrent(latestDecision, capability, input.now),
      ),
    };
  }
  return { admitted: true, availableCapabilities: [] };
}

async function getFounderTrustedPreviewAccessInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: {
    userId: string;
    cohortOwnerUserId: string;
    now: Date;
    applicationRevision: string;
  },
): Promise<FounderOwnerPreviewAccess> {
  const unavailable = {
    admitted: false,
    availableCapabilities: [],
    stage: "trusted_preview",
  } as const;
  const [membership] = await tx
    .select({
      operatorId: founderTrustedPreviewInvitations.participantOperatorId,
      admissionDecisionId: founderTrustedPreviewInvitations.admissionDecisionId,
      cohortSlot: founderTrustedPreviewInvitations.cohortSlot,
    })
    .from(founderTrustedPreviewInvitations)
    .where(
      and(
        eq(founderTrustedPreviewInvitations.cohortOwnerUserId, input.cohortOwnerUserId),
        eq(founderTrustedPreviewInvitations.participantUserId, input.userId),
        eq(founderTrustedPreviewInvitations.status, "admitted"),
      ),
    )
    .limit(1);
  if (
    !membership?.operatorId ||
    !membership.admissionDecisionId ||
    !isCohortSlot(membership.cohortSlot)
  ) {
    return unavailable;
  }
  const [participantAuthority] = await tx
    .select({
      operatorId: operators.id,
      runtimeStatus: operatorRuntimes.status,
      runtimeRevision: operatorRuntimes.configRevision,
    })
    .from(operators)
    .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
    .where(
      and(
        eq(operators.userId, input.userId),
        eq(operators.id, membership.operatorId),
        eq(operators.status, "active"),
      ),
    )
    .limit(1);
  if (!participantAuthority?.runtimeRevision) return unavailable;
  const [participantDecision] = await tx
    .select({
      id: founderReleaseDecisions.id,
      outcome: founderReleaseDecisions.outcome,
      applicationRevision: founderReleaseDecisions.applicationRevision,
      runtimeRevision: founderReleaseDecisions.runtimeRevision,
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.id, membership.admissionDecisionId),
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, membership.operatorId),
        eq(founderReleaseDecisions.stage, "trusted_preview"),
      ),
    )
    .limit(1);
  if (
    !participantDecision ||
    (participantDecision.outcome !== "enter" && participantDecision.outcome !== "resume") ||
    participantDecision.applicationRevision !== input.applicationRevision ||
    participantDecision.runtimeRevision !== participantAuthority.runtimeRevision ||
    participantDecision.capabilityManifest.length !== FOUNDER_OWNER_PREVIEW_CAPABILITIES.length ||
    !FOUNDER_OWNER_PREVIEW_CAPABILITIES.every((capability) =>
      participantDecision.capabilityManifest.includes(capability),
    )
  ) {
    return unavailable;
  }
  const [cohortOwnerAuthority] = await tx
    .select({ operatorId: operators.id, runtimeRevision: operatorRuntimes.configRevision })
    .from(operators)
    .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
    .where(and(eq(operators.userId, input.cohortOwnerUserId), eq(operators.status, "active")))
    .limit(1);
  const stageDecision = await getLatestFounderTrustedPreviewStageDecisionInTransaction(
    tx,
    input.cohortOwnerUserId,
  );
  const [archive] = await tx
    .select({ id: founderRecoveryArchives.id })
    .from(founderRecoveryArchives)
    .where(
      and(
        eq(founderRecoveryArchives.userId, input.userId),
        eq(founderRecoveryArchives.operatorId, membership.operatorId),
        eq(founderRecoveryArchives.applicationRevision, input.applicationRevision),
        eq(founderRecoveryArchives.runtimeRevision, participantAuthority.runtimeRevision),
        eq(founderRecoveryArchives.status, "verified"),
        eq(founderRecoveryArchives.formatVersion, 1),
        eq(founderRecoveryArchives.restorableVerified, true),
        lte(founderRecoveryArchives.observedAt, input.now),
        gt(
          founderRecoveryArchives.observedAt,
          new Date(input.now.valueOf() - OWNER_PREVIEW_ARCHIVE_WINDOW_MS),
        ),
        gt(founderRecoveryArchives.expiresAt, input.now),
      ),
    )
    .orderBy(desc(founderRecoveryArchives.observedAt))
    .limit(1);
  if (
    participantAuthority.runtimeStatus !== "ready" ||
    !archive ||
    !cohortOwnerAuthority?.runtimeRevision ||
    !stageDecision ||
    stageDecision.operatorId !== cohortOwnerAuthority.operatorId ||
    stageDecision.runtimeRevision !== cohortOwnerAuthority.runtimeRevision ||
    stageDecision.applicationRevision !== input.applicationRevision ||
    stageDecision.capabilityManifest.length !== FOUNDER_OWNER_PREVIEW_CAPABILITIES.length ||
    !FOUNDER_OWNER_PREVIEW_CAPABILITIES.every((capability) =>
      stageDecision.capabilityManifest.includes(capability),
    )
  ) {
    return {
      admitted: true,
      availableCapabilities: [],
      stage: "trusted_preview",
      cohortSlot: membership.cohortSlot,
    };
  }
  const availableCapabilities = FOUNDER_OWNER_PREVIEW_CAPABILITIES.filter(
    (capability) =>
      participantDecision.capabilityManifest.includes(capability) &&
      qualificationIsCurrent(stageDecision, capability, input.now) &&
      (stageDecision.outcome === "enter" ||
        stageDecision.outcome === "resume" ||
        (stageDecision.outcome === "hold" &&
          !stageDecision.affectedCapabilities.includes(capability))),
  );
  return {
    admitted: true,
    availableCapabilities,
    stage: "trusted_preview",
    cohortSlot: membership.cohortSlot,
  };
}

function qualificationIsCurrent(
  decision: {
    openAiQualificationExpiresAt: Date | null;
    calendarQualificationExpiresAt: Date | null;
  },
  capability: FounderOwnerPreviewCapability,
  now: Date,
): boolean {
  const expiresAt =
    capability === "openai"
      ? decision.openAiQualificationExpiresAt
      : decision.calendarQualificationExpiresAt;
  return expiresAt !== null && expiresAt > now;
}

function requirementsAvailable(
  availableCapabilities: readonly FounderOwnerPreviewCapability[],
  requiredCapabilities: FounderOwnerPreviewCapabilityRequirement,
): boolean {
  if (requiredCapabilities === "forbidden") return false;
  return (
    requiredCapabilities.length > 0 &&
    requiredCapabilities.every((capability) => availableCapabilities.includes(capability))
  );
}

export function hasFounderOwnerPreviewCapabilities(
  access: FounderOwnerPreviewAccess,
  requiredCapabilities: FounderOwnerPreviewCapabilityRequirement,
): boolean {
  return requirementsAvailable(access.availableCapabilities, requiredCapabilities);
}

function isFounderOwnerPreviewCapability(
  capability: string,
): capability is FounderOwnerPreviewCapability {
  return FOUNDER_OWNER_PREVIEW_CAPABILITIES.some((candidate) => candidate === capability);
}

function isCohortSlot(value: number): value is 1 | 2 | 3 {
  return value === 1 || value === 2 || value === 3;
}
