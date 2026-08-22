import "server-only";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { appMetadata, founderReleaseDecisions } from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
} from "./operator-authority";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "./preview-qualification";

export const FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY = "founder_owner_preview_owner_user_id:v1";

export type FounderOwnerPreviewDenialReason =
  | "identity_unavailable"
  | "owner_mismatch"
  | "provider_gate_unavailable"
  | "preview_qualification_unavailable"
  | "recovery_archive_unavailable"
  | "admission_evidence_incomplete";

export async function requireFounderOwnerPreviewOwnerMappingInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  establish: boolean,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY}, 0))`,
  );
  const [mapping] = await tx
    .select({ userId: appMetadata.value })
    .from(appMetadata)
    .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY))
    .limit(1);
  if (mapping && mapping.userId !== userId) {
    throw new Error("Owner Preview is restricted to the mapped Bruno.Ai Owner.");
  }
  if (!mapping && establish) {
    await tx.insert(appMetadata).values({
      key: FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY,
      value: userId,
    });
  }
}

export async function persistFounderOwnerPreviewDenialInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    userId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    reason: FounderOwnerPreviewDenialReason;
    evidenceDigests?: readonly `sha256:${string}`[];
    decidedAt: Date;
  },
): Promise<string | null> {
  if (
    !/^[a-f0-9]{40}$/.test(input.applicationRevision) ||
    !input.runtimeRevision.trim() ||
    Number.isNaN(input.decidedAt.valueOf()) ||
    !(input.evidenceDigests ?? []).every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error("Owner Preview denial evidence is invalid.");
  }
  await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
  const [activeAdmission] = await tx
    .select({ id: founderReleaseDecisions.id })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, input.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
        eq(founderReleaseDecisions.applicationRevision, input.applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, input.runtimeRevision),
      ),
    )
    .limit(1);
  if (activeAdmission) return null;
  const denialDigest = founderProductContractDigest(
    JSON.stringify({ kind: "owner_preview_admission_denied", reason: input.reason }),
  );
  const evidenceDigests = [...new Set([...(input.evidenceDigests ?? []), denialDigest])];
  const [latestDecision] = await tx
    .select()
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, input.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (
    latestDecision?.outcome === "deny" &&
    latestDecision.applicationRevision === input.applicationRevision &&
    latestDecision.runtimeRevision === input.runtimeRevision &&
    evidenceDigests.every((digest) => latestDecision.evidenceDigests.includes(digest))
  ) {
    return latestDecision.id;
  }
  const decidedAt =
    latestDecision && input.decidedAt <= latestDecision.decidedAt
      ? new Date(latestDecision.decidedAt.valueOf() + 1)
      : input.decidedAt;
  const [decision] = await tx
    .insert(founderReleaseDecisions)
    .values({
      userId: input.userId,
      operatorId: input.operatorId,
      stage: "owner_preview",
      outcome: "deny",
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      capabilityManifest: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
      evidenceDigests,
      decidedAt,
      createdAt: decidedAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!decision) throw new Error("Owner Preview denial could not be persisted.");
  return decision.id;
}
