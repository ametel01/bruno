import { describe, expect, it } from "vitest";
import {
  buildFounderInitialGeneralReleaseDecision,
  parseFounderModeratedSummary,
  parseFounderProviderDecisionSummary,
} from "@/scripts/create-founder-general-release-decision";
import { buildFounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS,
  FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS,
} from "@/src/shared/founder-product-contract";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;

describe("Founder Initial General Release decision", () => {
  it("denies a CI artifact without attended usability, accessibility, or provider evidence", () => {
    const decision = buildFounderInitialGeneralReleaseDecision({
      productContract: productContract("ci"),
      moderatedSummary: null,
      providerSummary: null,
    });

    expect(decision).toMatchObject({
      outcome: "denied",
      reasons: [
        "product_contract_not_release_eligible",
        "moderated_founder_evidence_missing",
        "provider_decision_evidence_missing",
      ],
      evidence: { moderatedFounderDigest: null, providerDecisionDigest: null },
      retention: {
        releaseEvidenceDays: 90,
        recordingDays: 30,
        deidentifiedMetricMonths: 24,
      },
    });
  });

  it("approves only the exact release after every attended threshold passes", () => {
    const decision = buildFounderInitialGeneralReleaseDecision({
      productContract: productContract("release"),
      moderatedSummary: parseFounderModeratedSummary(JSON.stringify(moderatedSummary())),
      providerSummary: parseFounderProviderDecisionSummary(JSON.stringify(providerSummary())),
    });

    expect(decision).toMatchObject({
      outcome: "approved",
      reasons: [],
      releaseIdentity: { sourceRevision: REVISION },
      metrics: {
        total: 8,
        desktopFirst: 4,
        phoneFirst: 4,
        independentActivationLeadRecovery: 7,
        firstBriefWithin15MinutesActiveFounderTime: 7,
        fullComprehension: 8,
      },
      providers: { anthropic: { outcome: "hidden", included: false } },
    });
    expect(decision.summaryDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    ["cohort", { participants: { ...moderatedSummary().participants, phoneFirst: 3 } }],
    [
      "activation",
      {
        participants: { ...moderatedSummary().participants, independentActivationLeadRecovery: 6 },
      },
    ],
    [
      "first brief",
      {
        participants: {
          ...moderatedSummary().participants,
          firstBriefWithin15MinutesActiveFounderTime: 6,
        },
      },
    ],
    [
      "comprehension",
      { participants: { ...moderatedSummary().participants, fullComprehension: 7 } },
    ],
    [
      "critical safety",
      { criticalFailures: { ...moderatedSummary().criticalFailures, permissionOrSafety: 1 } },
    ],
  ])("denies when the %s threshold fails", (_name, override) => {
    const summary = moderatedSummary();
    const decision = buildFounderInitialGeneralReleaseDecision({
      productContract: productContract("release"),
      moderatedSummary: parseFounderModeratedSummary(JSON.stringify({ ...summary, ...override })),
      providerSummary: parseFounderProviderDecisionSummary(JSON.stringify(providerSummary())),
    });

    expect(decision.outcome).toBe("denied");
  });

  it("requires every core provider while keeping independently hidden Anthropic excluded", () => {
    const summary = providerSummary();
    summary.providers.gmailSending.outcome = "hidden";
    const decision = buildFounderInitialGeneralReleaseDecision({
      productContract: productContract("release"),
      moderatedSummary: parseFounderModeratedSummary(JSON.stringify(moderatedSummary())),
      providerSummary: parseFounderProviderDecisionSummary(JSON.stringify(summary)),
    });

    expect(decision).toMatchObject({
      outcome: "denied",
      reasons: ["gmailSending_not_released"],
      providers: { anthropic: { outcome: "hidden", included: false } },
    });
  });

  it("rejects malformed summaries without reflecting supplied content", () => {
    expect(() => parseFounderModeratedSummary('{"private":"do-not-print"}')).toThrow(
      "Moderated Founder summary is invalid.",
    );
    expect(() => parseFounderProviderDecisionSummary("not-json-do-not-print")).toThrow(
      "Founder provider decision summary is invalid.",
    );
  });
});

function productContract(mode: "ci" | "release") {
  return buildFounderProductContractEvidence({
    browser: {
      config: { projects: FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.map((name) => ({ name })) },
      stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 },
    },
    unit: { numPassedTests: 156, numFailedTests: 0, numPendingTests: 0 },
    sourceRevision: REVISION,
    runId: "release-370",
    mode,
    observedAt: "2026-08-20T12:00:00.000Z",
    ...(mode === "release"
      ? {
          scenarioResults: FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((id) => ({
            id,
            status: "passed" as const,
            attempts: 1,
            sourceRevision: REVISION,
            observedAt: "2026-08-20T12:00:00.000Z",
            cleanup: {
              status: "passed" as const,
              verified: true,
              resourcesBefore: id === "infrastructure_retirement" ? 2 : 0,
              resourcesAfter: 0,
              observedAt: "2026-08-20T12:00:00.000Z",
            },
          })),
          voiceOverDigest: DIGEST,
          voiceOverOsVersion: "macOS 15.6",
          voiceOverBrowserVersion: "Safari 26.0",
          talkBackDigest: DIGEST,
          talkBackOsVersion: "Android 16",
          talkBackBrowserVersion: "Chrome 140",
        }
      : {}),
  });
}

function moderatedSummary() {
  return {
    schemaVersion: "bruno.moderated-founder-summary.v1",
    evidenceDigest: DIGEST,
    observedAt: "2026-08-20T11:00:00.000Z",
    participants: {
      total: 8,
      desktopFirst: 4,
      phoneFirst: 4,
      crossDeviceDayTwo: 8,
      independentActivationLeadRecovery: 7,
      firstBriefWithin15MinutesActiveFounderTime: 7,
      fullComprehension: 8,
    },
    criticalFailures: {
      permissionOrSafety: 0,
      unintendedExternalEffects: 0,
      unsafeMisunderstandings: 0,
      technicalConfigurationRequirements: 0,
      founderCredentialHandling: 0,
    },
    retention: {
      releaseEvidenceDays: 90,
      recordingDays: 30,
      deidentifiedMetricMonths: 24,
      controlsApplied: true,
    },
  };
}

function providerSummary() {
  const released = { outcome: "released" as "released" | "hidden", evidenceDigest: DIGEST };
  return {
    schemaVersion: "bruno.founder-provider-decision-summary.v1",
    sourceRevision: REVISION,
    evidenceDigest: DIGEST,
    providers: {
      openai: { ...released },
      calendarReading: { ...released },
      gmailReading: { ...released },
      gmailSending: { ...released },
      anthropic: { outcome: "hidden" as "released" | "hidden", evidenceDigest: DIGEST },
    },
  };
}
