import { createHash } from "node:crypto";
import {
  FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST,
  FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA,
} from "@/scripts/create-founder-general-release-decision";

/**
 * Exercises the public admission boundary in deterministic tests. This is not
 * attended evidence and is never emitted by the Founder Product Contract.
 */
export function buildDeterministicFounderGeneralReleaseAuthorityFixture(input: {
  sourceRevision: string;
  runtimeRevision: string;
  decidedAt: Date;
}): string {
  const digest = (digit: string) => `sha256:${digit.repeat(64)}`;
  const payload = {
    schemaVersion: FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA,
    stage: "initial_general_release",
    outcome: "approved",
    reasons: [],
    capabilityManifest: [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
    releaseIdentity: {
      sourceRevision: input.sourceRevision,
      runtimeRevision: input.runtimeRevision,
      productContractRunId: "deterministic-contract-fixture",
      decidedAt: input.decidedAt.toISOString(),
    },
    evidence: {
      productContractDigest: digest("0"),
      voiceOverDigest: digest("1"),
      talkBackDigest: digest("2"),
      moderatedFounderDigest: digest("3"),
      providerDecisionDigest: digest("4"),
      productionProviderQualificationDigest: digest("5"),
      operationalDigest: digest("6"),
      privacyDigest: digest("7"),
      billingDigest: digest("8"),
      recoveryDigest: digest("9"),
      retirementDigest: digest("a"),
    },
    authorityExpiresAt: new Date(
      input.decidedAt.valueOf() + 8 * 24 * 60 * 60 * 1_000,
    ).toISOString(),
  };
  return JSON.stringify({
    ...payload,
    summaryDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  });
}
