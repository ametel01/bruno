import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { founderReleaseDecisions } from "@/src/server/db/schema";
import { founderProductContractDigest } from "./digest";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
} from "./operator-authority";
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
  await lockFounderProductContractLifecycleInTransaction(tx, input.userId);

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
    (latestDecision.outcome !== "hold" && input.decidedAt <= latestDecision.decidedAt)
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
  const evidenceDigests =
    latestDecision.outcome === "hold"
      ? [...new Set([...latestDecision.evidenceDigests, ...input.evidenceDigests])]
      : input.evidenceDigests;
  if (
    latestDecision.outcome === "hold" &&
    affectedCapabilities.length === latestDecision.affectedCapabilities.length &&
    evidenceDigests.length === latestDecision.evidenceDigests.length
  ) {
    return latestDecision.id;
  }
  if (
    !latestDecision.openAiQualificationExpiresAt ||
    !latestDecision.calendarQualificationExpiresAt
  ) {
    throw new Error("Owner Preview Hold requires persisted qualification expiry.");
  }
  const decidedAt =
    input.decidedAt > latestDecision.decidedAt
      ? input.decidedAt
      : new Date(latestDecision.decidedAt.valueOf() + 1);

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
      openAiQualificationExpiresAt: latestDecision.openAiQualificationExpiresAt,
      calendarQualificationExpiresAt: latestDecision.calendarQualificationExpiresAt,
      affectedCapabilities,
      evidenceDigests,
      decidedAt,
      createdAt: decidedAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!hold) throw new Error("Owner Preview Hold could not be persisted.");
  return hold.id;
}

export async function reconcileFounderOwnerPreviewQualificationExpiryInTransaction(
  tx: FounderProductContractTransaction,
  input: { userId: string; applicationRevision: string; now: Date },
): Promise<string | null> {
  await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
  const [latestDecision] = await tx
    .select()
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
    latestDecision.outcome === "deny" ||
    latestDecision.applicationRevision !== input.applicationRevision
  ) {
    return null;
  }
  const expirations = {
    openai: latestDecision.openAiQualificationExpiresAt,
    calendar_reading: latestDecision.calendarQualificationExpiresAt,
  } as const;
  const affectedCapabilities = FOUNDER_OWNER_PREVIEW_CAPABILITIES.filter((capability) => {
    const expiresAt = expirations[capability];
    return !expiresAt || expiresAt <= input.now;
  });
  if (affectedCapabilities.length === 0 || !latestDecision.operatorId) return null;
  return persistFounderOwnerPreviewHoldInTransaction(tx, {
    userId: input.userId,
    operatorId: latestDecision.operatorId,
    applicationRevision: latestDecision.applicationRevision,
    runtimeRevision: latestDecision.runtimeRevision,
    affectedCapabilities,
    evidenceDigests: affectedCapabilities.map((capability) =>
      founderProductContractDigest(
        JSON.stringify({
          kind: "owner_preview_qualification_expired",
          capability,
          expiresAt: expirations[capability]?.toISOString() ?? null,
        }),
      ),
    ),
    decidedAt: input.now,
  });
}
