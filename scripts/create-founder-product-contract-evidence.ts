import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  FOUNDER_PRODUCT_CONTRACT_ATTENDED_TASKS,
  FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS,
  FOUNDER_PRODUCT_CONTRACT_INVARIANTS,
  FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
  FOUNDER_PRODUCT_CONTRACT_SCHEMA_VERSION,
} from "@/src/shared/founder-product-contract";
import {
  type FounderProductContractScenarioResult,
  validateFounderProductContractScenarios,
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
  runId: string;
  mode: ContractMode;
  observedAt: string;
  voiceOverDigest?: string;
  voiceOverOsVersion?: string;
  voiceOverBrowserVersion?: string;
  talkBackDigest?: string;
  talkBackOsVersion?: string;
  talkBackBrowserVersion?: string;
  scenarioResults?: readonly FounderProductContractScenarioResult[];
  requiredScenarioIds?: readonly string[];
  scenarioMaxAgeMilliseconds?: number;
}): Promise<FounderProductContractEvidence> {
  const browser = JSON.parse(await readFile(input.browserResultPath, "utf8")) as PlaywrightResult;
  const unit = JSON.parse(await readFile(input.unitResultPath, "utf8")) as VitestResult;
  return buildFounderProductContractEvidence({ ...input, browser, unit });
}

export function buildFounderProductContractEvidence(input: {
  browser: PlaywrightResult;
  unit: VitestResult;
  sourceRevision: string;
  runId: string;
  mode: ContractMode;
  observedAt: string;
  voiceOverDigest?: string;
  voiceOverOsVersion?: string;
  voiceOverBrowserVersion?: string;
  talkBackDigest?: string;
  talkBackOsVersion?: string;
  talkBackBrowserVersion?: string;
  scenarioResults?: readonly FounderProductContractScenarioResult[];
  requiredScenarioIds?: readonly string[];
  scenarioMaxAgeMilliseconds?: number;
}) {
  requirePattern(input.sourceRevision, /^[a-f0-9]{40}$/, "source revision");
  requirePattern(input.runId, /^[A-Za-z0-9._:-]{1,128}$/, "run ID");
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
    assistiveTechnology: "VoiceOver",
    browser: "Safari",
    sourceRevision: input.sourceRevision,
  });
  const talkBackEvidence = optionalAttendedEvidence({
    digest: input.talkBackDigest,
    osVersion: input.talkBackOsVersion,
    browserVersion: input.talkBackBrowserVersion,
    assistiveTechnology: "TalkBack",
    browser: "Chrome",
    sourceRevision: input.sourceRevision,
  });
  if (input.mode === "release" && (!voiceOverEvidence || !talkBackEvidence)) {
    throw new Error("Release evidence requires bound VoiceOver and TalkBack evidence digests.");
  }
  if (input.mode === "release" && !input.scenarioResults) {
    throw new Error("Release evidence requires lifecycle scenario results.");
  }

  const scenarioEvidence = input.scenarioResults
    ? (() => {
        const required = input.requiredScenarioIds ?? FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS;
        validateFounderProductContractScenarios({
          required,
          results: input.scenarioResults,
          sourceRevision: input.sourceRevision,
          observedAt: input.observedAt,
          ...(input.scenarioMaxAgeMilliseconds === undefined
            ? {}
            : { maxAgeMilliseconds: input.scenarioMaxAgeMilliseconds }),
        });
        return input.scenarioResults.map(({ id, status, attempts }) => ({
          id,
          status,
          attempts,
        }));
      })()
    : undefined;

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
      runId: input.runId,
    },
    observedAt: input.observedAt,
    execution: {
      reruns: 0,
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
  assistiveTechnology: "VoiceOver" | "TalkBack";
  browser: "Safari" | "Chrome";
  sourceRevision: string;
}) {
  if (!input.digest && !input.osVersion && !input.browserVersion) return null;
  if (!input.digest || !input.osVersion || !input.browserVersion) {
    throw new Error(`${input.assistiveTechnology} evidence metadata is incomplete.`);
  }
  requirePattern(input.digest, /^sha256:[a-f0-9]{64}$/, `${input.assistiveTechnology} digest`);
  requirePattern(
    input.osVersion,
    /^[A-Za-z0-9 ._()+/-]{1,80}$/,
    `${input.assistiveTechnology} OS version`,
  );
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
    tasks: [...FOUNDER_PRODUCT_CONTRACT_ATTENDED_TASKS],
    outcome: "passed",
  } as const;
}

function requirePattern(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) throw new Error(`${label} is invalid.`);
}
