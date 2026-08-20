import { describe, expect, it } from "vitest";
import { buildFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import { FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS } from "@/src/shared/founder-product-contract";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("Founder Product Contract evidence", () => {
  it("emits an allowlisted exact-release summary while keeping attended evidence explicit", () => {
    const evidence = buildFounderProductContractEvidence(validInput());

    expect(evidence).toMatchObject({
      result: "passed",
      releaseEligible: false,
      releaseIdentity: { sourceRevision: REVISION, runId: "local-365" },
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
      scenarioResults: lifecycleScenarioResults(),
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

  it("refuses attended evidence whose environment metadata is incomplete", () => {
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        voiceOverDigest: DIGEST,
      }),
    ).toThrow("VoiceOver evidence metadata is incomplete.");
  });

  it("accepts an exact lifecycle ledger and rejects a missing required scenario", () => {
    const scenarioResults = [
      "release_stage_admission",
      "product_entitlement_lifecycle",
      "recovery_archive_lifecycle",
      "infrastructure_retirement",
    ].map((id) => ({
      id,
      status: "passed" as const,
      attempts: 1,
      sourceRevision: REVISION,
      observedAt: "2026-08-20T00:00:00.000Z",
    }));
    const evidence = buildFounderProductContractEvidence({
      ...validInput(),
      scenarioResults,
    });

    expect(evidence.scenarios).toEqual(
      scenarioResults.map(({ id, status, attempts }) => ({ id, status, attempts })),
    );
    expect(() =>
      buildFounderProductContractEvidence({
        ...validInput(),
        scenarioResults: scenarioResults.slice(1),
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
    runId: "local-365",
    mode: "ci" as const,
    observedAt: "2026-08-20T00:00:00.000Z",
  };
}

function lifecycleScenarioResults() {
  return [
    "release_stage_admission",
    "product_entitlement_lifecycle",
    "recovery_archive_lifecycle",
    "infrastructure_retirement",
  ].map((id) => ({
    id,
    status: "passed" as const,
    attempts: 1,
    sourceRevision: REVISION,
    observedAt: "2026-08-20T00:00:00.000Z",
  }));
}
