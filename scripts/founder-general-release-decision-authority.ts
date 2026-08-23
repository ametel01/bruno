import { createHash } from "node:crypto";
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

export const FOUNDER_GENERAL_RELEASE_DECISION_ENV = "BRUNO_INITIAL_GENERAL_RELEASE_DECISION";

export const REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS = [
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

export type FounderGeneralReleaseCapability =
  (typeof FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST)[number];

export type FounderGeneralReleaseDecisionAuthority = {
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
  decisionDecidedAt: string | null;
  authorityExpiresAt: string | null;
  evidenceDigests: `sha256:${string}`[];
};

export function readFounderGeneralReleaseDecisionAuthority(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): FounderGeneralReleaseDecisionAuthority {
  const raw = env[FOUNDER_GENERAL_RELEASE_DECISION_ENV]?.trim();
  if (!raw) return deniedDecisionAuthority("decision_missing");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return deniedDecisionAuthority("decision_invalid");
  }
  if (!isEvidenceRecord(value)) return deniedDecisionAuthority("decision_invalid");
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
    return deniedDecisionAuthority("decision_invalid");
  }
  const { summaryDigest, ...payload } = value;
  const expectedDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")}`;
  if (summaryDigest !== expectedDigest) return deniedDecisionAuthority("decision_invalid");
  if (value.outcome !== "approved" || value.reasons.length !== 0) {
    return deniedDecisionAuthority("decision_denied");
  }
  const deployedRevision = env.VERCEL_GIT_COMMIT_SHA?.trim();
  if (
    !isGitRevision(deployedRevision) ||
    deployedRevision !== value.releaseIdentity.sourceRevision
  ) {
    return deniedDecisionAuthority("application_revision_mismatch");
  }
  const runtimeRevision = env.BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION?.trim();
  if (
    !isRuntimeRevision(runtimeRevision) ||
    runtimeRevision !== value.releaseIdentity.runtimeRevision
  ) {
    return deniedDecisionAuthority("runtime_revision_mismatch");
  }
  const decidedAt = new Date(value.releaseIdentity.decidedAt);
  const expiresAt = new Date(value.authorityExpiresAt);
  if (decidedAt > now || expiresAt <= now) {
    return deniedDecisionAuthority("decision_stale");
  }
  const retainedEvidence = value.evidence as Record<string, unknown>;
  const evidenceDigests = REQUIRED_GENERAL_RELEASE_EVIDENCE_KEYS.map(
    (key) => retainedEvidence[key] as `sha256:${string}`,
  );
  if (new Set([summaryDigest, ...evidenceDigests]).size !== evidenceDigests.length + 1) {
    return deniedDecisionAuthority("decision_invalid");
  }
  return {
    approved: true,
    reason: "approved",
    sourceRevision: value.releaseIdentity.sourceRevision,
    runtimeRevision: value.releaseIdentity.runtimeRevision,
    decisionDigest: summaryDigest,
    decisionDecidedAt: value.releaseIdentity.decidedAt,
    authorityExpiresAt: value.authorityExpiresAt,
    evidenceDigests,
  };
}

function deniedDecisionAuthority(
  reason: Exclude<FounderGeneralReleaseDecisionAuthority["reason"], "approved">,
): FounderGeneralReleaseDecisionAuthority {
  return {
    approved: false,
    reason,
    sourceRevision: null,
    runtimeRevision: null,
    decisionDigest: null,
    decisionDecidedAt: null,
    authorityExpiresAt: null,
    evidenceDigests: [],
  };
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
