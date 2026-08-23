import { describe, expect, it } from "vitest";
import {
  evaluateFounderProductionProviderQualification,
  parseFounderProductionProviderQualificationSummary,
} from "@/scripts/create-founder-production-provider-qualification";

const APPLICATION_REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-release-v1";
const DECISION_TIME = new Date("2026-08-20T12:00:00.000Z");

type MutableQualification = {
  kind: string;
  evidenceClass: string;
  providerEnvironment: string;
  applicationRevision: string;
  runtimeRevision: string;
  observedAt: string;
  expiresAt: string;
  result: string;
  evidenceDigest: string;
  sanitized: boolean;
  checks: Record<string, boolean>;
  intendedStoreDigest?: string;
  observedStoreDigest?: string;
  intendedProductDigest?: string;
  observedProductDigest?: string;
  [key: string]: unknown;
};

type MutableSummary = {
  schemaVersion: string;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: string;
  qualifications: MutableQualification[];
  [key: string]: unknown;
};

describe("Founder production provider qualification", () => {
  it("accepts only independently bound Clerk production, Lemon test-mode, and live-canary evidence", () => {
    const summary = parse(summaryValue());

    expect(summary).toMatchObject({
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: RUNTIME_REVISION,
      qualifications: [
        {
          kind: "clerk_production",
          evidenceClass: "attended_production",
          providerEnvironment: "production",
        },
        {
          kind: "lemon_squeezy_test_mode",
          evidenceClass: "provider_test_mode",
          providerEnvironment: "test",
        },
        {
          kind: "lemon_squeezy_live_canary",
          evidenceClass: "attended_live_canary",
          providerEnvironment: "live",
        },
      ],
    });
    expect(
      evaluateFounderProductionProviderQualification({
        summary,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: RUNTIME_REVISION,
        decisionTime: DECISION_TIME,
      }),
    ).toEqual([]);
  });

  it("treats absent, malformed, duplicate, incomplete, or test-as-live records as missing evidence", () => {
    expect(parseFounderProductionProviderQualificationSummary(undefined)).toBeNull();
    expect(parseFounderProductionProviderQualificationSummary("not-json-do-not-print")).toBeNull();

    const cases = [
      withMutation((value) => value.qualifications.pop()),
      withMutation((value) => {
        value.qualifications[2] = structuredClone(qualification(value, 1));
      }),
      withMutation((value) => {
        delete qualification(value, 0).checks.identityRecovery;
      }),
      withMutation((value) => {
        qualification(value, 2).providerEnvironment = "test";
      }),
      withMutation((value) => {
        qualification(value, 2).evidenceClass = "provider_test_mode";
      }),
    ];

    for (const value of cases) {
      expect(parseFounderProductionProviderQualificationSummary(JSON.stringify(value))).toBeNull();
    }
  });

  it("drops unrestricted fields instead of retaining secrets, identities, payment data, or payloads", () => {
    const value = summaryValue();
    value.webhookSecret = "do-not-retain";
    qualification(value, 0).identity = "do-not-retain";
    qualification(value, 1).providerPayload = "do-not-retain";
    qualification(value, 2).paymentDetails = "do-not-retain";

    const summary = parse(value);

    expect(JSON.stringify(summary)).not.toContain("do-not-retain");
  });

  it("denies failed or incomplete attended evidence without turning CI checks into provider proof", () => {
    const value = summaryValue();
    qualification(value, 0).result = "failed";
    qualification(value, 1).checks.duplicateDelivery = false;
    qualification(value, 2).checks.sanitizedCleanup = false;

    expect(evaluate(parse(value))).toEqual([
      "clerk_production_failed",
      "lemon_squeezy_test_mode_incomplete",
      "lemon_squeezy_live_canary_incomplete",
    ]);
  });

  it("denies app/runtime mismatches, future, stale, expired, and duplicate evidence", () => {
    const value = summaryValue();
    value.applicationRevision = "b".repeat(40);
    value.runtimeRevision = "runtime-release-v2";
    qualification(value, 0).applicationRevision = "b".repeat(40);
    qualification(value, 0).observedAt = "2026-08-20T12:00:01.000Z";
    qualification(value, 1).runtimeRevision = "runtime-release-v2";
    qualification(value, 1).observedAt = "2026-08-10T12:00:00.000Z";
    qualification(value, 1).expiresAt = "2026-08-27T11:00:00.000Z";
    qualification(value, 2).expiresAt = "2026-08-20T12:00:00.000Z";
    qualification(value, 2).evidenceDigest = qualification(value, 1).evidenceDigest;

    expect(evaluate(parse(value))).toEqual([
      "production_provider_qualification_revision_mismatch",
      "production_provider_qualification_runtime_mismatch",
      "clerk_production_revision_mismatch",
      "clerk_production_evidence_time_invalid",
      "lemon_squeezy_test_mode_runtime_mismatch",
      "lemon_squeezy_test_mode_evidence_stale",
      "lemon_squeezy_live_canary_evidence_expired",
      "production_provider_qualification_evidence_not_independent",
    ]);
  });

  it("denies a live canary that observed a different or aliased intended store and product", () => {
    const value = summaryValue();
    qualification(value, 2).observedStoreDigest = `sha256:${"d".repeat(64)}`;
    qualification(value, 2).observedProductDigest = `sha256:${"e".repeat(64)}`;
    qualification(value, 2).intendedProductDigest = `sha256:${"a".repeat(64)}`;

    expect(evaluate(parse(value))).toEqual([
      "lemon_squeezy_live_store_mismatch",
      "lemon_squeezy_live_product_mismatch",
      "lemon_squeezy_live_store_product_alias",
    ]);
  });

  it("denies reuse of a record digest as the aggregate summary digest", () => {
    const value = summaryValue();
    value.evidenceDigest = qualification(value, 0).evidenceDigest;

    expect(evaluate(parse(value))).toEqual([
      "production_provider_qualification_summary_digest_reused",
    ]);
  });
});

function parse(value: MutableSummary) {
  const parsed = parseFounderProductionProviderQualificationSummary(JSON.stringify(value));
  if (!parsed) throw new Error("Expected production provider qualification to parse.");
  return parsed;
}

function evaluate(summary: ReturnType<typeof parse>) {
  return evaluateFounderProductionProviderQualification({
    summary,
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: RUNTIME_REVISION,
    decisionTime: DECISION_TIME,
  });
}

function withMutation(mutate: (value: MutableSummary) => void) {
  const value = summaryValue();
  mutate(value);
  return value;
}

function qualification(value: MutableSummary, index: number): MutableQualification {
  const record = value.qualifications[index];
  if (!record) throw new Error(`Expected qualification at index ${index}.`);
  return record;
}

function summaryValue(): MutableSummary {
  const common = (digit: string) => ({
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: RUNTIME_REVISION,
    observedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    result: "passed",
    evidenceDigest: `sha256:${digit.repeat(64)}`,
    sanitized: true,
  });
  const lemonChecks = {
    checkout: true,
    signedWebhook: true,
    checkoutCorrelation: true,
    productEntitlement: true,
    customerPortal: true,
    cancellation: true,
    fullRefund: true,
    duplicateDelivery: true,
    reorderedDelivery: true,
    reconciliation: true,
  };

  return {
    schemaVersion: "bruno.production-provider-qualification-summary.v1",
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: RUNTIME_REVISION,
    evidenceDigest: `sha256:${"9".repeat(64)}`,
    qualifications: [
      {
        ...common("6"),
        kind: "clerk_production",
        evidenceClass: "attended_production",
        providerEnvironment: "production",
        checks: {
          productionAuthentication: true,
          crossDeviceSession: true,
          identityRecovery: true,
          accountClosureBoundary: true,
        } as Record<string, boolean>,
      },
      {
        ...common("7"),
        kind: "lemon_squeezy_test_mode",
        evidenceClass: "provider_test_mode",
        providerEnvironment: "test",
        checks: { ...lemonChecks } as Record<string, boolean>,
      },
      {
        ...common("8"),
        kind: "lemon_squeezy_live_canary",
        evidenceClass: "attended_live_canary",
        providerEnvironment: "live",
        intendedStoreDigest: `sha256:${"a".repeat(64)}`,
        observedStoreDigest: `sha256:${"a".repeat(64)}`,
        intendedProductDigest: `sha256:${"c".repeat(64)}`,
        observedProductDigest: `sha256:${"c".repeat(64)}`,
        checks: { ...lemonChecks, realCharge: true, sanitizedCleanup: true } as Record<
          string,
          boolean
        >,
      },
    ],
  };
}
