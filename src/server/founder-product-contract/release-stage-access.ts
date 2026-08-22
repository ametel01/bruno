import "server-only";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import type { FounderProductContractTransaction } from "./operator-authority";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "./preview-qualification";

const OWNER_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;

export type FounderOwnerPreviewAccess = {
  admitted: boolean;
  workAllowed: boolean;
};

export type FounderOwnerPreviewAccessRequirement = "workspace" | "work";

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
      applicationRevision:
        dependencies.applicationRevision ??
        dependencies.env?.VERCEL_GIT_COMMIT_SHA?.trim() ??
        process.env.VERCEL_GIT_COMMIT_SHA?.trim() ??
        "",
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
  requirement: FounderOwnerPreviewAccessRequirement = "work",
): Promise<void> {
  const access = await getFounderOwnerPreviewAccessForUser(userId, now, dependencies);
  if (requirement === "workspace" ? !access.admitted : !access.workAllowed) {
    throw new FounderReleaseStageAccessError();
  }
}

export async function requireFounderOwnerPreviewAccessInTransaction(
  tx: FounderProductContractTransaction,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<void> {
  if (!(await getFounderOwnerPreviewAccessInTransaction(tx, input)).workAllowed) {
    throw new FounderReleaseStageAccessError();
  }
}

export async function getFounderOwnerPreviewAccessInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<FounderOwnerPreviewAccess> {
  const unavailable = { admitted: false, workAllowed: false } as const;
  if (!/^[a-f0-9]{40}$/.test(input.applicationRevision)) return unavailable;
  const [authority] = await tx
    .select({
      operatorId: operators.id,
      runtimeRevision: operatorRuntimes.configRevision,
    })
    .from(operators)
    .innerJoin(
      operatorRuntimes,
      and(eq(operatorRuntimes.operatorId, operators.id), eq(operatorRuntimes.status, "ready")),
    )
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
  const stageActive =
    (latestDecision?.outcome === "enter" || latestDecision?.outcome === "resume") &&
    exactDecision(latestDecision);

  const [archive] = await tx
    .select({ id: founderRecoveryArchives.id })
    .from(founderRecoveryArchives)
    .where(
      and(
        eq(founderRecoveryArchives.userId, input.userId),
        eq(founderRecoveryArchives.operatorId, authority.operatorId),
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
  return { admitted: true, workAllowed: stageActive && Boolean(archive) };
}
