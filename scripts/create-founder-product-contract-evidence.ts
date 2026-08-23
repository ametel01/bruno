import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isGitRevision, isRuntimeRevision } from "@/scripts/founder-release-evidence-validation";
import {
  FOUNDER_PRODUCT_CONTRACT_ATTENDED_TASKS,
  FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS,
  FOUNDER_PRODUCT_CONTRACT_INVARIANTS,
  FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
  FOUNDER_PRODUCT_CONTRACT_SCHEMA_VERSION,
} from "@/src/shared/founder-product-contract";
import {
  type FounderProductContractScenarioLedger,
  sanitizeFounderProductContractScenarioResult,
  validateFounderProductContractScenarios,
  verifyFounderProductContractScenarioLedger,
} from "@/src/testing/founder-product-contract";

type ContractMode = "ci" | "release";

type PlaywrightResult = {
  suites?: unknown[];
  stats?: {
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
  config?: {
    projects?: Array<{ name?: string }>;
  };
};

type VitestResult = {
  numPassedTests?: number;
  numFailedTests?: number;
  numPendingTests?: number;
  testResults?: unknown[];
};

export type FounderProductContractEvidence = ReturnType<typeof buildFounderProductContractEvidence>;

export async function createFounderProductContractEvidence(input: {
  browserResultPath: string;
  unitResultPath: string;
  sourceRevision: string;
  runtimeRevision: string;
  runId: string;
  runAttempt: number;
  mode: ContractMode;
  observedAt: string;
  voiceOverDigest?: string;
  voiceOverOsVersion?: string;
  voiceOverBrowserVersion?: string;
  voiceOverObservedAt?: string;
  voiceOverRuntimeRevision?: string;
  voiceOverAttempts?: number;
  voiceOverFailures?: number;
  voiceOverFlakes?: number;
  voiceOverSkips?: number;
  voiceOverIndependentHumanReviewers?: number;
  voiceOverAutomatedRuns?: number;
  voiceOverOwnerParticipants?: number;
  voiceOverSelfTests?: number;
  voiceOverFriendOrFamilyParticipants?: number;
  voiceOverSupportInterventions?: number;
  voiceOverExternalBetaParticipants?: number;
  voiceOverCoachedParticipants?: number;
  voiceOverFacilitatorRescues?: number;
  voiceOverTrustedPreviewParticipants?: number;
  voiceOverBuildTeamParticipants?: number;
  talkBackDigest?: string;
  talkBackOsVersion?: string;
  talkBackBrowserVersion?: string;
  talkBackObservedAt?: string;
  talkBackRuntimeRevision?: string;
  talkBackAttempts?: number;
  talkBackFailures?: number;
  talkBackFlakes?: number;
  talkBackSkips?: number;
  talkBackIndependentHumanReviewers?: number;
  talkBackAutomatedRuns?: number;
  talkBackOwnerParticipants?: number;
  talkBackSelfTests?: number;
  talkBackFriendOrFamilyParticipants?: number;
  talkBackSupportInterventions?: number;
  talkBackExternalBetaParticipants?: number;
  talkBackCoachedParticipants?: number;
  talkBackFacilitatorRescues?: number;
  talkBackTrustedPreviewParticipants?: number;
  talkBackBuildTeamParticipants?: number;
  scenarioLedger: FounderProductContractScenarioLedger;
  scenarioSigningSecret: string;
}): Promise<FounderProductContractEvidence> {
  const browser = JSON.parse(await readFile(input.browserResultPath, "utf8")) as PlaywrightResult;
  const unit = JSON.parse(await readFile(input.unitResultPath, "utf8")) as VitestResult;
  return buildFounderProductContractEvidence({ ...input, browser, unit });
}

export function buildFounderProductContractEvidence(input: {
  browser: PlaywrightResult;
  unit: VitestResult;
  sourceRevision: string;
  runtimeRevision: string;
  runId: string;
  runAttempt: number;
  mode: ContractMode;
  observedAt: string;
  voiceOverDigest?: string;
  voiceOverOsVersion?: string;
  voiceOverBrowserVersion?: string;
  voiceOverObservedAt?: string;
  voiceOverRuntimeRevision?: string;
  voiceOverAttempts?: number;
  voiceOverFailures?: number;
  voiceOverFlakes?: number;
  voiceOverSkips?: number;
  voiceOverIndependentHumanReviewers?: number;
  voiceOverAutomatedRuns?: number;
  voiceOverOwnerParticipants?: number;
  voiceOverSelfTests?: number;
  voiceOverFriendOrFamilyParticipants?: number;
  voiceOverSupportInterventions?: number;
  voiceOverExternalBetaParticipants?: number;
  voiceOverCoachedParticipants?: number;
  voiceOverFacilitatorRescues?: number;
  voiceOverTrustedPreviewParticipants?: number;
  voiceOverBuildTeamParticipants?: number;
  talkBackDigest?: string;
  talkBackOsVersion?: string;
  talkBackBrowserVersion?: string;
  talkBackObservedAt?: string;
  talkBackRuntimeRevision?: string;
  talkBackAttempts?: number;
  talkBackFailures?: number;
  talkBackFlakes?: number;
  talkBackSkips?: number;
  talkBackIndependentHumanReviewers?: number;
  talkBackAutomatedRuns?: number;
  talkBackOwnerParticipants?: number;
  talkBackSelfTests?: number;
  talkBackFriendOrFamilyParticipants?: number;
  talkBackSupportInterventions?: number;
  talkBackExternalBetaParticipants?: number;
  talkBackCoachedParticipants?: number;
  talkBackFacilitatorRescues?: number;
  talkBackTrustedPreviewParticipants?: number;
  talkBackBuildTeamParticipants?: number;
  scenarioLedger: FounderProductContractScenarioLedger;
  scenarioSigningSecret: string;
}) {
  if (!isGitRevision(input.sourceRevision)) throw new Error("source revision is invalid.");
  if (!isRuntimeRevision(input.runtimeRevision)) throw new Error("runtime revision is invalid.");
  requirePattern(input.runId, /^[A-Za-z0-9._:-]{1,128}$/, "run ID");
  if (!Number.isSafeInteger(input.runAttempt) || input.runAttempt < 1) {
    throw new Error("Workflow run attempt must be a positive integer.");
  }
  if (input.runAttempt > 1) {
    throw new Error("Workflow reruns cannot authorize Founder Product Contract evidence.");
  }
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.valueOf()) || observedAt.toISOString() !== input.observedAt) {
    throw new Error("Observed time must be an exact ISO-8601 instant.");
  }

  const browserStats = input.browser.stats;
  const unitPassed = input.unit.numPassedTests ?? 0;
  const unitFailed = input.unit.numFailedTests ?? -1;
  const unitPending = input.unit.numPendingTests ?? -1;
  if (!browserStats) {
    throw new Error("Every browser project must pass once with no failure, retry, or skip.");
  }
  if (
    browserStats.unexpected !== 0 ||
    browserStats.flaky !== 0 ||
    browserStats.skipped !== 0 ||
    browserStats.expected !== FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.length
  ) {
    throw new Error("Every browser project must pass once with no failure, retry, or skip.");
  }
  if (unitPassed <= 0 || unitFailed !== 0 || unitPending !== 0) {
    throw new Error("Every deterministic unit invariant must pass with no failure or skip.");
  }

  const projects = (input.browser.config?.projects ?? []).flatMap((project) =>
    typeof project.name === "string" ? [project.name] : [],
  );
  for (const project of FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS) {
    if (!projects.includes(project)) {
      throw new Error(`Required browser project ${project} was not present.`);
    }
  }

  const voiceOverEvidence = optionalAttendedEvidence({
    digest: input.voiceOverDigest,
    osVersion: input.voiceOverOsVersion,
    browserVersion: input.voiceOverBrowserVersion,
    observedAt: input.voiceOverObservedAt,
    runtimeRevision: input.voiceOverRuntimeRevision,
    assistiveTechnology: "VoiceOver",
    browser: "Safari",
    sourceRevision: input.sourceRevision,
    expectedRuntimeRevision: input.runtimeRevision,
    attempts: input.voiceOverAttempts,
    failures: input.voiceOverFailures,
    flakes: input.voiceOverFlakes,
    skips: input.voiceOverSkips,
    independentHumanReviewers: input.voiceOverIndependentHumanReviewers,
    automatedRuns: input.voiceOverAutomatedRuns,
    ownerParticipants: input.voiceOverOwnerParticipants,
    selfTests: input.voiceOverSelfTests,
    friendOrFamilyParticipants: input.voiceOverFriendOrFamilyParticipants,
    supportInterventions: input.voiceOverSupportInterventions,
    externalBetaParticipants: input.voiceOverExternalBetaParticipants,
    coachedParticipants: input.voiceOverCoachedParticipants,
    facilitatorRescues: input.voiceOverFacilitatorRescues,
    trustedPreviewParticipants: input.voiceOverTrustedPreviewParticipants,
    buildTeamParticipants: input.voiceOverBuildTeamParticipants,
  });
  const talkBackEvidence = optionalAttendedEvidence({
    digest: input.talkBackDigest,
    osVersion: input.talkBackOsVersion,
    browserVersion: input.talkBackBrowserVersion,
    observedAt: input.talkBackObservedAt,
    runtimeRevision: input.talkBackRuntimeRevision,
    assistiveTechnology: "TalkBack",
    browser: "Chrome",
    sourceRevision: input.sourceRevision,
    expectedRuntimeRevision: input.runtimeRevision,
    attempts: input.talkBackAttempts,
    failures: input.talkBackFailures,
    flakes: input.talkBackFlakes,
    skips: input.talkBackSkips,
    independentHumanReviewers: input.talkBackIndependentHumanReviewers,
    automatedRuns: input.talkBackAutomatedRuns,
    ownerParticipants: input.talkBackOwnerParticipants,
    selfTests: input.talkBackSelfTests,
    friendOrFamilyParticipants: input.talkBackFriendOrFamilyParticipants,
    supportInterventions: input.talkBackSupportInterventions,
    externalBetaParticipants: input.talkBackExternalBetaParticipants,
    coachedParticipants: input.talkBackCoachedParticipants,
    facilitatorRescues: input.talkBackFacilitatorRescues,
    trustedPreviewParticipants: input.talkBackTrustedPreviewParticipants,
    buildTeamParticipants: input.talkBackBuildTeamParticipants,
  });
  if (input.mode === "release" && (!voiceOverEvidence || !talkBackEvidence)) {
    throw new Error("Release evidence requires bound VoiceOver and TalkBack evidence digests.");
  }
  if (!input.scenarioLedger) {
    throw new Error("Founder Product Contract evidence requires a signed lifecycle ledger.");
  }
  const scenarioLedger = verifyFounderProductContractScenarioLedger({
    ledger: input.scenarioLedger,
    sourceRevision: input.sourceRevision,
    runtimeRevision: input.runtimeRevision,
    runId: input.runId,
    observedAt: input.observedAt,
    signingSecret: input.scenarioSigningSecret,
  });
  validateFounderProductContractScenarios({
    required: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
    results: scenarioLedger.results,
    sourceRevision: input.sourceRevision,
    runtimeRevision: input.runtimeRevision,
    observedAt: input.observedAt,
  });
  const scenarioEvidence = scenarioLedger.results.map((result) => {
    const sanitized = sanitizeFounderProductContractScenarioResult(result);
    return {
      id: sanitized.id,
      status: sanitized.status,
      attempts: sanitized.attempts,
      cleanup: sanitized.cleanup,
    };
  });
  const retainedScenarioLedger = {
    schemaVersion: scenarioLedger.schemaVersion,
    producer: scenarioLedger.producer,
    sourceRevision: scenarioLedger.sourceRevision,
    runtimeRevision: scenarioLedger.runtimeRevision,
    runId: scenarioLedger.runId,
    observedAt: scenarioLedger.observedAt,
    results: scenarioLedger.results.map(sanitizeFounderProductContractScenarioResult),
    resultsDigest: scenarioLedger.resultsDigest,
    signature: scenarioLedger.signature,
  } as const;

  const invariantResults = FOUNDER_PRODUCT_CONTRACT_INVARIANTS.map((invariant) => {
    if (invariant.id === "voiceover_safari") {
      return {
        id: invariant.id,
        kind: invariant.kind,
        status: voiceOverEvidence ? "passed" : "attended_evidence_required",
        evidence: voiceOverEvidence ? [voiceOverEvidence] : [],
      };
    }
    if (invariant.id === "talkback_chrome") {
      return {
        id: invariant.id,
        kind: invariant.kind,
        status: talkBackEvidence ? "passed" : "attended_evidence_required",
        evidence: talkBackEvidence ? [talkBackEvidence] : [],
      };
    }
    return {
      id: invariant.id,
      kind: invariant.kind,
      status: "passed",
      evidence: [...invariant.evidence],
    };
  });

  const payload = {
    schemaVersion: FOUNDER_PRODUCT_CONTRACT_SCHEMA_VERSION,
    mode: input.mode,
    result: "passed",
    releaseEligible: Boolean(input.mode === "release" && voiceOverEvidence && talkBackEvidence),
    releaseIdentity: {
      sourceRevision: input.sourceRevision,
      runtimeRevision: input.runtimeRevision,
      runId: input.runId,
    },
    observedAt: input.observedAt,
    execution: {
      reruns: input.runAttempt - 1,
      unit: { passed: unitPassed, failed: 0, skipped: 0 },
      browser: {
        passed: browserStats.expected,
        failed: 0,
        flaky: 0,
        skipped: 0,
        projects: [...FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS],
      },
    },
    invariants: invariantResults,
    ...(scenarioEvidence ? { scenarios: scenarioEvidence } : {}),
    scenarioLedger: retainedScenarioLedger,
    ...(scenarioEvidence
      ? {
          cleanup: {
            status: scenarioEvidence.every(({ cleanup }) => cleanup.status === "passed")
              ? "passed"
              : "failed",
            verified: scenarioEvidence.every(({ cleanup }) => cleanup.verified),
            scenarios: scenarioEvidence.map(({ id, cleanup }) => ({ id, ...cleanup })),
          },
        }
      : {}),
    sanitization: {
      allowlisted: true,
      excluded: [
        "credentials",
        "authorization_codes",
        "message_bodies",
        "recipients",
        "prompts",
        "provider_responses",
        "infrastructure_ids",
      ],
    },
  } as const;

  return {
    ...payload,
    summaryDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  };
}

function optionalAttendedEvidence(input: {
  digest: string | undefined;
  osVersion: string | undefined;
  browserVersion: string | undefined;
  observedAt: string | undefined;
  runtimeRevision: string | undefined;
  assistiveTechnology: "VoiceOver" | "TalkBack";
  browser: "Safari" | "Chrome";
  sourceRevision: string;
  expectedRuntimeRevision: string;
  attempts: number | undefined;
  failures: number | undefined;
  flakes: number | undefined;
  skips: number | undefined;
  independentHumanReviewers: number | undefined;
  automatedRuns: number | undefined;
  ownerParticipants: number | undefined;
  selfTests: number | undefined;
  friendOrFamilyParticipants: number | undefined;
  supportInterventions: number | undefined;
  externalBetaParticipants: number | undefined;
  coachedParticipants: number | undefined;
  facilitatorRescues: number | undefined;
  trustedPreviewParticipants: number | undefined;
  buildTeamParticipants: number | undefined;
}) {
  if (
    !input.digest &&
    !input.osVersion &&
    !input.browserVersion &&
    !input.observedAt &&
    !input.runtimeRevision &&
    input.attempts === undefined &&
    input.failures === undefined &&
    input.flakes === undefined &&
    input.skips === undefined &&
    input.independentHumanReviewers === undefined &&
    input.automatedRuns === undefined &&
    input.ownerParticipants === undefined &&
    input.selfTests === undefined &&
    input.friendOrFamilyParticipants === undefined &&
    input.supportInterventions === undefined &&
    input.externalBetaParticipants === undefined &&
    input.coachedParticipants === undefined &&
    input.facilitatorRescues === undefined &&
    input.trustedPreviewParticipants === undefined &&
    input.buildTeamParticipants === undefined
  )
    return null;
  if (
    !input.digest ||
    !input.osVersion ||
    !input.browserVersion ||
    !input.observedAt ||
    !input.runtimeRevision ||
    input.attempts === undefined ||
    input.failures === undefined ||
    input.flakes === undefined ||
    input.skips === undefined ||
    input.independentHumanReviewers === undefined ||
    input.automatedRuns === undefined ||
    input.ownerParticipants === undefined ||
    input.selfTests === undefined ||
    input.friendOrFamilyParticipants === undefined ||
    input.supportInterventions === undefined ||
    input.externalBetaParticipants === undefined ||
    input.coachedParticipants === undefined ||
    input.facilitatorRescues === undefined ||
    input.trustedPreviewParticipants === undefined ||
    input.buildTeamParticipants === undefined
  ) {
    throw new Error(`${input.assistiveTechnology} evidence metadata is incomplete.`);
  }
  requirePattern(input.digest, /^sha256:[a-f0-9]{64}$/, `${input.assistiveTechnology} digest`);
  requirePattern(
    input.osVersion,
    /^[A-Za-z0-9 ._()+/-]{1,80}$/,
    `${input.assistiveTechnology} OS version`,
  );
  const observedAt = new Date(input.observedAt);
  if (Number.isNaN(observedAt.valueOf()) || observedAt.toISOString() !== input.observedAt) {
    throw new Error(`${input.assistiveTechnology} observed time is invalid.`);
  }
  if (!isRuntimeRevision(input.runtimeRevision)) {
    throw new Error(`${input.assistiveTechnology} runtime revision is invalid.`);
  }
  if (input.runtimeRevision !== input.expectedRuntimeRevision) {
    throw new Error(`${input.assistiveTechnology} runtime revision does not match the contract.`);
  }
  if (input.attempts !== 1 || input.failures !== 0 || input.flakes !== 0 || input.skips !== 0) {
    throw new Error(`${input.assistiveTechnology} evidence must have exactly one clean attempt.`);
  }
  if (
    input.independentHumanReviewers !== 1 ||
    input.automatedRuns !== 0 ||
    input.ownerParticipants !== 0 ||
    input.selfTests !== 0 ||
    input.friendOrFamilyParticipants !== 0 ||
    input.supportInterventions !== 0 ||
    input.externalBetaParticipants !== 0 ||
    input.coachedParticipants !== 0 ||
    input.facilitatorRescues !== 0 ||
    input.trustedPreviewParticipants !== 0 ||
    input.buildTeamParticipants !== 0
  ) {
    throw new Error(
      `${input.assistiveTechnology} evidence must come from one independent attended human review with no prohibited participant or source.`,
    );
  }
  requirePattern(
    input.browserVersion,
    /^[A-Za-z0-9 ._()+/-]{1,80}$/,
    `${input.assistiveTechnology} browser version`,
  );
  return {
    digest: input.digest,
    assistiveTechnology: input.assistiveTechnology,
    osVersion: input.osVersion,
    browser: input.browser,
    browserVersion: input.browserVersion,
    appSourceRevision: input.sourceRevision,
    appRuntimeRevision: input.runtimeRevision,
    observedAt: input.observedAt,
    attempts: input.attempts,
    failures: input.failures,
    flakes: input.flakes,
    skips: input.skips,
    evidenceClass: "independent_attended_human_accessibility_review",
    participantBoundary: {
      independentHumanReviewers: 1,
      automatedRuns: 0,
      ownerParticipants: 0,
      selfTests: 0,
      friendOrFamilyParticipants: 0,
      supportInterventions: 0,
      externalBetaParticipants: 0,
      coachedParticipants: 0,
      facilitatorRescues: 0,
      trustedPreviewParticipants: 0,
      buildTeamParticipants: 0,
    },
    tasks: [...FOUNDER_PRODUCT_CONTRACT_ATTENDED_TASKS],
    outcome: "passed",
  } as const;
}

function requirePattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
}
