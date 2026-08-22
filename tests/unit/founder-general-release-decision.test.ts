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
import { createFounderProductContractScenarioLedger } from "@/src/testing/founder-product-contract";

const REVISION = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const SIGNING_SECRET = "founder-contract-test-secret";

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
      providers: { anthropic: { outcome: "released", sourceRevision: REVISION } },
      providerPolicy: {
        requiredForRelease: [
          "openai",
          "anthropic",
          "calendar_reading",
          "gmail_reading",
          "gmail_sending",
        ],
        founderChoice: "openai_anthropic_or_both",
        routingAuthority: "founder_authorized_connections_only",
        capacity: "founder_owned_no_bruno_funded_fallback",
        qualificationLoss: "capability_scoped_hold_at_safe_work_checkpoint",
      },
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

  it.each([
    "openai",
    "anthropic",
    "calendarReading",
    "gmailReading",
    "gmailSending",
  ] as const)("denies when independently required %s evidence is hidden", (provider) => {
    const summary = providerSummary();
    summary.providers[provider].outcome = "hidden";
    const decision = generalReleaseDecision(summary);

    expect(decision).toMatchObject({
      outcome: "denied",
      reasons: [`${provider}_not_released`],
    });
  });

  it("denies revision-mismatched, stale, expired, and future-dated provider evidence", () => {
    const summary = providerSummary();
    summary.providers.openai.sourceRevision = "c".repeat(40);
    summary.providers.anthropic.qualifiedAt = "2026-08-10T12:00:00.000Z";
    summary.providers.calendarReading.expiresAt = "2026-08-20T12:00:00.000Z";
    summary.providers.gmailReading.qualifiedAt = "2026-08-20T12:00:01.000Z";

    expect(generalReleaseDecision(summary)).toMatchObject({
      outcome: "denied",
      reasons: [
        "openai_revision_mismatch",
        "anthropic_evidence_stale",
        "calendarReading_evidence_expired",
        "gmailReading_evidence_time_invalid",
      ],
    });
  });

  it("does not let OpenAI, Anthropic, or a Core Operation capability borrow evidence", () => {
    const summary = providerSummary();
    summary.providers.anthropic.evidenceDigest = summary.providers.openai.evidenceDigest;

    expect(generalReleaseDecision(summary)).toMatchObject({
      outcome: "denied",
      reasons: ["provider_evidence_not_independent"],
    });
  });

  it("keeps only the provider evidence allowlist in the retained decision", () => {
    const summary = providerSummary() as ReturnType<typeof providerSummary> & {
      private?: string;
      providers: ReturnType<typeof providerSummary>["providers"] & {
        openai: ReturnType<typeof providerSummary>["providers"]["openai"] & {
          credential?: string;
        };
      };
    };
    summary.private = "do-not-retain";
    summary.providers.openai.credential = "do-not-retain";

    const decision = generalReleaseDecision(summary);

    expect(decision.outcome).toBe("approved");
    expect(JSON.stringify(decision)).not.toContain("do-not-retain");
  });

  it("rejects malformed summaries without reflecting supplied content", () => {
    expect(() => parseFounderModeratedSummary('{"private":"do-not-print"}')).toThrow(
      "Moderated Founder summary is invalid.",
    );
    expect(() => parseFounderProviderDecisionSummary("not-json-do-not-print")).toThrow(
      "Founder provider decision summary is invalid.",
    );
    const missingAnthropic = providerSummary();
    delete (missingAnthropic.providers as Partial<typeof missingAnthropic.providers>).anthropic;
    expect(() =>
      parseFounderProviderDecisionSummary(
        JSON.stringify({ ...missingAnthropic, private: "do-not-print" }),
      ),
    ).toThrow("Founder provider decision summary is invalid.");
  });
});

function generalReleaseDecision(summary = providerSummary()) {
  return buildFounderInitialGeneralReleaseDecision({
    productContract: productContract("release"),
    moderatedSummary: parseFounderModeratedSummary(JSON.stringify(moderatedSummary())),
    providerSummary: parseFounderProviderDecisionSummary(JSON.stringify(summary)),
  });
}

function productContract(mode: "ci" | "release") {
  return buildFounderProductContractEvidence({
    browser: {
      config: { projects: FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS.map((name) => ({ name })) },
      stats: { expected: 5, unexpected: 0, flaky: 0, skipped: 0 },
    },
    unit: { numPassedTests: 156, numFailedTests: 0, numPendingTests: 0 },
    sourceRevision: REVISION,
    runId: "release-370",
    runAttempt: 1,
    mode,
    observedAt: "2026-08-20T12:00:00.000Z",
    scenarioLedger: createFounderProductContractScenarioLedger({
      sourceRevision: REVISION,
      runId: "release-370",
      observedAt: "2026-08-20T12:00:00.000Z",
      results: lifecycleScenarioResults(),
      signingSecret: SIGNING_SECRET,
    }),
    scenarioSigningSecret: SIGNING_SECRET,
    ...(mode === "release"
      ? {
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

function lifecycleScenarioResults() {
  return FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.map((id) => ({
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
  }));
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
  const released = (digit: string) => ({
    outcome: "released" as "released" | "hidden",
    sourceRevision: REVISION,
    qualifiedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    evidenceDigest: `sha256:${digit.repeat(64)}` as `sha256:${string}`,
  });
  return {
    schemaVersion: "bruno.founder-provider-decision-summary.v1",
    sourceRevision: REVISION,
    evidenceDigest: DIGEST,
    providers: {
      openai: released("1"),
      anthropic: released("2"),
      calendarReading: released("3"),
      gmailReading: released("4"),
      gmailSending: released("5"),
    },
  };
}
