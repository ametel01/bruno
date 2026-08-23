import "server-only";

import { createHash } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import {
  FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST,
  FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA,
} from "@/scripts/create-founder-general-release-decision";
import {
  isEvidenceDigest,
  isEvidenceRecord,
  isExactInstant,
  isGitRevision,
  isRuntimeRevision,
} from "@/scripts/founder-release-evidence-validation";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderReleaseDecisions } from "@/src/server/db/schema";
import { isFounderAnthropicReleased } from "@/src/server/operators/founder-anthropic-release";
import { isFounderGoogleMailSendingReleased } from "@/src/server/operators/founder-google-mail-sending-release";
import {
  isFounderGoogleCalendarReleased,
  isFounderGoogleMailReadingReleased,
} from "@/src/server/operators/founder-google-reading-release";
import { isFounderOpenAiReleased } from "@/src/server/operators/founder-openai-release";
import { founderProductContractDigest } from "./digest";
import type { FounderProductContractTransaction } from "./operator-authority";
import { requireFounderOwnerPreviewOwnerMappingInTransaction } from "./owner-preview-release-decision";

export const FOUNDER_GENERAL_RELEASE_DECISION_ENV = "BRUNO_INITIAL_GENERAL_RELEASE_DECISION";
const REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS = [
  "productContractDigest",
  "voiceOverDigest",
  "talkBackDigest",
  "moderatedFounderDigest",
  "providerDecisionDigest",
  "productionProviderQualificationDigest",
  "operationalDigest",
  "privacyDigest",
  "billingDigest",
  "recoveryDigest",
  "retirementDigest",
] as const;
const FOUNDER_GENERAL_RELEASE_AUTHORITY_LOCK = "founder-initial-general-release-authority-v1";

export type FounderGeneralReleaseCapability =
  (typeof FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST)[number];

export type FounderGeneralReleaseAuthority = {
  approved: boolean;
  reason:
    | "approved"
    | "decision_missing"
    | "decision_invalid"
    | "decision_denied"
    | "application_revision_mismatch"
    | "runtime_revision_mismatch"
    | "decision_stale";
  sourceRevision: string | null;
  runtimeRevision: string | null;
  decisionDigest: `sha256:${string}` | null;
  decisionId: string | null;
  decisionOutcome: "enter" | "deny" | "hold" | "resume" | null;
  decisionDecidedAt: string | null;
  authorityExpiresAt: string | null;
  evidenceDigests: `sha256:${string}`[];
  capabilities: Record<FounderGeneralReleaseCapability, "available" | "paused">;
  heldCapabilities: FounderGeneralReleaseCapability[];
};

export function readFounderGeneralReleaseAuthority(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): FounderGeneralReleaseAuthority {
  const capabilities = currentCapabilityStates(env, now);
  const raw = env[FOUNDER_GENERAL_RELEASE_DECISION_ENV]?.trim();
  if (!raw) return deniedAuthority("decision_missing", capabilities);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return deniedAuthority("decision_invalid", capabilities);
  }
  if (!isEvidenceRecord(value)) return deniedAuthority("decision_invalid", capabilities);
  if (
    value.schemaVersion !== FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA ||
    value.stage !== "initial_general_release" ||
    !Array.isArray(value.capabilityManifest) ||
    !sameCapabilityManifest(value.capabilityManifest) ||
    !isEvidenceRecord(value.releaseIdentity) ||
    !isGitRevision(value.releaseIdentity.sourceRevision) ||
    !isRuntimeRevision(value.releaseIdentity.runtimeRevision) ||
    !isExactInstant(value.releaseIdentity.decidedAt) ||
    !isExactInstant(value.authorityExpiresAt) ||
    !isEvidenceDigest(value.summaryDigest) ||
    !Array.isArray(value.reasons) ||
    !isEvidenceRecord(value.evidence) ||
    !requiredEvidenceDigestsPresent(value.evidence)
  ) {
    return deniedAuthority("decision_invalid", capabilities);
  }
  const { summaryDigest, ...payload } = value;
  const expectedDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")}`;
  if (summaryDigest !== expectedDigest) return deniedAuthority("decision_invalid", capabilities);
  if (value.outcome !== "approved" || value.reasons.length !== 0) {
    return deniedAuthority("decision_denied", capabilities);
  }
  const deployedRevision = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (
    !isGitRevision(deployedRevision) ||
    deployedRevision !== value.releaseIdentity.sourceRevision
  ) {
    return deniedAuthority("application_revision_mismatch", capabilities);
  }
  const runtimeRevision = env.BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION?.trim();
  if (
    !isRuntimeRevision(runtimeRevision) ||
    runtimeRevision !== value.releaseIdentity.runtimeRevision
  ) {
    return deniedAuthority("runtime_revision_mismatch", capabilities);
  }
  const decidedAt = new Date(value.releaseIdentity.decidedAt);
  const expiresAt = new Date(value.authorityExpiresAt);
  if (decidedAt > now || expiresAt <= now) {
    return deniedAuthority("decision_stale", capabilities);
  }
  const retainedEvidence = value.evidence as Record<string, unknown>;
  const evidenceDigests = REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS.map(
    (key) => retainedEvidence[key] as `sha256:${string}`,
  );
  if (new Set([summaryDigest, ...evidenceDigests]).size !== evidenceDigests.length + 1) {
    return deniedAuthority("decision_invalid", capabilities);
  }
  return {
    approved: true,
    reason: "approved",
    sourceRevision: value.releaseIdentity.sourceRevision,
    runtimeRevision: value.releaseIdentity.runtimeRevision,
    decisionDigest: summaryDigest,
    decisionId: null,
    decisionOutcome: "enter",
    decisionDecidedAt: value.releaseIdentity.decidedAt,
    authorityExpiresAt: value.authorityExpiresAt,
    evidenceDigests,
    capabilities,
    heldCapabilities: FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.filter(
      (capability) => capabilities[capability] === "paused",
    ),
  };
}

function currentCapabilityStates(
  env: Record<string, string | undefined>,
  now: Date,
): FounderGeneralReleaseAuthority["capabilities"] {
  return {
    openai: isFounderOpenAiReleased(env, now) ? "available" : "paused",
    anthropic: isFounderAnthropicReleased(env, now) ? "available" : "paused",
    calendar_reading: isFounderGoogleCalendarReleased(env, now) ? "available" : "paused",
    gmail_reading: isFounderGoogleMailReadingReleased(env, now) ? "available" : "paused",
    gmail_sending: isFounderGoogleMailSendingReleased(env, now) ? "available" : "paused",
  };
}

function deniedAuthority(
  reason: Exclude<FounderGeneralReleaseAuthority["reason"], "approved">,
  capabilities: FounderGeneralReleaseAuthority["capabilities"],
): FounderGeneralReleaseAuthority {
  return {
    approved: false,
    reason,
    sourceRevision: null,
    runtimeRevision: null,
    decisionDigest: null,
    decisionId: null,
    decisionOutcome: null,
    decisionDecidedAt: null,
    authorityExpiresAt: null,
    evidenceDigests: [],
    capabilities,
    heldCapabilities: [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
  };
}

export async function readPersistedFounderGeneralReleaseAuthorityInTransaction(
  tx: FounderProductContractTransaction,
  env: Record<string, string | undefined>,
  now: Date,
  options: { reconcileHold?: boolean } = {},
): Promise<FounderGeneralReleaseAuthority> {
  await lockFounderGeneralReleaseAuthorityInTransaction(tx);
  const capabilities = currentCapabilityStates(env, now);
  const [decision] = await tx
    .select()
    .from(founderReleaseDecisions)
    .where(eq(founderReleaseDecisions.stage, "initial_general_release"))
    .orderBy(desc(founderReleaseDecisions.decidedAt), desc(founderReleaseDecisions.createdAt))
    .limit(1)
    .for("update");
  if (!decision) return deniedAuthority("decision_missing", capabilities);
  const sourceRevision = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (!isGitRevision(sourceRevision) || decision.applicationRevision !== sourceRevision) {
    return deniedAuthority("application_revision_mismatch", capabilities);
  }
  const runtimeRevision = env.BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION?.trim();
  if (!isRuntimeRevision(runtimeRevision) || decision.runtimeRevision !== runtimeRevision) {
    return deniedAuthority("runtime_revision_mismatch", capabilities);
  }
  if (decision.outcome === "deny") return deniedAuthority("decision_denied", capabilities);
  if (!decision.authorityExpiresAt || decision.authorityExpiresAt <= now) {
    return deniedAuthority("decision_stale", capabilities);
  }
  const dynamicHolds = FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.filter(
    (capability) => capabilities[capability] === "paused",
  );
  const retainedHolds =
    decision.outcome === "hold"
      ? (decision.affectedCapabilities.filter((capability) =>
          FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.includes(
            capability as FounderGeneralReleaseCapability,
          ),
        ) as FounderGeneralReleaseCapability[])
      : [];
  const heldCapabilities = FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.filter(
    (capability) => retainedHolds.includes(capability) || dynamicHolds.includes(capability),
  );
  let decisionId = decision.id;
  let decisionOutcome = decision.outcome;
  let decisionDigest = decision.evidenceDigests[0] as `sha256:${string}`;
  const holdChanged =
    heldCapabilities.length !== retainedHolds.length ||
    heldCapabilities.some((capability) => !retainedHolds.includes(capability));
  if (options.reconcileHold && heldCapabilities.length > 0 && holdChanged) {
    const holdDecidedAt =
      now <= decision.decidedAt ? new Date(decision.decidedAt.valueOf() + 1) : now;
    const holdDigest = founderProductContractDigest(
      JSON.stringify({
        kind: "initial_general_release_capability_hold",
        priorDecisionId: decision.id,
        applicationRevision: decision.applicationRevision,
        runtimeRevision: decision.runtimeRevision,
        affectedCapabilities: heldCapabilities,
        observedAt: holdDecidedAt.toISOString(),
      }),
    );
    const [hold] = await tx
      .insert(founderReleaseDecisions)
      .values({
        stage: "initial_general_release",
        outcome: "hold",
        applicationRevision: decision.applicationRevision,
        runtimeRevision: decision.runtimeRevision,
        capabilityManifest: [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
        affectedCapabilities: heldCapabilities,
        evidenceDigests: [holdDigest, ...decision.evidenceDigests],
        authorityExpiresAt: decision.authorityExpiresAt,
        decidedAt: holdDecidedAt,
      })
      .returning();
    if (!hold) throw new Error("Initial General Release Hold could not be persisted.");
    decisionId = hold.id;
    decisionOutcome = "hold";
    decisionDigest = holdDigest;
  }
  return {
    approved: true,
    reason: "approved",
    sourceRevision: decision.applicationRevision,
    runtimeRevision: decision.runtimeRevision,
    decisionDigest,
    decisionId,
    decisionOutcome,
    decisionDecidedAt: decision.decidedAt.toISOString(),
    authorityExpiresAt: decision.authorityExpiresAt.toISOString(),
    evidenceDigests: decision.evidenceDigests as `sha256:${string}`[],
    capabilities: Object.fromEntries(
      FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.map((capability) => [
        capability,
        heldCapabilities.includes(capability) ? "paused" : capabilities[capability],
      ]),
    ) as FounderGeneralReleaseAuthority["capabilities"],
    heldCapabilities,
  };
}

export async function persistProtectedFounderGeneralReleaseDecisionForOwner(
  ownerUserId: string,
  rawDecision: string,
  dependencies: {
    createConnection?: () => DatabaseConnection;
    env: Record<string, string | undefined>;
    now: Date;
  },
): Promise<string> {
  const parsed = readFounderGeneralReleaseAuthority(
    { ...dependencies.env, [FOUNDER_GENERAL_RELEASE_DECISION_ENV]: rawDecision },
    dependencies.now,
  );
  if (
    !parsed.approved ||
    !parsed.sourceRevision ||
    !parsed.runtimeRevision ||
    !parsed.authorityExpiresAt
  ) {
    throw new Error("The protected Initial General Release Decision is not approved and current.");
  }
  if (parsed.heldCapabilities.length > 0) {
    throw new Error("Every Initial General Release capability must be currently qualified.");
  }
  const sourceRevision = parsed.sourceRevision;
  const runtimeRevision = parsed.runtimeRevision;
  const authorityExpiresAt = parsed.authorityExpiresAt;
  const decisionDecidedAt = parsed.decisionDecidedAt;
  if (!decisionDecidedAt) {
    throw new Error("The protected Initial General Release Decision has no decision time.");
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      await lockFounderGeneralReleaseAuthorityInTransaction(tx);
      await requireFounderOwnerPreviewOwnerMappingInTransaction(tx, ownerUserId, true);
      const [latest] = await tx
        .select({
          id: founderReleaseDecisions.id,
          outcome: founderReleaseDecisions.outcome,
          applicationRevision: founderReleaseDecisions.applicationRevision,
          runtimeRevision: founderReleaseDecisions.runtimeRevision,
          evidenceDigests: founderReleaseDecisions.evidenceDigests,
          authorityExpiresAt: founderReleaseDecisions.authorityExpiresAt,
          decidedAt: founderReleaseDecisions.decidedAt,
        })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.stage, "initial_general_release"))
        .orderBy(desc(founderReleaseDecisions.decidedAt))
        .limit(1)
        .for("update");
      if (
        latest &&
        ["enter", "resume"].includes(latest.outcome) &&
        latest.applicationRevision === sourceRevision &&
        latest.runtimeRevision === runtimeRevision &&
        latest.authorityExpiresAt?.toISOString() === authorityExpiresAt &&
        latest.evidenceDigests.includes(parsed.decisionDigest as `sha256:${string}`)
      ) {
        return latest.id;
      }
      const artifactDecidedAt = new Date(decisionDecidedAt);
      if (latest && artifactDecidedAt <= latest.decidedAt) {
        throw new Error(
          latest.outcome === "hold"
            ? "A Hold requires a fresh complete Initial General Release Decision."
            : "The protected Initial General Release Decision is not newer than current authority.",
        );
      }
      if (
        latest?.outcome === "hold" &&
        latest.evidenceDigests.includes(parsed.decisionDigest as `sha256:${string}`)
      ) {
        throw new Error("A Hold requires a fresh complete Initial General Release Decision.");
      }
      const [persisted] = await tx
        .insert(founderReleaseDecisions)
        .values({
          stage: "initial_general_release",
          outcome: latest?.outcome === "hold" ? "resume" : "enter",
          applicationRevision: sourceRevision,
          runtimeRevision,
          capabilityManifest: [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
          evidenceDigests: [parsed.decisionDigest as `sha256:${string}`, ...parsed.evidenceDigests],
          authorityExpiresAt: new Date(authorityExpiresAt),
          decidedAt: artifactDecidedAt,
        })
        .returning({ id: founderReleaseDecisions.id });
      if (!persisted) throw new Error("Initial General Release Decision could not be persisted.");
      return persisted.id;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function lockFounderGeneralReleaseAuthorityInTransaction(
  tx: FounderProductContractTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${FOUNDER_GENERAL_RELEASE_AUTHORITY_LOCK}, 0))`,
  );
}

function sameCapabilityManifest(value: unknown[]): boolean {
  return (
    value.length === FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.length &&
    FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.every((capability) => value.includes(capability))
  );
}

function requiredEvidenceDigestsPresent(value: Record<string, unknown>): boolean {
  return (
    Object.keys(value).length === REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS.length &&
    REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS.every((key) => isEvidenceDigest(value[key]))
  );
}
