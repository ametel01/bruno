import "server-only";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import type { AuthModeDecision } from "@/src/auth/auth-mode";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { readFounderApplicationRevision } from "./application-revision";
import type { FounderProductContractTransaction } from "./operator-authority";
import {
  FOUNDER_OWNER_PREVIEW_CAPABILITIES,
  type FounderOwnerPreviewCapability,
  type FounderOwnerPreviewCapabilityRequirement,
} from "./preview-qualification";
import { reconcileFounderOwnerPreviewQualificationExpiryInTransaction } from "./release-stage-hold";

const OWNER_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type FounderOwnerPreviewAccess = {
  admitted: boolean;
  availableCapabilities: readonly FounderOwnerPreviewCapability[];
};

export type FounderOwnerPreviewAccessRequirement =
  | "workspace"
  | FounderOwnerPreviewCapabilityRequirement;

export function requiresFounderReleaseStageAuthority(mode: AuthModeDecision["mode"]): boolean {
  return mode !== "development";
}

export class FounderReleaseStageAccessError extends Error {
  readonly code = "owner_preview_access_required" as const;
  readonly status = 403 as const;

  constructor() {
    super(
      "An active exact-revision Owner Preview admission and current Recovery Archive are required.",
    );
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
  if (requirement === "workspace") {
    const access = await getFounderOwnerPreviewAccessForUser(userId, now, dependencies);
    if (!access.admitted) throw new FounderReleaseStageAccessError();
    return;
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const applicationRevision = readFounderApplicationRevision(dependencies) ?? "";
    const access = await connection.db.transaction(async (tx) => {
      await reconcileFounderOwnerPreviewQualificationExpiryInTransaction(tx, {
        userId,
        now,
        applicationRevision,
      });
      return getFounderOwnerPreviewAccessInTransaction(tx, { userId, now, applicationRevision });
    });
    if (!requirementsAvailable(access.availableCapabilities, requirement)) {
      throw new FounderReleaseStageAccessError();
    }
  } finally {
    if (ownsConnection) await connection.close();
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
    throw new FounderReleaseStageAccessError();
  }
}

export async function getFounderOwnerPreviewAccessInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<FounderOwnerPreviewAccess> {
  const unavailable = { admitted: false, availableCapabilities: [] } as const;
  if (!/^[a-f0-9]{40}$/.test(input.applicationRevision)) return unavailable;
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
