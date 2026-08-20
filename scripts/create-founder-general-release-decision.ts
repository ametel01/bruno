import { createHash } from "node:crypto";
import type { FounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";

export const FOUNDER_MODERATED_SUMMARY_SCHEMA = "bruno.moderated-founder-summary.v1";
export const FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA =
  "bruno.founder-provider-decision-summary.v1";
export const FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA =
  "bruno.founder-initial-general-release-decision.v1";

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
  return value as FounderModeratedSummary;
}

export function parseFounderProviderDecisionSummary(
  raw: string | undefined,
): FounderProviderDecisionSummary | null {
  if (!raw?.trim()) return null;
  const value = parseRecord(raw, "Founder provider decision summary");
  if (
    value.schemaVersion !== FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA ||
    !isGitRevision(value.sourceRevision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isRecord(value.providers)
  ) {
    throw new Error("Founder provider decision summary is invalid.");
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
      !isEvidenceDigest(decision.evidenceDigest)
    ) {
      throw new Error("Founder provider decision summary is invalid.");
    }
  }
  return value as FounderProviderDecisionSummary;
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
    for (const provider of ["openai", "calendarReading", "gmailReading", "gmailSending"] as const) {
      if (providers.providers[provider].outcome !== "released") {
        reasons.push(`${provider}_not_released`);
      }
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
    providers: providers
      ? {
          ...providers.providers,
          anthropic: {
            ...providers.providers.anthropic,
            included: providers.providers.anthropic.outcome === "released",
          },
        }
      : null,
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
  try {
    const value = JSON.parse(raw) as unknown;
    if (isRecord(value)) return value;
  } catch {
    // The stable error below deliberately excludes the supplied evidence.
  }
  throw new Error(`${label} is invalid.`);
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
