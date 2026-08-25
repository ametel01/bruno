import "server-only";

import { desc, eq, sql } from "drizzle-orm";
import { FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST } from "@/scripts/create-founder-general-release-decision";
import {
  FOUNDER_GENERAL_RELEASE_DECISION_ENV,
  REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
  type FounderGeneralReleaseCapability,
  type FounderGeneralReleaseDecisionAuthority,
  readFounderGeneralReleaseDecisionAuthority,
} from "@/scripts/founder-general-release-decision-authority";
import { isGitRevision, isRuntimeRevision } from "@/scripts/founder-release-evidence-validation";
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

type FounderGeneralReleaseEvidenceKey = (typeof REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS)[number];
const FOUNDER_GENERAL_RELEASE_AUTHORITY_LOCK = "founder-initial-general-release-authority-v1";

export { FOUNDER_GENERAL_RELEASE_DECISION_ENV };
export type { FounderGeneralReleaseCapability };

const REQUIRED_FRESH_RESUME_EVIDENCE_KEYS_BY_CAPABILITY = {
  openai: REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
  anthropic: REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
  calendar_reading: REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
  gmail_reading: REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
  gmail_sending: REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS,
} satisfies Record<FounderGeneralReleaseCapability, readonly FounderGeneralReleaseEvidenceKey[]>;

export type FounderGeneralReleaseAuthority = FounderGeneralReleaseDecisionAuthority & {
  decisionId: string | null;
  decisionOutcome: "enter" | "deny" | "hold" | "resume" | null;
  capabilities: Record<FounderGeneralReleaseCapability, "available" | "paused">;
  heldCapabilities: FounderGeneralReleaseCapability[];
};

export function readFounderGeneralReleaseAuthority(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): FounderGeneralReleaseAuthority {
  const capabilities = currentCapabilityStates(env, now);
  const decision = readFounderGeneralReleaseDecisionAuthority(env, now);
  return {
    ...decision,
    decisionId: null,
    decisionOutcome: decision.approved ? "enter" : null,
    capabilities,
    heldCapabilities: decision.approved
      ? FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.filter(
          (capability) => capabilities[capability] === "paused",
        )
      : [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
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
  let decisionSourceRevision = decision.applicationRevision;
  let decisionRuntimeRevision = decision.runtimeRevision;
  let decisionDigest = decision.evidenceDigests[0] as `sha256:${string}`;
  let decisionDecidedAt = decision.decidedAt;
  let decisionAuthorityExpiresAt: Date | null = decision.authorityExpiresAt;
  let evidenceDigests = decision.evidenceDigests as `sha256:${string}`[];
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
    decisionSourceRevision = hold.applicationRevision;
    decisionRuntimeRevision = hold.runtimeRevision;
    decisionDigest = holdDigest;
    decisionDecidedAt = hold.decidedAt;
    decisionAuthorityExpiresAt = hold.authorityExpiresAt;
    evidenceDigests = hold.evidenceDigests as `sha256:${string}`[];
  }
  return {
    approved: true,
    reason: "approved",
    sourceRevision: decisionSourceRevision,
    runtimeRevision: decisionRuntimeRevision,
    decisionDigest,
    decisionId,
    decisionOutcome,
    decisionDecidedAt: decisionDecidedAt.toISOString(),
    authorityExpiresAt: decisionAuthorityExpiresAt?.toISOString() ?? null,
    evidenceDigests,
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
          affectedCapabilities: founderReleaseDecisions.affectedCapabilities,
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
        (latest.evidenceDigests.includes(parsed.decisionDigest as `sha256:${string}`) ||
          !heldCapabilitiesHaveFreshCompleteEvidence(
            latest.affectedCapabilities,
            latest.evidenceDigests,
            parsed.evidenceDigests,
          ))
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

function heldCapabilitiesHaveFreshCompleteEvidence(
  affectedCapabilities: readonly unknown[],
  retainedEvidenceDigests: readonly string[],
  candidateEvidenceDigests: `sha256:${string}`[],
): boolean {
  const heldCapabilities = affectedCapabilities.filter(
    (capability): capability is FounderGeneralReleaseCapability =>
      typeof capability === "string" &&
      FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST.includes(
        capability as FounderGeneralReleaseCapability,
      ),
  );
  if (heldCapabilities.length === 0) return false;
  const candidateByKey = Object.fromEntries(
    REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS.map((key, index) => [
      key,
      candidateEvidenceDigests[index],
    ]),
  ) as Record<FounderGeneralReleaseEvidenceKey, `sha256:${string}`>;
  return heldCapabilities.every((capability) =>
    REQUIRED_FRESH_RESUME_EVIDENCE_KEYS_BY_CAPABILITY[capability].every(
      (key) => !retainedEvidenceDigests.includes(candidateByKey[key]),
    ),
  );
}

async function lockFounderGeneralReleaseAuthorityInTransaction(
  tx: FounderProductContractTransaction,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${FOUNDER_GENERAL_RELEASE_AUTHORITY_LOCK}, 0))`,
  );
}
