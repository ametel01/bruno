import { describe, expect, it } from "vitest";
import { buildFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS,
  FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
} from "@/src/shared/founder-product-contract";
import {
  createFounderProductContractScenarioLedger,
  type FounderProductContractScenarioResult,
  parseFounderProductContractScenarioLedger,
  sanitizeFounderProductContractScenarioResult,
} from "@/src/testing/founder-product-contract";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNING_SECRET = "founder-contract-test-secret";
const RUNTIME_REVISION = "runtime-release-v1";

describe("Founder Product Contract evidence", () => {
  it("emits an allowlisted exact-release summary while keeping attended evidence explicit", () => {
    const evidence = buildFounderProductContractEvidence(validInput());

    expect(evidence).toMatchObject({
      result: "passed",
      releaseEligible: false,
      releaseIdentity: {
        sourceRevision: REVISION,
        runtimeRevision: "runtime-release-v1",
        runId: "local-365",
      },
      execution: {
        reruns: 0,
        unit: { passed: 64, failed: 0, skipped: 0 },
        browser: { passed: 5, failed: 0, flaky: 0, skipped: 0 },
      },
    });
    expect(evidence.summaryDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(evidence.invariants).toContainEqual({
      id: "voiceover_safari",
      kind: "attended",
      status: "attended_evidence_required",
      evidence: [],
    });
    expect(JSON.stringify(evidence)).not.toMatch(/credential-value|message body|recipient@example/);
  });

  it("binds attended evidence and marks a release-mode pack eligible", () => {
    const evidence = buildFounderProductContractEvidence(validAttendedInput());

    expect(evidence.releaseEligible).toBe(true);
    expect(evidence.invariants.filter((invariant) => invariant.kind === "attended")).toEqual([
      expect.objectContaining({
        id: "voiceover_safari",
        kind: "attended",
        status: "passed",
        evidence: [
          expect.objectContaining({
            digest: DIGEST,
            assistiveTechnology: "VoiceOver",
            osVersion: "macOS 15.6",
            browser: "Safari",
            browserVersion: "Safari 26.0",
            appSourceRevision: REVISION,
            appRuntimeRevision: RUNTIME_REVISION,
            observedAt: "2026-08-20T00:00:00.000Z",
            attempts: 1,
            failures: 0,
            flakes: 0,
            skips: 0,
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
            outcome: "passed",
          }),
        ],
      }),
      expect.objectContaining({
        id: "talkback_chrome",
        kind: "attended",
        status: "passed",
        evidence: [
          expect.objectContaining({
            digest: DIGEST,
            assistiveTechnology: "TalkBack",
            osVersion: "Android 16",
            browser: "Chrome",
            browserVersion: "Chrome 140",
            appSourceRevision: REVISION,
            appRuntimeRevision: RUNTIME_REVISION,
            observedAt: "2026-08-20T00:00:00.000Z",
            attempts: 1,
            failures: 0,
            flakes: 0,
            skips: 0,
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
            outcome: "passed",
          }),
        ],
      }),
    ]);
  });

  it.each<
    [
      string,
      {
        browserStats?: { unexpected?: number; flaky?: number; skipped?: number };
        unit?: { numPassedTests: number; numFailedTests: number; numPendingTests: number };
      },
    ]
  >([
    ["browser failure", { browserStats: { unexpected: 1 } }],
    ["browser retry", { browserStats: { flaky: 1 } }],
    ["browser skip", { browserStats: { skipped: 1 } }],
    ["unit failure", { unit: { numPassedTests: 63, numFailedTests: 1, numPendingTests: 0 } }],
    ["unit skip", { unit: { numPassedTests: 63, numFailedTests: 0, numPendingTests: 1 } }],
  ])("blocks the whole candidate on %s", (_name, override) => {
    const input = validInput();
    if (override.browserStats) Object.assign(input.browser.stats, override.browserStats);
    if (override.unit) input.unit = override.unit;

    expect(() => buildFounderProductContractEvidence(input)).toThrow();
  });

  it("refuses release mode without both attended evidence digests", () => {
    expect(() => buildFounderProductContractEvidence({ ...validInput(), mode: "release" })).toThrow(
      "Release evidence requires bound VoiceOver and TalkBack evidence digests.",
    );
  });

  it("refuses evidence from a rerun of the same workflow candidate", () => {
    expect(() => buildFounderProductContractEvidence({ ...validInput(), runAttempt: 2 })).toThrow(
      "Workflow reruns cannot authorize Founder Product Contract evidence.",
    );
  });

  it("requires an exact runtime revision in the release identity", () => {
    expect(() =>
      buildFounderProductContractEvidence({ ...validInput(), runtimeRevision: "not valid" }),
    ).toThrow("runtime revision is invalid");
  });

  it("rejects a signed lifecycle ledger from a different runtime before emitting evidence", () => {
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        runtimeRevision: "runtime-release-v2",
      }),
    ).toThrow("runtime revision mismatch");
  });

  it("refuses a missing lifecycle ledger in normal CI", () => {
    const input = validInput() as Record<string, unknown>;
    delete input.scenarioLedger;
    expect(() => buildFounderProductContractEvidence(input as never)).toThrow(
      "requires a signed lifecycle ledger",
    );
  });

  it("refuses release mode with an empty lifecycle ledger", () => {
    expect(() =>
      buildFounderProductContractEvidence({
        ...validAttendedInput(),
        scenarioLedger: signedScenarioLedger([]),
      }),
    ).toThrow(
      "Required Founder Product Contract scenario release_stage_admission was not present.",
    );
  });

  it("includes cleanup evidence and rejects an unverified cleanup", () => {
    const scenarioResults = lifecycleScenarioResults();
    const failedCleanup = scenarioResults.map((scenario) =>
      scenario.id === "recovery_archive_lifecycle"
        ? {
            ...scenario,
            cleanup: { ...scenario.cleanup, status: "failed" as const, verified: false },
          }
        : scenario,
    );

    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        scenarioLedger: signedScenarioLedger(failedCleanup),
      }),
    ).toThrow("cleanup was not verified");
  });

  it("refuses attended evidence whose environment metadata is incomplete", () => {
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        voiceOverDigest: DIGEST,
      }),
    ).toThrow("VoiceOver evidence metadata is incomplete.");
  });

  it("requires each attended record to preserve its exact observation time and runtime", () => {
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        voiceOverDigest: DIGEST,
        voiceOverOsVersion: "macOS 15.6",
        voiceOverBrowserVersion: "Safari 26.0",
      }),
    ).toThrow("VoiceOver evidence metadata is incomplete");
    expect(() =>
      buildFounderProductContractEvidence({
        ...validAttendedInput(),
        voiceOverObservedAt: "not-a-time",
      }),
    ).toThrow("VoiceOver observed time is invalid");
  });

  it("does not synthesize an omitted zero claim into complete attended evidence", () => {
    const { voiceOverFailures: _omitted, ...incomplete } = validAttendedInput();

    expect(() => buildFounderProductContractEvidence(incomplete)).toThrow(
      "VoiceOver evidence metadata is incomplete",
    );
  });

  it.each([
    ["VoiceOver", "voiceOverRuntimeRevision"],
    ["TalkBack", "talkBackRuntimeRevision"],
  ] as const)("rejects %s evidence from a different contract runtime", (label, field) => {
    const input = validAttendedInput();
    input[field] = "runtime-release-v2";

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      `${label} runtime revision does not match the contract`,
    );
  });

  it.each([
    ["VoiceOver", "voiceOverAttempts", 2],
    ["VoiceOver", "voiceOverFailures", 1],
    ["VoiceOver", "voiceOverFlakes", 1],
    ["VoiceOver", "voiceOverSkips", 1],
    ["TalkBack", "talkBackAttempts", 2],
    ["TalkBack", "talkBackFailures", 1],
    ["TalkBack", "talkBackFlakes", 1],
    ["TalkBack", "talkBackSkips", 1],
  ] as const)("rejects a non-clean %s attended result", (label, field, value) => {
    const input = validAttendedInput();
    input[field] = value;

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      `${label} evidence must have exactly one clean attempt`,
    );
  });

  it.each([
    ["VoiceOver", "voiceOverIndependentHumanReviewers", 0],
    ["VoiceOver", "voiceOverAutomatedRuns", 1],
    ["VoiceOver", "voiceOverOwnerParticipants", 1],
    ["VoiceOver", "voiceOverSelfTests", 1],
    ["VoiceOver", "voiceOverFriendOrFamilyParticipants", 1],
    ["VoiceOver", "voiceOverSupportInterventions", 1],
    ["VoiceOver", "voiceOverExternalBetaParticipants", 1],
    ["VoiceOver", "voiceOverCoachedParticipants", 1],
    ["VoiceOver", "voiceOverFacilitatorRescues", 1],
    ["VoiceOver", "voiceOverTrustedPreviewParticipants", 1],
    ["VoiceOver", "voiceOverBuildTeamParticipants", 1],
    ["TalkBack", "talkBackIndependentHumanReviewers", 0],
    ["TalkBack", "talkBackAutomatedRuns", 1],
    ["TalkBack", "talkBackOwnerParticipants", 1],
    ["TalkBack", "talkBackSelfTests", 1],
    ["TalkBack", "talkBackFriendOrFamilyParticipants", 1],
    ["TalkBack", "talkBackSupportInterventions", 1],
    ["TalkBack", "talkBackExternalBetaParticipants", 1],
    ["TalkBack", "talkBackCoachedParticipants", 1],
    ["TalkBack", "talkBackFacilitatorRescues", 1],
    ["TalkBack", "talkBackTrustedPreviewParticipants", 1],
    ["TalkBack", "talkBackBuildTeamParticipants", 1],
  ] as const)("rejects a prohibited %s participant/source boundary", (label, field, value) => {
    const input = validAttendedInput();
    input[field] = value;

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      `${label} evidence must come from one independent attended human review with no prohibited participant or source`,
    );
  });

  it("does not retain cleanup fields outside the allowlist", () => {
    const ledger = signedScenarioLedger();
    const first = ledger.results[0];
    if (!first) throw new Error("Expected a lifecycle scenario.");
    (first.cleanup as unknown as Record<string, unknown>).credentials = "should-not-survive";

    const evidence = buildFounderProductContractEvidence({
      ...validInput(),
      scenarioLedger: ledger,
    });

    expect(JSON.stringify(evidence)).not.toContain("should-not-survive");
    expect(sanitizeFounderProductContractScenarioResult(first).cleanup).not.toHaveProperty(
      "credentials",
    );
  });

  it("rejects an unsigned or structurally extended lifecycle ledger", () => {
    const ledger = signedScenarioLedger();
    const extended = JSON.parse(JSON.stringify(ledger)) as Record<string, unknown>;
    const results = extended.results as Array<Record<string, unknown>>;
    const first = results[0];
    if (!first) throw new Error("Expected a lifecycle scenario.");
    (first.cleanup as Record<string, unknown>).credentials = "should-not-survive";

    expect(() =>
      parseFounderProductContractScenarioLedger({
        value: JSON.stringify(extended),
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        runId: "local-365",
        observedAt: "2026-08-20T00:00:00.000Z",
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow("is invalid");

    expect(() =>
      parseFounderProductContractScenarioLedger({
        value: JSON.stringify({ ...ledger, signature: "hmac-sha256:forged" }),
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        runId: "local-365",
        observedAt: "2026-08-20T00:00:00.000Z",
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow("signature is invalid");
  });

  it("accepts an exact lifecycle ledger and rejects a missing required scenario", () => {
    const scenarioResults = lifecycleScenarioResults();
    const evidence = buildFounderProductContractEvidence({
      ...validInput(),
      scenarioLedger: signedScenarioLedger(scenarioResults),
    });

    expect(evidence.scenarios).toEqual(
      scenarioResults.map(({ id, status, attempts, cleanup }) => ({
        id,
        status,
        attempts,
        cleanup,
      })),
    );
    expect(evidence.scenarioLedger).toEqual({
      schemaVersion: "bruno.founder-product-contract.scenario-ledger.v2",
      producer: "bruno.persisted-founder-application",
      sourceRevision: REVISION,
      runtimeRevision: RUNTIME_REVISION,
      runId: "local-365",
      observedAt: "2026-08-20T00:00:00.000Z",
      results: scenarioResults,
      resultsDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      signature: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
    });
    expect(
      parseFounderProductContractScenarioLedger({
        value: JSON.stringify(evidence.scenarioLedger),
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        runId: "local-365",
        observedAt: "2026-08-20T00:00:00.000Z",
        signingSecret: SIGNING_SECRET,
      }),
    ).toEqual(evidence.scenarioLedger);
    expect(evidence.cleanup).toMatchObject({ status: "passed", verified: true });
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        scenarioLedger: signedScenarioLedger(scenarioResults.slice(1)),
      }),
    ).toThrow(
      "Required Founder Product Contract scenario release_stage_admission was not present.",
    );
  });
});

function validInput() {
  return {
    browser: {
      config: { projects: FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.map((name) => ({ name })) },
      stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 },
      suites: [],
    },
    unit: { numPassedTests: 64, numFailedTests: 0, numPendingTests: 0 },
    sourceRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    runId: "local-365",
    runAttempt: 1,
    mode: "ci" as const,
    observedAt: "2026-08-20T00:00:00.000Z",
    scenarioLedger: signedScenarioLedger(),
    scenarioSigningSecret: SIGNING_SECRET,
  };
}

function validAttendedInput() {
  return {
    ...validInput(),
    mode: "release" as const,
    voiceOverDigest: DIGEST,
    voiceOverOsVersion: "macOS 15.6",
    voiceOverBrowserVersion: "Safari 26.0",
    voiceOverObservedAt: "2026-08-20T00:00:00.000Z",
    voiceOverRuntimeRevision: RUNTIME_REVISION,
    voiceOverAttempts: 1,
    voiceOverFailures: 0,
    voiceOverFlakes: 0,
    voiceOverSkips: 0,
    voiceOverIndependentHumanReviewers: 1,
    voiceOverAutomatedRuns: 0,
    voiceOverOwnerParticipants: 0,
    voiceOverSelfTests: 0,
    voiceOverFriendOrFamilyParticipants: 0,
    voiceOverSupportInterventions: 0,
    voiceOverExternalBetaParticipants: 0,
    voiceOverCoachedParticipants: 0,
    voiceOverFacilitatorRescues: 0,
    voiceOverTrustedPreviewParticipants: 0,
    voiceOverBuildTeamParticipants: 0,
    talkBackDigest: DIGEST,
    talkBackOsVersion: "Android 16",
    talkBackBrowserVersion: "Chrome 140",
    talkBackObservedAt: "2026-08-20T00:00:00.000Z",
    talkBackRuntimeRevision: RUNTIME_REVISION,
    talkBackAttempts: 1,
    talkBackFailures: 0,
    talkBackFlakes: 0,
    talkBackSkips: 0,
    talkBackIndependentHumanReviewers: 1,
    talkBackAutomatedRuns: 0,
    talkBackOwnerParticipants: 0,
    talkBackSelfTests: 0,
    talkBackFriendOrFamilyParticipants: 0,
    talkBackSupportInterventions: 0,
    talkBackExternalBetaParticipants: 0,
    talkBackCoachedParticipants: 0,
    talkBackFacilitatorRescues: 0,
    talkBackTrustedPreviewParticipants: 0,
    talkBackBuildTeamParticipants: 0,
  };
}

function lifecycleScenarioResults() {
  return FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((id) => ({
    id,
    status: "passed" as const,
    attempts: 1,
    sourceRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    observedAt: "2026-08-20T00:00:00.000Z",
    cleanup: {
      status: "passed" as const,
      verified: true,
      resourcesBefore: id === "infrastructure_retirement" ? 2 : 0,
      resourcesAfter: 0,
      observedAt: "2026-08-20T00:00:00.000Z",
    },
  }));
}

function signedScenarioLedger(
  results: readonly FounderProductContractScenarioResult[] = lifecycleScenarioResults(),
) {
  return createFounderProductContractScenarioLedger({
    sourceRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    runId: "local-365",
    observedAt: "2026-08-20T00:00:00.000Z",
    results,
    signingSecret: SIGNING_SECRET,
  });
}
