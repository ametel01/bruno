import "server-only";

import { and, desc, eq, gt, lte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderRecoveryArchives,
  founderReleaseDecisions,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import type { FounderProductContractTransaction } from "./operator-authority";

const OWNER_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;
const OWNER_PREVIEW_CAPABILITIES = ["openai", "calendar_reading"] as const;

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
): Promise<{ admitted: boolean }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return {
      admitted: await hasFounderOwnerPreviewAccessInTransaction(connection.db, {
        userId,
        now,
        applicationRevision:
          dependencies.applicationRevision ??
          dependencies.env?.VERCEL_GIT_COMMIT_SHA?.trim() ??
          process.env.VERCEL_GIT_COMMIT_SHA?.trim() ??
          "",
      }),
    };
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
): Promise<void> {
  const access = await getFounderOwnerPreviewAccessForUser(userId, now, dependencies);
  if (!access.admitted) throw new FounderReleaseStageAccessError();
}

export async function requireFounderOwnerPreviewAccessInTransaction(
  tx: FounderProductContractTransaction,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<void> {
  if (!(await hasFounderOwnerPreviewAccessInTransaction(tx, input))) {
    throw new FounderReleaseStageAccessError();
  }
}

export async function hasFounderOwnerPreviewAccessInTransaction(
  tx: Pick<FounderProductContractTransaction, "select">,
  input: { userId: string; now: Date; applicationRevision: string },
): Promise<boolean> {
  if (!/^[a-f0-9]{40}$/.test(input.applicationRevision)) return false;
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
  if (!authority?.runtimeRevision) return false;

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
  if (
    !latestDecision ||
    (latestDecision.outcome !== "enter" && latestDecision.outcome !== "resume") ||
    latestDecision.operatorId !== authority.operatorId ||
    latestDecision.applicationRevision !== input.applicationRevision ||
    latestDecision.runtimeRevision !== authority.runtimeRevision ||
    latestDecision.capabilityManifest.length !== OWNER_PREVIEW_CAPABILITIES.length ||
    !OWNER_PREVIEW_CAPABILITIES.every((capability) =>
      latestDecision.capabilityManifest.includes(capability),
    )
  ) {
    return false;
  }

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
  return Boolean(archive);
}
