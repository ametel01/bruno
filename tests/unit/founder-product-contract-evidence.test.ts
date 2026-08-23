import { describe, expect, it } from "vitest";
import { buildFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA,
  type FounderAttendedAccessibilitySummary,
  parseFounderAttendedAccessibilitySummary,
} from "@/scripts/founder-attended-accessibility-summary";
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
const DIGEST = `sha256:${"b".repeat(64)}` as `sha256:${string}`;
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

  it("requires each attended record to preserve its exact observation time and runtime", () => {
    const input = validAttendedInput();
    input.voiceOverSummary.observedAt = "not-a-time";
    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      "VoiceOver observed time is invalid",
    );
  });

  it("does not synthesize an omitted zero claim into complete attended evidence", () => {
    const summary = attendedSummary("VoiceOver");
    const serialized = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
    delete serialized.failures;

    expect(() =>
      parseFounderAttendedAccessibilitySummary({
        raw: JSON.stringify(serialized),
        assistiveTechnology: "VoiceOver",
        browser: "Safari",
      }),
    ).toThrow("VoiceOver attended accessibility summary is invalid");
  });

  it("parses only the strict sanitized attended summary and preserves every supplied count", () => {
    const summary = attendedSummary("VoiceOver");

    expect(
      parseFounderAttendedAccessibilitySummary({
        raw: JSON.stringify(summary),
        assistiveTechnology: "VoiceOver",
        browser: "Safari",
      }),
    ).toEqual(summary);
    expect(
      parseFounderAttendedAccessibilitySummary({
        raw: "   ",
        assistiveTechnology: "VoiceOver",
        browser: "Safari",
      }),
    ).toBeNull();
  });

  it.each([
    ["malformed JSON", "not-json-do-not-print"],
    ["wrong technology", JSON.stringify(attendedSummary("TalkBack"))],
    [
      "extended payload",
      JSON.stringify({ ...attendedSummary("VoiceOver"), participantIdentity: "do-not-retain" }),
    ],
    [
      "extended participant boundary",
      JSON.stringify({
        ...attendedSummary("VoiceOver"),
        participantBoundary: {
          ...attendedSummary("VoiceOver").participantBoundary,
          participantIdentity: "do-not-retain",
        },
      }),
    ],
  ])("fails closed on a %s without echoing supplied content", (_case, raw) => {
    expect(() =>
      parseFounderAttendedAccessibilitySummary({
        raw,
        assistiveTechnology: "VoiceOver",
        browser: "Safari",
      }),
    ).toThrow("VoiceOver attended accessibility summary is invalid.");
  });

  it.each([
    ["VoiceOver", "voiceOverSummary"],
    ["TalkBack", "talkBackSummary"],
  ] as const)("rejects %s evidence from a different contract runtime", (label, summaryField) => {
    const input = validAttendedInput();
    input[summaryField].runtimeRevision = "runtime-release-v2";

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      `${label} runtime revision does not match the contract`,
    );
  });

  it("rejects attended evidence from a different application revision", () => {
    const input = validAttendedInput();
    input.voiceOverSummary.applicationRevision = "c".repeat(40);

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      "VoiceOver source revision does not match the contract",
    );
  });

  it.each([
    ["VoiceOver", "voiceOverSummary", "attempts", 2],
    ["VoiceOver", "voiceOverSummary", "failures", 1],
    ["VoiceOver", "voiceOverSummary", "flakes", 1],
    ["VoiceOver", "voiceOverSummary", "skips", 1],
    ["TalkBack", "talkBackSummary", "attempts", 2],
    ["TalkBack", "talkBackSummary", "failures", 1],
    ["TalkBack", "talkBackSummary", "flakes", 1],
    ["TalkBack", "talkBackSummary", "skips", 1],
  ] as const)("rejects a non-clean %s attended result", (label, summaryField, field, value) => {
    const input = validAttendedInput();
    input[summaryField][field] = value;

    expect(() => buildFounderProductContractEvidence(input)).toThrow(
      `${label} evidence must have exactly one clean attempt`,
    );
  });

  it.each([
    ["VoiceOver", "voiceOverSummary", "independentHumanReviewers", 0],
    ["VoiceOver", "voiceOverSummary", "automatedRuns", 1],
    ["VoiceOver", "voiceOverSummary", "ownerParticipants", 1],
    ["VoiceOver", "voiceOverSummary", "selfTests", 1],
    ["VoiceOver", "voiceOverSummary", "friendOrFamilyParticipants", 1],
    ["VoiceOver", "voiceOverSummary", "supportInterventions", 1],
    ["VoiceOver", "voiceOverSummary", "externalBetaParticipants", 1],
    ["VoiceOver", "voiceOverSummary", "coachedParticipants", 1],
    ["VoiceOver", "voiceOverSummary", "facilitatorRescues", 1],
    ["VoiceOver", "voiceOverSummary", "trustedPreviewParticipants", 1],
    ["VoiceOver", "voiceOverSummary", "buildTeamParticipants", 1],
    ["TalkBack", "talkBackSummary", "independentHumanReviewers", 0],
    ["TalkBack", "talkBackSummary", "automatedRuns", 1],
    ["TalkBack", "talkBackSummary", "ownerParticipants", 1],
    ["TalkBack", "talkBackSummary", "selfTests", 1],
    ["TalkBack", "talkBackSummary", "friendOrFamilyParticipants", 1],
    ["TalkBack", "talkBackSummary", "supportInterventions", 1],
    ["TalkBack", "talkBackSummary", "externalBetaParticipants", 1],
    ["TalkBack", "talkBackSummary", "coachedParticipants", 1],
    ["TalkBack", "talkBackSummary", "facilitatorRescues", 1],
    ["TalkBack", "talkBackSummary", "trustedPreviewParticipants", 1],
    ["TalkBack", "talkBackSummary", "buildTeamParticipants", 1],
  ] as const)("rejects a prohibited %s participant/source boundary", (label, summaryField, field, value) => {
    const input = validAttendedInput();
    input[summaryField].participantBoundary[field] = value;

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
    voiceOverSummary: attendedSummary("VoiceOver"),
    talkBackSummary: attendedSummary("TalkBack"),
  };
}

function attendedSummary(
  assistiveTechnology: "VoiceOver" | "TalkBack",
): FounderAttendedAccessibilitySummary {
  return {
    schemaVersion: FOUNDER_ATTENDED_ACCESSIBILITY_SUMMARY_SCHEMA,
    assistiveTechnology,
    browser: assistiveTechnology === "VoiceOver" ? "Safari" : "Chrome",
    applicationRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    evidenceDigest: DIGEST,
    osVersion: assistiveTechnology === "VoiceOver" ? "macOS 15.6" : "Android 16",
    browserVersion: assistiveTechnology === "VoiceOver" ? "Safari 26.0" : "Chrome 140",
    observedAt: "2026-08-20T00:00:00.000Z",
    attempts: 1,
    failures: 0,
    flakes: 0,
    skips: 0,
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
    sanitized: true,
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
