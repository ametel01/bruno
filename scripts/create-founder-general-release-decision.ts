import { createHash } from "node:crypto";
import type { FounderProductContractEvidence } from "@/scripts/create-founder-product-contract-evidence";
import {
  evaluateFounderProductionProviderQualification,
  type FounderProductionProviderLiveTargetAuthority,
  type FounderProductionProviderQualificationSummary,
} from "@/scripts/create-founder-production-provider-qualification";
import {
  isEvidenceDigest,
  isEvidenceRecord,
  isExactInstant,
  isGitRevision,
  tryParseEvidenceRecord,
} from "@/scripts/founder-release-evidence-validation";

export const FOUNDER_MODERATED_SUMMARY_SCHEMA = "bruno.moderated-founder-summary.v1";
export const FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA =
  "bruno.founder-provider-decision-summary.v1";
export const FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_SCHEMA =
  "bruno.founder-general-release-operational-summary.v1";
export const FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA =
  "bruno.founder-initial-general-release-decision.v1";
export const FOUNDER_PROVIDER_DECISION_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;
export const FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST = [
  "openai",
  "anthropic",
  "calendar_reading",
  "gmail_reading",
  "gmail_sending",
] as const;

export type FounderModeratedSummary = {
  schemaVersion: typeof FOUNDER_MODERATED_SUMMARY_SCHEMA;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: `sha256:${string}`;
  observedAt: string;
  participantBoundary: {
    freshIndependentNontechnicalFounders: 8;
    ownerParticipants: 0;
    trustedPreviewParticipants: 0;
    coachedParticipants: 0;
    externalBetaParticipants: 0;
    buildTeamParticipants: 0;
    selfOrFriendTestParticipants: 0;
    facilitatorRescues: 0;
    supportInterventions: 0;
  };
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

const OPERATIONAL_EVIDENCE_KINDS = [
  "operational",
  "privacy",
  "billing",
  "recovery",
  "retirement",
] as const;

type OperationalEvidenceKind = (typeof OPERATIONAL_EVIDENCE_KINDS)[number];

type OperationalEvidenceRecord = {
  result: "passed" | "failed";
  evidenceDigest: `sha256:${string}`;
};

export type FounderGeneralReleaseOperationalSummary = {
  schemaVersion: typeof FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_SCHEMA;
  applicationRevision: string;
  runtimeRevision: string;
  evidenceDigest: `sha256:${string}`;
  observedAt: string;
  expiresAt: string;
  sanitized: true;
  candidate: {
    externalBetaFindingsResolved: true;
    unresolvedCriticalFindings: 0;
    findingsResolvedAt: string;
    frozenAt: string;
  };
  evidence: Record<OperationalEvidenceKind, OperationalEvidenceRecord>;
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
    !isGitRevision(value.applicationRevision) ||
    typeof value.runtimeRevision !== "string" ||
    !value.runtimeRevision.trim() ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isExactInstant(value.observedAt) ||
    !isEvidenceRecord(value.participantBoundary) ||
    !isEvidenceRecord(value.participants) ||
    !isEvidenceRecord(value.criticalFailures) ||
    !isEvidenceRecord(value.retention)
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
  const participantBoundary = value.participantBoundary;
  const criticalFailures = value.criticalFailures;
  const retention = value.retention;
  if (
    !participantKeys.every((key) => isCount(participants[key])) ||
    participantBoundary.freshIndependentNontechnicalFounders !== 8 ||
    ![
      "ownerParticipants",
      "trustedPreviewParticipants",
      "coachedParticipants",
      "externalBetaParticipants",
      "buildTeamParticipants",
      "selfOrFriendTestParticipants",
      "facilitatorRescues",
      "supportInterventions",
    ].every((key) => participantBoundary[key] === 0) ||
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
    applicationRevision: value.applicationRevision as string,
    runtimeRevision: value.runtimeRevision as string,
    evidenceDigest: value.evidenceDigest as `sha256:${string}`,
    observedAt: value.observedAt as string,
    participantBoundary: {
      freshIndependentNontechnicalFounders: 8,
      ownerParticipants: 0,
      trustedPreviewParticipants: 0,
      coachedParticipants: 0,
      externalBetaParticipants: 0,
      buildTeamParticipants: 0,
      selfOrFriendTestParticipants: 0,
      facilitatorRescues: 0,
      supportInterventions: 0,
    },
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

export function parseFounderGeneralReleaseOperationalSummary(
  raw: string | undefined,
): FounderGeneralReleaseOperationalSummary | null {
  if (!raw?.trim()) return null;
  const value = tryParseEvidenceRecord(raw);
  if (
    !value ||
    value.schemaVersion !== FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_SCHEMA ||
    !isGitRevision(value.applicationRevision) ||
    typeof value.runtimeRevision !== "string" ||
    !value.runtimeRevision.trim() ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isExactInstant(value.observedAt) ||
    !isExactInstant(value.expiresAt) ||
    value.sanitized !== true ||
    !isEvidenceRecord(value.candidate) ||
    !isEvidenceRecord(value.evidence)
  ) {
    return null;
  }
  const candidate = value.candidate;
  if (
    candidate.externalBetaFindingsResolved !== true ||
    candidate.unresolvedCriticalFindings !== 0 ||
    !isExactInstant(candidate.findingsResolvedAt) ||
    !isExactInstant(candidate.frozenAt) ||
    new Date(candidate.findingsResolvedAt as string) > new Date(candidate.frozenAt as string) ||
    new Date(candidate.frozenAt as string) > new Date(value.observedAt as string)
  ) {
    return null;
  }
  const evidence = value.evidence;
  for (const kind of OPERATIONAL_EVIDENCE_KINDS) {
    const record = evidence[kind];
    if (
      !isEvidenceRecord(record) ||
      (record.result !== "passed" && record.result !== "failed") ||
      !isEvidenceDigest(record.evidenceDigest)
    ) {
      return null;
    }
  }
  return {
    schemaVersion: FOUNDER_GENERAL_RELEASE_OPERATIONAL_SUMMARY_SCHEMA,
    applicationRevision: value.applicationRevision as string,
    runtimeRevision: value.runtimeRevision as string,
    evidenceDigest: value.evidenceDigest as `sha256:${string}`,
    observedAt: value.observedAt as string,
    expiresAt: value.expiresAt as string,
    sanitized: true,
    candidate: {
      externalBetaFindingsResolved: true,
      unresolvedCriticalFindings: 0,
      findingsResolvedAt: candidate.findingsResolvedAt as string,
      frozenAt: candidate.frozenAt as string,
    },
    evidence: Object.fromEntries(
      OPERATIONAL_EVIDENCE_KINDS.map((kind) => {
        const record = evidence[kind] as Record<string, unknown>;
        return [
          kind,
          {
            result: record.result as "passed" | "failed",
            evidenceDigest: record.evidenceDigest as `sha256:${string}`,
          },
        ];
      }),
    ) as FounderGeneralReleaseOperationalSummary["evidence"],
  };
}

export function parseFounderProviderDecisionSummary(
  raw: string | undefined,
): FounderProviderDecisionSummary | null {
  if (!raw?.trim()) return null;
  const value = tryParseEvidenceRecord(raw);
  if (
    !value ||
    value.schemaVersion !== FOUNDER_PROVIDER_DECISION_SUMMARY_SCHEMA ||
    !isGitRevision(value.sourceRevision) ||
    !isEvidenceDigest(value.evidenceDigest) ||
    !isEvidenceRecord(value.providers)
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
      !isEvidenceRecord(decision) ||
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
  productionProviderQualificationSummary: FounderProductionProviderQualificationSummary | null;
  productionProviderLiveTargetAuthority: FounderProductionProviderLiveTargetAuthority | null;
  operationalSummary: FounderGeneralReleaseOperationalSummary | null;
  decisionTime: Date;
}) {
  const reasons: string[] = [];
  const revision = input.productContract.releaseIdentity.sourceRevision;
  const runtimeRevision = input.productContract.releaseIdentity.runtimeRevision;
  if (Number.isNaN(input.decisionTime.valueOf())) {
    throw new Error("Initial General Release decision time is invalid.");
  }
  const decisionTime = input.decisionTime;
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
    if (study.applicationRevision !== revision || study.runtimeRevision !== runtimeRevision) {
      reasons.push("founder_usability_candidate_mismatch");
    }
    const studyObservedAt = new Date(study.observedAt);
    if (
      studyObservedAt > decisionTime ||
      decisionTime.valueOf() - studyObservedAt.valueOf() > FOUNDER_PROVIDER_DECISION_MAX_AGE_MS
    ) {
      reasons.push("founder_usability_evidence_stale");
    }
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

  const operational = input.operationalSummary;
  if (!operational) {
    reasons.push("operational_release_evidence_missing");
  } else {
    if (
      operational.applicationRevision !== revision ||
      operational.runtimeRevision !== runtimeRevision
    ) {
      reasons.push("operational_release_candidate_mismatch");
    }
    const operationalObservedAt = new Date(operational.observedAt);
    const operationalExpiresAt = new Date(operational.expiresAt);
    if (
      operationalObservedAt > decisionTime ||
      operationalExpiresAt <= decisionTime ||
      decisionTime.valueOf() - operationalObservedAt.valueOf() >
        FOUNDER_PROVIDER_DECISION_MAX_AGE_MS ||
      operationalExpiresAt.valueOf() - operationalObservedAt.valueOf() >
        FOUNDER_PROVIDER_DECISION_MAX_AGE_MS
    ) {
      reasons.push("operational_release_evidence_stale");
    }
    for (const kind of OPERATIONAL_EVIDENCE_KINDS) {
      if (operational.evidence[kind].result !== "passed") {
        reasons.push(`${kind}_evidence_failed`);
      }
    }
  }

  const providers = input.providerSummary;
  if (!providers) {
    reasons.push("provider_decision_evidence_missing");
  } else {
    if (providers.sourceRevision !== revision) reasons.push("provider_revision_mismatch");
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

  const productionProviderQualifications = input.productionProviderQualificationSummary;
  reasons.push(
    ...evaluateFounderProductionProviderQualification({
      summary: productionProviderQualifications,
      applicationRevision: revision,
      runtimeRevision,
      decisionTime,
      liveTargetAuthority: input.productionProviderLiveTargetAuthority,
    }),
  );

  if (providers && productionProviderQualifications) {
    const externalProviderDigests = [
      providers.evidenceDigest,
      ...Object.values(providers.providers).map(({ evidenceDigest }) => evidenceDigest),
      productionProviderQualifications.evidenceDigest,
      ...productionProviderQualifications.qualifications.map(
        ({ evidenceDigest }) => evidenceDigest,
      ),
    ];
    if (new Set(externalProviderDigests).size !== externalProviderDigests.length) {
      reasons.push("external_provider_evidence_digest_reused");
    }
  }

  const accessibilityDigests = attendedAccessibilityDigests(input.productContract);
  const completeEvidenceDigests = [
    input.productContract.summaryDigest,
    ...(accessibilityDigests ? Object.values(accessibilityDigests) : []),
    ...(study ? [study.evidenceDigest] : []),
    ...(providers
      ? [
          providers.evidenceDigest,
          ...Object.values(providers.providers).map(({ evidenceDigest }) => evidenceDigest),
        ]
      : []),
    ...(productionProviderQualifications
      ? [
          productionProviderQualifications.evidenceDigest,
          ...productionProviderQualifications.qualifications.map(
            ({ evidenceDigest }) => evidenceDigest,
          ),
        ]
      : []),
    ...(operational
      ? [
          operational.evidenceDigest,
          ...OPERATIONAL_EVIDENCE_KINDS.map((kind) => operational.evidence[kind].evidenceDigest),
        ]
      : []),
  ];
  if (new Set(completeEvidenceDigests).size !== completeEvidenceDigests.length) {
    reasons.push("release_evidence_digest_reused");
  }

  const payload = {
    schemaVersion: FOUNDER_GENERAL_RELEASE_DECISION_SCHEMA,
    stage: "initial_general_release",
    outcome: reasons.length === 0 ? ("approved" as const) : ("denied" as const),
    reasons,
    capabilityManifest: [...FOUNDER_GENERAL_RELEASE_CAPABILITY_MANIFEST],
    releaseIdentity: {
      sourceRevision: revision,
      runtimeRevision,
      productContractRunId: input.productContract.releaseIdentity.runId,
      decidedAt: decisionTime.toISOString(),
    },
    evidence: {
      productContractDigest: input.productContract.summaryDigest,
      voiceOverDigest: accessibilityDigests?.voiceOverDigest ?? null,
      talkBackDigest: accessibilityDigests?.talkBackDigest ?? null,
      moderatedFounderDigest: study?.evidenceDigest ?? null,
      providerDecisionDigest: providers?.evidenceDigest ?? null,
      productionProviderQualificationDigest:
        productionProviderQualifications?.evidenceDigest ?? null,
      operationalDigest: operational?.evidence.operational.evidenceDigest ?? null,
      privacyDigest: operational?.evidence.privacy.evidenceDigest ?? null,
      billingDigest: operational?.evidence.billing.evidenceDigest ?? null,
      recoveryDigest: operational?.evidence.recovery.evidenceDigest ?? null,
      retirementDigest: operational?.evidence.retirement.evidenceDigest ?? null,
    },
    authorityExpiresAt: operational?.expiresAt ?? null,
    candidate: operational?.candidate ?? null,
    metrics: study?.participants ?? null,
    criticalFailures: study?.criticalFailures ?? null,
    providers: providers?.providers ?? null,
    productionProviderQualifications: productionProviderQualifications?.qualifications ?? null,
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
        "payment_details",
        "webhook_secrets",
        "provider_payloads",
        "provider_identities",
        "store_ids",
        "product_ids",
      ],
    },
  } as const;

  return {
    ...payload,
    summaryDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  };
}

function attendedAccessibilityDigests(productContract: FounderProductContractEvidence): {
  voiceOverDigest: `sha256:${string}`;
  talkBackDigest: `sha256:${string}`;
} | null {
  const digestFor = (id: "voiceover_safari" | "talkback_chrome") => {
    const invariant = productContract.invariants.find((candidate) => candidate.id === id);
    const evidence = invariant?.evidence[0];
    return evidence && typeof evidence === "object" && "digest" in evidence
      ? (evidence.digest as `sha256:${string}`)
      : null;
  };
  const voiceOverDigest = digestFor("voiceover_safari");
  const talkBackDigest = digestFor("talkback_chrome");
  return voiceOverDigest && talkBackDigest ? { voiceOverDigest, talkBackDigest } : null;
}

function parseRecord(raw: string, label: string): Record<string, unknown> {
  const value = tryParseEvidenceRecord(raw);
  if (value) return value;
  throw new Error(`${label} is invalid.`);
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

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8;
}
