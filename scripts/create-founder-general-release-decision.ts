import { createHash } from "node:crypto";
import type { FounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";

export const FOUNDER_MODERATED_SUMMARY_SCHEMA = "bruno.moderated-founder-summary.v1";
export const FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA =
  "bruno.founder-provider-decision-summary.v1";
export const FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA =
  "bruno.founder-initial-general-release-decision.v1";
export const FOUNDER_PROVIDER_DECISION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;

export type FounderModeratedSummary = {
  schemaVersion: typeof FOUNDER_MODERATED_SUMMARY_SCHEMA;
  evidenceDigest: `sha256:${string}`;
  observedAt: string;
  participants: {
    total: number;
    desktopFirst: number;
    phoneFirst: number;
    crossDeviceDayTwo: number;
    independentActivationLeadRecovery: number;
    firstBriefWithin15MinutesActiveFounderTime: number;
    fullComprehension: number;
  };
  criticalFailures: {
    permissionOrSafety: number;
    unintendedExternalEffects: number;
    unsafeMisunderstandings: number;
    technicalConfigurationRequirements: number;
    founderCredentialHandling: number;
  };
  retention: {
    releaseEvidenceDays: 90;
    recordingDays: 30;
    deidentifiedMetricMonths: 24;
    controlsApplied: true;
  };
};

type ProviderDecision = {
  outcome: "released" | "hidden";
  sourceRevision: string;
  qualifiedAt: string;
  expiresAt: string;
  evidenceDigest: `sha256:${string}`;
};

export type FounderProviderDecisionSummary = {
  schemaVersion: typeof FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA;
  sourceRevision: string;
  evidenceDigest: `sha256:${string}`;
  providers: {
    openai: ProviderDecision;
    calendarReading: ProviderDecision;
    gmailReading: ProviderDecision;
    gmailSending: ProviderDecision;
    anthropic: ProviderDecision;
  };
};

export function parseFounderModeratedSummary(
  raw: string | undefined,
): FounderModeratedSummary | null {
  if (!raw?.trim()) return null;
  const value = parseRecord(raw, "Moderated Founder summary");
  if (
    value.schemaVersion !== FOUNDER_MODERATED_SUMMARY_SCHEMA ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isExactInstant(value.observedAt) ||
    !isRecord(value.participants) ||
    !isRecord(value.criticalFailures) ||
    !isRecord(value.retention)
  ) {
    throw new Error("Moderated Founder summary is invalid.");
  }
  const participantKeys = [
    "total",
    "desktopFirst",
    "phoneFirst",
    "crossDeviceDayTwo",
    "independentActivationLeadRecovery",
    "firstBriefWithin15MinutesActiveFounderTime",
    "fullComprehension",
  ];
  const failureKeys = [
    "permissionOrSafety",
    "unintendedExternalEffects",
    "unsafeMisunderstandings",
    "technicalConfigurationRequirements",
    "founderCredentialHandling",
  ];
  const participants = value.participants;
  const criticalFailures = value.criticalFailures;
  const retention = value.retention;
  if (
    !participantKeys.every((key) => isCount(participants[key])) ||
    !failureKeys.every((key) => isCount(criticalFailures[key])) ||
    retention.releaseEvidenceDays !== 90 ||
    retention.recordingDays !== 30 ||
    retention.deidentifiedMetricMonths !== 24 ||
    retention.controlsApplied !== true
  ) {
    throw new Error("Moderated Founder summary is invalid.");
  }
  return {
    schemaVersion: FOUNDER_MODERATED_SUMMARY_SCHEMA,
    evidenceDigest: value.evidenceDigest as `sha256:${string}`,
    observedAt: value.observedAt as string,
    participants: {
      total: participants.total as number,
      desktopFirst: participants.desktopFirst as number,
      phoneFirst: participants.phoneFirst as number,
      crossDeviceDayTwo: participants.crossDeviceDayTwo as number,
      independentActivationLeadRecovery: participants.independentActivationLeadRecovery as number,
      firstBriefWithin15MinutesActiveFounderTime:
        participants.firstBriefWithin15MinutesActiveFounderTime as number,
      fullComprehension: participants.fullComprehension as number,
    },
    criticalFailures: {
      permissionOrSafety: criticalFailures.permissionOrSafety as number,
      unintendedExternalEffects: criticalFailures.unintendedExternalEffects as number,
      unsafeMisunderstandings: criticalFailures.unsafeMisunderstandings as number,
      technicalConfigurationRequirements:
        criticalFailures.technicalConfigurationRequirements as number,
      founderCredentialHandling: criticalFailures.founderCredentialHandling as number,
    },
    retention: {
      releaseEvidenceDays: 90,
      recordingDays: 30,
      deidentifiedMetricMonths: 24,
      controlsApplied: true,
    },
  };
}

export function parseFounderProviderDecisionSummary(
  raw: string | undefined,
): FounderProviderDecisionSummary | null {
  if (!raw?.trim()) return null;
  const value = tryParseRecord(raw);
  if (
    !value ||
    value.schemaVersion !== FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA ||
    !isGitRevision(value.sourceRevision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isRecord(value.providers)
  ) {
    return null;
  }
  for (const provider of [
    "openai",
    "calendarReading",
    "gmailReading",
    "gmailSending",
    "anthropic",
  ]) {
    const decision = value.providers[provider];
    if (
      !isRecord(decision) ||
      (decision.outcome !== "released" && decision.outcome !== "hidden") ||
      !isGitRevision(decision.sourceRevision) ||
      !isExactInstant(decision.qualifiedAt) ||
      !isExactInstant(decision.expiresAt) ||
      !isEvidenceDigest(decision.evidenceDigest)
    ) {
      return null;
    }
  }
  const providers = value.providers;
  return {
    schemaVersion: FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA,
    sourceRevision: value.sourceRevision as string,
    evidenceDigest: value.evidenceDigest as `sha256:${string}`,
    providers: {
      openai: sanitizeProviderDecision(providers.openai),
      anthropic: sanitizeProviderDecision(providers.anthropic),
      calendarReading: sanitizeProviderDecision(providers.calendarReading),
      gmailReading: sanitizeProviderDecision(providers.gmailReading),
      gmailSending: sanitizeProviderDecision(providers.gmailSending),
    },
  };
}

export function buildFounderInitialGeneralReleaseDecision(input: {
  productContract: FounderProductContractEvidence;
  moderatedSummary: FounderModeratedSummary | null;
  providerSummary: FounderProviderDecisionSummary | null;
}) {
  const reasons: string[] = [];
  const revision = input.productContract.releaseIdentity.sourceRevision;
  if (
    input.productContract.result !== "passed" ||
    input.productContract.mode !== "release" ||
    !input.productContract.releaseEligible
  ) {
    reasons.push("product_contract_not_release_eligible");
  }

  const study = input.moderatedSummary;
  if (!study) {
    reasons.push("moderated_founder_evidence_missing");
  } else {
    if (
      study.participants.total !== 8 ||
      study.participants.desktopFirst !== 4 ||
      study.participants.phoneFirst !== 4 ||
      study.participants.crossDeviceDayTwo !== 8
    ) {
      reasons.push("representative_cohort_incomplete");
    }
    if (study.participants.independentActivationLeadRecovery < 7) {
      reasons.push("activation_action_recovery_threshold_failed");
    }
    if (study.participants.firstBriefWithin15MinutesActiveFounderTime < 7) {
      reasons.push("first_brief_time_threshold_failed");
    }
    if (study.participants.fullComprehension !== 8) {
      reasons.push("founder_comprehension_threshold_failed");
    }
    if (Object.values(study.criticalFailures).some((count) => count !== 0)) {
      reasons.push("critical_failure_present");
    }
  }

  const providers = input.providerSummary;
  if (!providers) {
    reasons.push("provider_decision_evidence_missing");
  } else {
    if (providers.sourceRevision !== revision) reasons.push("provider_revision_mismatch");
    const decisionTime = new Date(input.productContract.observedAt);
    const providerNames = [
      "openai",
      "anthropic",
      "calendarReading",
      "gmailReading",
      "gmailSending",
    ] as const;
    for (const provider of providerNames) {
      const decision = providers.providers[provider];
      if (decision.outcome !== "released") {
        reasons.push(`${provider}_not_released`);
        continue;
      }
      if (decision.sourceRevision !== revision) {
        reasons.push(`${provider}_revision_mismatch`);
      }
      const qualifiedAt = new Date(decision.qualifiedAt);
      const expiresAt = new Date(decision.expiresAt);
      if (qualifiedAt > decisionTime) {
        reasons.push(`${provider}_evidence_time_invalid`);
      } else if (expiresAt <= decisionTime) {
        reasons.push(`${provider}_evidence_expired`);
      } else if (
        decisionTime.valueOf() - qualifiedAt.valueOf() > FOUNDER_PROVIDER_DECISION_MAX_AGE_MS ||
        expiresAt.valueOf() - qualifiedAt.valueOf() > FOUNDER_PROVIDER_DECISION_MAX_AGE_MS
      ) {
        reasons.push(`${provider}_evidence_stale`);
      }
    }
    if (
      new Set(providerNames.map((provider) => providers.providers[provider].evidenceDigest))
        .size !== providerNames.length
    ) {
      reasons.push("provider_evidence_not_independent");
    }
  }

  const payload = {
    schemaVersion: FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA,
    outcome: reasons.length === 0 ? ("approved" as const) : ("denied" as const),
    reasons,
    releaseIdentity: {
      sourceRevision: revision,
      productContractRunId: input.productContract.releaseIdentity.runId,
      decidedAt: input.productContract.observedAt,
    },
    evidence: {
      productContractDigest: input.productContract.summaryDigest,
      moderatedFounderDigest: study?.evidenceDigest ?? null,
      providerDecisionDigest: providers?.evidenceDigest ?? null,
    },
    metrics: study?.participants ?? null,
    criticalFailures: study?.criticalFailures ?? null,
    providers: providers?.providers ?? null,
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
    retention: {
      releaseEvidenceDays: 90,
      recordingDays: 30,
      deidentifiedMetricMonths: 24,
    },
    sanitization: {
      allowlisted: true,
      excluded: [
        "participant_identities",
        "recordings",
        "transcripts",
        "credentials",
        "prompts",
        "provider_responses",
      ],
    },
  } as const;

  return {
    ...payload,
    summaryDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  };
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  const value = tryParseRecord(raw);
  if (value) return value;
  throw new Error(`${label} is invalid.`);
}

function tryParseRecord(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    // A stable null deliberately excludes the supplied evidence.
    return null;
  }
}

function sanitizeProviderDecision(value: unknown): ProviderDecision {
  const decision = value as Record<string, unknown>;
  return {
    outcome: decision.outcome as ProviderDecision["outcome"],
    sourceRevision: decision.sourceRevision as string,
    qualifiedAt: decision.qualifiedAt as string,
    expiresAt: decision.expiresAt as string,
    evidenceDigest: decision.evidenceDigest as `sha256:${string}`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8;
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function isExactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
