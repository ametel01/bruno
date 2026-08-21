import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildFounderInitialGeneralReleaseDecision,
  parseFounderModeratedSummary,
  parseFounderProviderDecisionSummary,
} from "@/scripts/create-founder-general-release-decision";
import { createFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import { FOUNDER_PRODUCT_CONTRACT_UNIT_FILES } from "@/src/shared/founder-product-contract";
import {
  FOUNDER_PRODUCT_CONTRACT_SCENARIO_SIGNING_SECRET_ENV,
  parseFounderProductContractScenarioLedger,
} from "@/src/testing/founder-product-contract";
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

await mkdir(artifactDirectory, { recursive: true });
await rm(evidencePath, { force: true });
await rm(generalReleaseDecisionPath, { force: true });
const sourceRevision = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
const observedAt = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT");
const runId = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
const scenarioSigningSecret = requiredEnvironment(
  FOUNDER_PRODUCT_CONTRACT_SCENARIO_SIGNING_SECRET_ENV,
);
const scenarioLedgerPath = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH");
const deterministicProviderEnvironment = {
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
  VERCEL_GIT_COMMIT_SHA: sourceRevision,
  BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET: scenarioSigningSecret,
  BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH: scenarioLedgerPath,
  BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: sourceRevision,
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
  runId,
  observedAt,
  signingSecret: scenarioSigningSecret,
});

const voiceOverDigest = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_DIGEST;
const voiceOverOsVersion = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_OS_VERSION;
const voiceOverBrowserVersion = process.env.BRUNO_FOUNDER_CONTRACT_VOICEOVER_BROWSER_VERSION;
const talkBackDigest = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_DIGEST;
const talkBackOsVersion = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_OS_VERSION;
const talkBackBrowserVersion = process.env.BRUNO_FOUNDER_CONTRACT_TALKBACK_BROWSER_VERSION;
const evidence = await createFounderProductContractEvidence({
  browserResultPath,
  unitResultPath,
  sourceRevision,
  runId,
  mode,
  observedAt,
  ...(voiceOverDigest ? { voiceOverDigest } : {}),
  ...(voiceOverOsVersion ? { voiceOverOsVersion } : {}),
  ...(voiceOverBrowserVersion ? { voiceOverBrowserVersion } : {}),
  ...(talkBackDigest ? { talkBackDigest } : {}),
  ...(talkBackOsVersion ? { talkBackOsVersion } : {}),
  ...(talkBackBrowserVersion ? { talkBackBrowserVersion } : {}),
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
