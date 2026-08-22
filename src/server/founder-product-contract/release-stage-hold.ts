import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { founderReleaseDecisions } from "@/src/server/db/schema";
import type { FounderProductContractTransaction } from "./operator-authority";
import {
  FOUNDER_OWNER_PREVIEW_CAPABILITIES,
  type FounderOwnerPreviewCapability,
} from "./preview-qualification";

export async function persistFounderOwnerPreviewHoldInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    userId: string;
    operatorId: string;
    applicationRevision: string;
    runtimeRevision: string;
    affectedCapabilities: readonly FounderOwnerPreviewCapability[];
    evidenceDigests: readonly `sha256:${string}`[];
    decidedAt: Date;
  },
): Promise<string | null> {
  if (
    !/^[a-f0-9]{40}$/.test(input.applicationRevision) ||
    !input.runtimeRevision.trim() ||
    input.affectedCapabilities.length === 0 ||
    new Set(input.affectedCapabilities).size !== input.affectedCapabilities.length ||
    input.evidenceDigests.length === 0 ||
    !input.evidenceDigests.every((digest) => /^sha256:[a-f0-9]{64}$/.test(digest))
  ) {
    throw new Error("Owner Preview Hold evidence is invalid.");
  }

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
  if (!latestDecision || latestDecision.outcome === "deny") return null;
  if (
    latestDecision.applicationRevision !== input.applicationRevision ||
    latestDecision.runtimeRevision !== input.runtimeRevision ||
    input.decidedAt <= latestDecision.decidedAt
  ) {
    return null;
  }
  if (
    latestDecision.capabilityManifest.length !== FOUNDER_OWNER_PREVIEW_CAPABILITIES.length ||
    !FOUNDER_OWNER_PREVIEW_CAPABILITIES.every((capability) =>
      latestDecision.capabilityManifest.includes(capability),
    )
  ) {
    throw new Error("Owner Preview Hold requires a complete admitted capability manifest.");
  }
  const affectedCapabilities =
    latestDecision.outcome === "hold"
      ? FOUNDER_OWNER_PREVIEW_CAPABILITIES.filter(
          (capability) =>
            latestDecision.affectedCapabilities.includes(capability) ||
            input.affectedCapabilities.includes(capability),
        )
      : input.affectedCapabilities;
  if (
    latestDecision.outcome === "hold" &&
    affectedCapabilities.length === latestDecision.affectedCapabilities.length
  ) {
    return latestDecision.id;
  }

  const [hold] = await tx
    .insert(founderReleaseDecisions)
    .values({
      userId: input.userId,
      operatorId: input.operatorId,
      stage: "owner_preview",
      outcome: "hold",
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      capabilityManifest: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
      affectedCapabilities,
      evidenceDigests: input.evidenceDigests,
      decidedAt: input.decidedAt,
      createdAt: input.decidedAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!hold) throw new Error("Owner Preview Hold could not be persisted.");
  return hold.id;
}
