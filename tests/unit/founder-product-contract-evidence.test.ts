import { describe, expect, it } from "vitest";
import { buildFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS,
  FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
} from "@/src/shared/founder-product-contract";
import {
  createFounderProductContractScenarioLedger,
  parseFounderProductContractScenarioLedger,
  sanitizeFounderProductContractScenarioResult,
  type FounderProductContractScenarioResult,
} from "@/src/testing/founder-product-contract";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNING_SECRET = "founder-contract-test-secret";

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
    const evidence = buildFounderProductContractEvidence({
      ...validInput(),
      mode: "release",
      voiceOverDigest: DIGEST,
      voiceOverOsVersion: "macOS 15.6",
      voiceOverBrowserVersion: "Safari 26.0",
      talkBackDigest: DIGEST,
      talkBackOsVersion: "Android 16",
      talkBackBrowserVersion: "Chrome 140",
    });

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
        ...validInput(),
        mode: "release",
        scenarioLedger: signedScenarioLedger([]),
        voiceOverDigest: DIGEST,
        voiceOverOsVersion: "macOS 15.6",
        voiceOverBrowserVersion: "Safari 26.0",
        talkBackDigest: DIGEST,
        talkBackOsVersion: "Android 16",
        talkBackBrowserVersion: "Chrome 140",
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
        runId: "local-365",
        observedAt: "2026-08-20T00:00:00.000Z",
        signingSecret: SIGNING_SECRET,
      }),
    ).toThrow("is invalid");

    expect(() =>
      parseFounderProductContractScenarioLedger({
        value: JSON.stringify({ ...ledger, signature: "hmac-sha256:forged" }),
        sourceRevision: REVISION,
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
      schemaVersion: "bruno.founder-product-contract.scenario-ledger.v1",
      producer: "bruno.persisted-founder-application",
      sourceRevision: REVISION,
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
    runtimeRevision: "runtime-release-v1",
    runId: "local-365",
    runAttempt: 1,
    mode: "ci" as const,
    observedAt: "2026-08-20T00:00:00.000Z",
    scenarioLedger: signedScenarioLedger(),
    scenarioSigningSecret: SIGNING_SECRET,
  };
}

function lifecycleScenarioResults() {
  return FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((id) => ({
    id,
    status: "passed" as const,
    attempts: 1,
    sourceRevision: REVISION,
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
    runId: "local-365",
    observedAt: "2026-08-20T00:00:00.000Z",
    results,
    signingSecret: SIGNING_SECRET,
  });
}
