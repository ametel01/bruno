import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildFounderInitialGeneralReleaseDecision,
  parseFounderGeneralReleaseOperationalSummary,
  parseFounderModeratedSummary,
  parseFounderProviderDecisionSummary,
} from "@/scripts/create-founder-general-release-decision";
import { createFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  parseFounderProductionProviderLiveTargetAuthority,
  parseFounderProductionProviderQualificationSummary,
} from "@/scripts/create-founder-production-provider-qualification";
import { FOUNDER_PRODUCT_CONTRACT_UNIT_FILES } from "@/src/shared/founder-product-contract";
import { buildDeterministicFounderGeneralReleaseAuthorityFixture } from "@/src/testing/founder-general-release-authority";
import {
  FOUNDER_PRODUCT_CONTRACT_SCENARIO_SIGNING_SECRET_ENV,
  parseFounderProductContractScenarioLedger,
} from "@/src/testing/founder-product-contract";
import { buildTestAnthropicAcceptanceRelease } from "./founder-anthropic-test-release";
import { buildTestGoogleMailSendingAcceptanceRelease } from "./founder-google-mail-sending-test-release";
import { buildTestGoogleConnectedAcceptanceRelease } from "./founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "./founder-openai-test-release";

const artifactDirectory =
  process.env.BRUNO_FOUNDER_CONTRACT_ARTIFACT_DIR ?? "founder-contract-artifacts";
const browserResultPath = join(artifactDirectory, "browser-results.json");
const unitResultPath = join(artifactDirectory, "unit-results.json");
const evidencePath = join(artifactDirectory, "founder-product-contract.json");
const generalReleaseDecisionPath = join(
  artifactDirectory,
  "founder-initial-general-release-decision.json",
);
const mode = process.env.BRUNO_FOUNDER_CONTRACT_MODE === "release" ? "release" : "ci";
const deterministicConnectionSecret = createHash("sha256")
  .update("founder-contract-connection-secret-v1")
  .digest("base64url");

await mkdir(artifactDirectory, { recursive: true });
await rm(evidencePath, { force: true });
await rm(generalReleaseDecisionPath, { force: true });
const sourceRevision = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
const runtimeRevision = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION");
const observedAt = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT");
const runId = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
const providerFailureRunId = `fpct-failure:${createHash("sha256").update(runId).digest("hex")}`;
const runAttempt = requiredPositiveIntegerEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ATTEMPT");
const scenarioSigningSecret = requiredEnvironment(
  FOUNDER_PRODUCT_CONTRACT_SCENARIO_SIGNING_SECRET_ENV,
);
const scenarioLedgerPath = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH");
await rm(browserResultPath, { force: true });
await rm(unitResultPath, { force: true });
await rm(scenarioLedgerPath, { force: true });
const deterministicProviderEnvironment = {
  BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE: "deterministic",
  BRUNO_FOUNDER_CONTRACT_COMMERCE_WEBHOOK_SECRET: "founder-contract-lemon-test-secret-v1",
  BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY: "open",
  BRUNO_INITIAL_GENERAL_RELEASE_GEOGRAPHIES: "PH",
  BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY_MESSAGE:
    "Public contract capacity is available in this geography.",
  BRUNO_INITIAL_GENERAL_RELEASE_PRICE_LABEL: "$30/month",
  BRUNO_INITIAL_GENERAL_RELEASE_DECISION: buildDeterministicFounderGeneralReleaseAuthorityFixture({
    sourceRevision,
    runtimeRevision,
    decidedAt: new Date(observedAt),
  }),
  BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION: runtimeRevision,
  BRUNO_FOUNDER_CONTRACT_IDENTITY_RECOVERY_SIGNING_SECRET:
    "founder-contract-identity-recovery-signing-secret-v1",
  BRUNO_IDENTITY_RECOVERY_SIGNING_SECRET: "founder-contract-identity-recovery-signing-secret-v1",
  CLERK_WEBHOOK_SIGNING_SECRET: `whsec_${createHash("sha256")
    .update("founder-contract-clerk-webhook-signing-secret-v1")
    .digest("base64")}`,
  BRUNO_CONNECTION_SECRET_ACTIVE_KEY_VERSION: "founder-contract-v1",
  BRUNO_CONNECTION_SECRET_KEYS_JSON: JSON.stringify({
    "founder-contract-v1": deterministicConnectionSecret,
  }),
  BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
    "calendar_reading",
    new Date(),
    sourceRevision,
  ),
  BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
    "gmail_reading",
    new Date(),
    sourceRevision,
  ),
  BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE:
    buildTestGoogleMailSendingAcceptanceRelease(new Date(), sourceRevision),
  BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
    new Date(),
    sourceRevision,
  ),
  BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: buildTestAnthropicAcceptanceRelease(
    new Date(),
    sourceRevision,
  ),
  VERCEL_GIT_COMMIT_SHA: sourceRevision,
  BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: scenarioSigningSecret,
  BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH: scenarioLedgerPath,
  BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: sourceRevision,
  BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION: runtimeRevision,
  BRUNO_FOUNDER_CONTRACT_RUN_ID: runId,
  BRUNO_FOUNDER_CONTRACT_OBSERVED_AT: observedAt,
};

await run(
  [
    "bun",
    "--conditions",
    "react-server",
    "node_modules/.bin/vitest",
    "run",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${unitResultPath}`,
    ...FOUNDER_PRODUCT_CONTRACT_UNIT_FILES,
  ],
  deterministicProviderEnvironment,
);

await run(
  [
    "node_modules/.bin/playwright",
    "test",
    "tests/e2e/founder-product-contract-failure.spec.ts",
    "--config=playwright.founder-contract-lifecycle.config.ts",
  ],
  {
    ...deterministicProviderEnvironment,
    BRUNO_FOUNDER_CONTRACT_RUN_ID: providerFailureRunId,
  },
);

await run(
  [
    "node_modules/.bin/playwright",
    "test",
    "tests/e2e/founder-product-contract-lifecycle.spec.ts",
    "--config=playwright.founder-contract-lifecycle.config.ts",
  ],
  deterministicProviderEnvironment,
);

await run(
  [
    "node_modules/.bin/playwright",
    "test",
    "tests/e2e/founder-product-contract.spec.ts",
    "--config=playwright.founder-contract.config.ts",
  ],
  {
    ...deterministicProviderEnvironment,
    BRUNO_FOUNDER_CONTRACT_BROWSER_RESULT: browserResultPath,
  },
);

const scenarioLedger = parseFounderProductContractScenarioLedger({
  value: await readFile(requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH"), "utf8"),
  sourceRevision,
  runtimeRevision,
  runId,
  observedAt,
  signingSecret: scenarioSigningSecret,
});

const voiceOverDigest = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_DIGEST;
const voiceOverOsVersion = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_OS_VERSION;
const voiceOverBrowserVersion = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_BROWSER_VERSION;
const voiceOverObservedAt = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_OBSERVED_AT;
const voiceOverRuntimeRevision = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_RUNTIME_REVISION;
const voiceOverAttempts = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_ATTEMPTS",
);
const voiceOverFailures = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_FAILURES",
);
const voiceOverFlakes = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_FLAKES",
);
const voiceOverSkips = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_SKIPS",
);
const voiceOverIndependentHumanReviewers = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_INDEPENDENT_HUMAN_REVIEWERS",
);
const voiceOverAutomatedRuns = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_AUTOMATED_RUNS",
);
const voiceOverOwnerParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_OWNER_PARTICIPANTS",
);
const voiceOverSelfTests = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_SELF_TESTS",
);
const voiceOverFriendOrFamilyParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_FRIEND_OR_FAMILY_PARTICIPANTS",
);
const voiceOverSupportInterventions = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_SUPPORT_INTERVENTIONS",
);
const voiceOverExternalBetaParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_EXTERNAL_BETA_PARTICIPANTS",
);
const voiceOverCoachedParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_COACHED_PARTICIPANTS",
);
const voiceOverFacilitatorRescues = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_FACILITATOR_RESCUES",
);
const voiceOverTrustedPreviewParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_TRUSTED_PREVIEW_PARTICIPANTS",
);
const voiceOverBuildTeamParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_VOICEOVER_BUILD_TEAM_PARTICIPANTS",
);
const talkBackDigest = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_DIGEST;
const talkBackOsVersion = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_OS_VERSION;
const talkBackBrowserVersion = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_BROWSER_VERSION;
const talkBackObservedAt = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_OBSERVED_AT;
const talkBackRuntimeRevision = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_RUNTIME_REVISION;
const talkBackAttempts = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_ATTEMPTS",
);
const talkBackFailures = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_FAILURES",
);
const talkBackFlakes = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_FLAKES",
);
const talkBackSkips = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_SKIPS",
);
const talkBackIndependentHumanReviewers = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_INDEPENDENT_HUMAN_REVIEWERS",
);
const talkBackAutomatedRuns = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_AUTOMATED_RUNS",
);
const talkBackOwnerParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_OWNER_PARTICIPANTS",
);
const talkBackSelfTests = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_SELF_TESTS",
);
const talkBackFriendOrFamilyParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_FRIEND_OR_FAMILY_PARTICIPANTS",
);
const talkBackSupportInterventions = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_SUPPORT_INTERVENTIONS",
);
const talkBackExternalBetaParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_EXTERNAL_BETA_PARTICIPANTS",
);
const talkBackCoachedParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_COACHED_PARTICIPANTS",
);
const talkBackFacilitatorRescues = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_FACILITATOR_RESCUES",
);
const talkBackTrustedPreviewParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_TRUSTED_PREVIEW_PARTICIPANTS",
);
const talkBackBuildTeamParticipants = optionalNonnegativeIntegerEnvironment(
  "BRUNO_FOUNDER_CONTRACT_TALKBACK_BUILD_TEAM_PARTICIPANTS",
);
const evidence = await createFounderProductContractEvidence({
  browserResultPath,
  unitResultPath,
  sourceRevision,
  runtimeRevision,
  runId,
  runAttempt,
  mode,
  observedAt,
  ...(voiceOverDigest ? { voiceOverDigest } : {}),
  ...(voiceOverOsVersion ? { voiceOverOsVersion } : {}),
  ...(voiceOverBrowserVersion ? { voiceOverBrowserVersion } : {}),
  ...(voiceOverObservedAt ? { voiceOverObservedAt } : {}),
  ...(voiceOverRuntimeRevision ? { voiceOverRuntimeRevision } : {}),
  ...(voiceOverAttempts !== undefined ? { voiceOverAttempts } : {}),
  ...(voiceOverFailures !== undefined ? { voiceOverFailures } : {}),
  ...(voiceOverFlakes !== undefined ? { voiceOverFlakes } : {}),
  ...(voiceOverSkips !== undefined ? { voiceOverSkips } : {}),
  ...(voiceOverIndependentHumanReviewers !== undefined
    ? { voiceOverIndependentHumanReviewers }
    : {}),
  ...(voiceOverAutomatedRuns !== undefined ? { voiceOverAutomatedRuns } : {}),
  ...(voiceOverOwnerParticipants !== undefined ? { voiceOverOwnerParticipants } : {}),
  ...(voiceOverSelfTests !== undefined ? { voiceOverSelfTests } : {}),
  ...(voiceOverFriendOrFamilyParticipants !== undefined
    ? { voiceOverFriendOrFamilyParticipants }
    : {}),
  ...(voiceOverSupportInterventions !== undefined ? { voiceOverSupportInterventions } : {}),
  ...(voiceOverExternalBetaParticipants !== undefined ? { voiceOverExternalBetaParticipants } : {}),
  ...(voiceOverCoachedParticipants !== undefined ? { voiceOverCoachedParticipants } : {}),
  ...(voiceOverFacilitatorRescues !== undefined ? { voiceOverFacilitatorRescues } : {}),
  ...(voiceOverTrustedPreviewParticipants !== undefined
    ? { voiceOverTrustedPreviewParticipants }
    : {}),
  ...(voiceOverBuildTeamParticipants !== undefined ? { voiceOverBuildTeamParticipants } : {}),
  ...(talkBackDigest ? { talkBackDigest } : {}),
  ...(talkBackOsVersion ? { talkBackOsVersion } : {}),
  ...(talkBackBrowserVersion ? { talkBackBrowserVersion } : {}),
  ...(talkBackObservedAt ? { talkBackObservedAt } : {}),
  ...(talkBackRuntimeRevision ? { talkBackRuntimeRevision } : {}),
  ...(talkBackAttempts !== undefined ? { talkBackAttempts } : {}),
  ...(talkBackFailures !== undefined ? { talkBackFailures } : {}),
  ...(talkBackFlakes !== undefined ? { talkBackFlakes } : {}),
  ...(talkBackSkips !== undefined ? { talkBackSkips } : {}),
  ...(talkBackIndependentHumanReviewers !== undefined ? { talkBackIndependentHumanReviewers } : {}),
  ...(talkBackAutomatedRuns !== undefined ? { talkBackAutomatedRuns } : {}),
  ...(talkBackOwnerParticipants !== undefined ? { talkBackOwnerParticipants } : {}),
  ...(talkBackSelfTests !== undefined ? { talkBackSelfTests } : {}),
  ...(talkBackFriendOrFamilyParticipants !== undefined
    ? { talkBackFriendOrFamilyParticipants }
    : {}),
  ...(talkBackSupportInterventions !== undefined ? { talkBackSupportInterventions } : {}),
  ...(talkBackExternalBetaParticipants !== undefined ? { talkBackExternalBetaParticipants } : {}),
  ...(talkBackCoachedParticipants !== undefined ? { talkBackCoachedParticipants } : {}),
  ...(talkBackFacilitatorRescues !== undefined ? { talkBackFacilitatorRescues } : {}),
  ...(talkBackTrustedPreviewParticipants !== undefined
    ? { talkBackTrustedPreviewParticipants }
    : {}),
  ...(talkBackBuildTeamParticipants !== undefined ? { talkBackBuildTeamParticipants } : {}),
  scenarioLedger,
  scenarioSigningSecret,
});

await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
const generalReleaseDecision = buildFounderInitialGeneralReleaseDecision({
  productContract: evidence,
  moderatedSummary: parseFounderModeratedSummary(process.env.BRUNO_FOUNDER_MODERATED_SUMMARY_JSON),
  providerSummary: parseFounderProviderDecisionSummary(
    process.env.BRUNO_FOUNDER_PROVIDER_DECISION_SUMMARY_JSON,
  ),
  productionProviderQualificationSummary: parseFounderProductionProviderQualificationSummary(
    process.env.BRUNO_FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_JSON,
  ),
  productionProviderLiveTargetAuthority: parseFounderProductionProviderLiveTargetAuthority({
    storeDigest: process.env.BRUNO_FOUNDER_EXPECTED_LIVE_STORE_DIGEST,
    productDigest: process.env.BRUNO_FOUNDER_EXPECTED_LIVE_PRODUCT_DIGEST,
  }),
  operationalSummary: parseFounderGeneralReleaseOperationalSummary(
    process.env.BRUNO_FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_JSON,
  ),
  decisionTime: new Date(),
});
await writeFile(generalReleaseDecisionPath, `${JSON.stringify(generalReleaseDecision, null, 2)}\n`);
console.info(
  JSON.stringify({
    result: evidence.result,
    releaseEligible: evidence.releaseEligible,
    generalReleaseOutcome: generalReleaseDecision.outcome,
    summaryDigest: evidence.summaryDigest,
    generalReleaseSummaryDigest: generalReleaseDecision.summaryDigest,
  }),
);

async function run(command: string[], extraEnvironment: Record<string, string> = {}) {
  const [executable, ...arguments_] = command;
  if (!executable) throw new Error("A command executable is required.");
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const processHandle = spawn(executable, arguments_, {
      env: { ...process.env, ...extraEnvironment },
      stdio: "inherit",
    });
    processHandle.once("error", reject);
    processHandle.once("exit", resolve);
  });
  if (exitCode !== 0) {
    throw new Error(`${command[0]} failed with exit code ${exitCode}.`);
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredPositiveIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer.`);
  return parsed;
}

function optionalNonnegativeIntegerEnvironment(name: string): number | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${name} must be a nonnegative integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer.`);
  return parsed;
}
