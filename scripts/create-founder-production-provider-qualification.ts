export const FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_SCHEMA =
  "bruno.production-provider-qualification-summary.v1";
export const FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;

export const FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_KINDS = [
  "clerk_production",
  "lemon_squeezy_test_mode",
  "lemon_squeezy_live_canary",
] as const;

type QualificationKind = (typeof FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_KINDS)[number];
type QualificationResult = "passed" | "failed";

type QualificationRecord = {
  kind: QualificationKind;
  evidenceClass: "attended_production" | "provider_test_mode" | "attended_live_canary";
  providerEnvironment: "production" | "test" | "live";
  applicationRevision: string;
  runtimeRevision: string;
  observedAt: string;
  expiresAt: string;
  result: QualificationResult;
  attempts: 1;
  failures: 0;
  flakes: 0;
  skips: 0;
  evidenceDigest: `sha256:${string}`;
  sanitized: true;
  checks: Readonly<Record<string, boolean>>;
};

export type FounderClerkProductionQualification = QualificationRecord & {
  kind: "clerk_production";
  evidenceClass: "attended_production";
  providerEnvironment: "production";
  checks: {
    productionAuthentication: boolean;
    crossDeviceSession: boolean;
    identityRecovery: boolean;
    accountClosureBoundary: boolean;
  };
};

export type FounderLemonSqueezyTestModeQualification = QualificationRecord & {
  kind: "lemon_squeezy_test_mode";
  evidenceClass: "provider_test_mode";
  providerEnvironment: "test";
  checks: {
    checkout: boolean;
    signedWebhook: boolean;
    checkoutCorrelation: boolean;
    productEntitlement: boolean;
    customerPortal: boolean;
    cancellation: boolean;
    fullRefund: boolean;
    duplicateDelivery: boolean;
    reorderedDelivery: boolean;
    reconciliation: boolean;
  };
};

export type FounderLemonSqueezyLiveCanaryQualification = QualificationRecord & {
  kind: "lemon_squeezy_live_canary";
  evidenceClass: "attended_live_canary";
  providerEnvironment: "live";
  intendedStoreDigest: `sha256:${string}`;
  observedStoreDigest: `sha256:${string}`;
  intendedProductDigest: `sha256:${string}`;
  observedProductDigest: `sha256:${string}`;
  checks: {
    checkout: boolean;
    realCharge: boolean;
    signedWebhook: boolean;
    checkoutCorrelation: boolean;
    productEntitlement: boolean;
    customerPortal: boolean;
    cancellation: boolean;
    fullRefund: boolean;
    duplicateDelivery: boolean;
    reorderedDelivery: boolean;
    reconciliation: boolean;
    sanitizedCleanup: boolean;
  };
};

export type FounderProductionProviderQualificationSummary = {
  schemaVersion: typeof FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_SCHEMA;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: `sha256:${string}`;
  qualifications: readonly [
    FounderClerkProductionQualification,
    FounderLemonSqueezyTestModeQualification,
    FounderLemonSqueezyLiveCanaryQualification,
  ];
};

export type FounderProductionProviderLiveTargetAuthority = {
  storeDigest: `sha256:${string}`;
  productDigest: `sha256:${string}`;
};

export function parseFounderProductionProviderLiveTargetAuthority(input: {
  storeDigest: string | undefined;
  productDigest: string | undefined;
}): FounderProductionProviderLiveTargetAuthority | null {
  if (
    !isEvidenceDigest(input.storeDigest) ||
    !isEvidenceDigest(input.productDigest) ||
    input.storeDigest === input.productDigest
  ) {
    return null;
  }
  return { storeDigest: input.storeDigest, productDigest: input.productDigest };
}

export function parseFounderProductionProviderQualificationSummary(
  raw: string | undefined,
): FounderProductionProviderQualificationSummary | null {
  if (!raw?.trim()) return null;
  const value = tryParseEvidenceRecord(raw);
  if (
    !value ||
    value.schemaVersion !== FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_SCHEMA ||
    !isGitRevision(value.applicationRevision) ||
    !isRuntimeRevision(value.runtimeRevision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !Array.isArray(value.qualifications) ||
    value.qualifications.length !== FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_KINDS.length
  ) {
    return null;
  }

  const clerk = uniqueQualification(value.qualifications, "clerk_production");
  const testMode = uniqueQualification(value.qualifications, "lemon_squeezy_test_mode");
  const liveCanary = uniqueQualification(value.qualifications, "lemon_squeezy_live_canary");
  if (!clerk || !testMode || !liveCanary) return null;

  const sanitizedClerk = sanitizeClerkQualification(clerk);
  const sanitizedTestMode = sanitizeTestModeQualification(testMode);
  const sanitizedLiveCanary = sanitizeLiveCanaryQualification(liveCanary);
  if (!sanitizedClerk || !sanitizedTestMode || !sanitizedLiveCanary) return null;

  return {
    schemaVersion: FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_SUMMARY_SCHEMA,
    applicationRevision: value.applicationRevision,
    runtimeRevision: value.runtimeRevision,
    evidenceDigest: value.evidenceDigest,
    qualifications: [sanitizedClerk, sanitizedTestMode, sanitizedLiveCanary],
  };
}

export function evaluateFounderProductionProviderQualification(input: {
  summary: FounderProductionProviderQualificationSummary | null;
  applicationRevision: string;
  runtimeRevision: string;
  decisionTime: Date;
  liveTargetAuthority: FounderProductionProviderLiveTargetAuthority | null;
}): readonly string[] {
  const { summary } = input;
  if (!summary) return ["production_provider_qualification_evidence_missing"];

  const reasons: string[] = [];
  if (summary.applicationRevision !== input.applicationRevision) {
    reasons.push("production_provider_qualification_revision_mismatch");
  }
  if (summary.runtimeRevision !== input.runtimeRevision) {
    reasons.push("production_provider_qualification_runtime_mismatch");
  }

  for (const qualification of summary.qualifications) {
    if (qualification.applicationRevision !== input.applicationRevision) {
      reasons.push(`${qualification.kind}_revision_mismatch`);
    }
    if (qualification.runtimeRevision !== input.runtimeRevision) {
      reasons.push(`${qualification.kind}_runtime_mismatch`);
    }
    if (qualification.result !== "passed") {
      reasons.push(`${qualification.kind}_failed`);
    }
    if (
      qualification.attempts !== 1 ||
      qualification.failures !== 0 ||
      qualification.flakes !== 0 ||
      qualification.skips !== 0
    ) {
      reasons.push(`${qualification.kind}_attempts_unclean`);
    }
    if (Object.values(qualification.checks).some((result) => result !== true)) {
      reasons.push(`${qualification.kind}_incomplete`);
    }

    const observedAt = new Date(qualification.observedAt);
    const expiresAt = new Date(qualification.expiresAt);
    if (observedAt > input.decisionTime) {
      reasons.push(`${qualification.kind}_evidence_time_invalid`);
    } else if (expiresAt <= input.decisionTime) {
      reasons.push(`${qualification.kind}_evidence_expired`);
    } else if (
      input.decisionTime.valueOf() - observedAt.valueOf() >
        FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_MAX_AGE_MS ||
      expiresAt.valueOf() - observedAt.valueOf() >
        FOUNDER_PRODUCTION_PROVIDER_QUALIFICATION_MAX_AGE_MS
    ) {
      reasons.push(`${qualification.kind}_evidence_stale`);
    }
  }

  const liveCanary = summary.qualifications[2];
  if (!input.liveTargetAuthority) {
    reasons.push("lemon_squeezy_live_target_authority_missing");
  } else if (
    liveCanary.intendedStoreDigest !== input.liveTargetAuthority.storeDigest ||
    liveCanary.observedStoreDigest !== input.liveTargetAuthority.storeDigest
  ) {
    reasons.push("lemon_squeezy_live_store_mismatch");
  }
  if (
    input.liveTargetAuthority &&
    (liveCanary.intendedProductDigest !== input.liveTargetAuthority.productDigest ||
      liveCanary.observedProductDigest !== input.liveTargetAuthority.productDigest)
  ) {
    reasons.push("lemon_squeezy_live_product_mismatch");
  }
  if (liveCanary.intendedStoreDigest === liveCanary.intendedProductDigest) {
    reasons.push("lemon_squeezy_live_store_product_alias");
  }
  if (
    new Set(summary.qualifications.map(({ evidenceDigest }) => evidenceDigest)).size !==
    summary.qualifications.length
  ) {
    reasons.push("production_provider_qualification_evidence_not_independent");
  }
  if (
    summary.qualifications.some(({ evidenceDigest }) => evidenceDigest === summary.evidenceDigest)
  ) {
    reasons.push("production_provider_qualification_summary_digest_reused");
  }

  return reasons;
}

function sanitizeClerkQualification(value: Record<string, unknown>) {
  const common = sanitizeCommonQualification(value, {
    kind: "clerk_production",
    evidenceClass: "attended_production",
    providerEnvironment: "production",
    checkNames: [
      "productionAuthentication",
      "crossDeviceSession",
      "identityRecovery",
      "accountClosureBoundary",
    ],
  });
  if (!common) return null;
  return common as FounderClerkProductionQualification;
}

function sanitizeTestModeQualification(value: Record<string, unknown>) {
  const common = sanitizeCommonQualification(value, {
    kind: "lemon_squeezy_test_mode",
    evidenceClass: "provider_test_mode",
    providerEnvironment: "test",
    checkNames: [
      "checkout",
      "signedWebhook",
      "checkoutCorrelation",
      "productEntitlement",
      "customerPortal",
      "cancellation",
      "fullRefund",
      "duplicateDelivery",
      "reorderedDelivery",
      "reconciliation",
    ],
  });
  if (!common) return null;
  return common as FounderLemonSqueezyTestModeQualification;
}

function sanitizeLiveCanaryQualification(value: Record<string, unknown>) {
  const common = sanitizeCommonQualification(value, {
    kind: "lemon_squeezy_live_canary",
    evidenceClass: "attended_live_canary",
    providerEnvironment: "live",
    checkNames: [
      "checkout",
      "realCharge",
      "signedWebhook",
      "checkoutCorrelation",
      "productEntitlement",
      "customerPortal",
      "cancellation",
      "fullRefund",
      "duplicateDelivery",
      "reorderedDelivery",
      "reconciliation",
      "sanitizedCleanup",
    ],
  });
  if (
    !common ||
    !isEvidenceDigest(value.intendedStoreDigest) ||
    !isEvidenceDigest(value.observedStoreDigest) ||
    !isEvidenceDigest(value.intendedProductDigest) ||
    !isEvidenceDigest(value.observedProductDigest)
  ) {
    return null;
  }
  return {
    ...common,
    intendedStoreDigest: value.intendedStoreDigest,
    observedStoreDigest: value.observedStoreDigest,
    intendedProductDigest: value.intendedProductDigest,
    observedProductDigest: value.observedProductDigest,
  } as FounderLemonSqueezyLiveCanaryQualification;
}

function sanitizeCommonQualification(
  value: Record<string, unknown>,
  expected: {
    kind: QualificationKind;
    evidenceClass: QualificationRecord["evidenceClass"];
    providerEnvironment: QualificationRecord["providerEnvironment"];
    checkNames: readonly string[];
  },
): QualificationRecord | null {
  const checks = value.checks;
  if (
    value.kind !== expected.kind ||
    value.evidenceClass !== expected.evidenceClass ||
    value.providerEnvironment !== expected.providerEnvironment ||
    !isGitRevision(value.applicationRevision) ||
    !isRuntimeRevision(value.runtimeRevision) ||
    !isExactInstant(value.observedAt) ||
    !isExactInstant(value.expiresAt) ||
    (value.result !== "passed" && value.result !== "failed") ||
    value.attempts !== 1 ||
    value.failures !== 0 ||
    value.flakes !== 0 ||
    value.skips !== 0 ||
    !isEvidenceDigest(value.evidenceDigest) ||
    value.sanitized !== true ||
    !isEvidenceRecord(checks) ||
    !expected.checkNames.every((check) => typeof checks[check] === "boolean")
  ) {
    return null;
  }

  return {
    kind: expected.kind,
    evidenceClass: expected.evidenceClass,
    providerEnvironment: expected.providerEnvironment,
    applicationRevision: value.applicationRevision,
    runtimeRevision: value.runtimeRevision,
    observedAt: value.observedAt,
    expiresAt: value.expiresAt,
    result: value.result,
    attempts: 1,
    failures: 0,
    flakes: 0,
    skips: 0,
    evidenceDigest: value.evidenceDigest,
    sanitized: true,
    checks: Object.fromEntries(expected.checkNames.map((check) => [check, checks[check]])) as
      | FounderClerkProductionQualification["checks"]
      | FounderLemonSqueezyTestModeQualification["checks"]
      | FounderLemonSqueezyLiveCanaryQualification["checks"],
  };
}

function uniqueQualification(
  values: unknown[],
  kind: QualificationKind,
): Record<string, unknown> | null {
  const matches = values.filter(
    (value): value is Record<string, unknown> => isEvidenceRecord(value) && value.kind === kind,
  );
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

import {
  isEvidenceDigest,
  isEvidenceRecord,
  isExactInstant,
  isGitRevision,
  isRuntimeRevision,
  tryParseEvidenceRecord,
} from "@/scripts/founder-release-evidence-validation";
