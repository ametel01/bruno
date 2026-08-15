export const PRODUCTION_ROLLOUT_AUTHORIZATION = {
  schemaVersion: "bruno.production-rollout.authorization.v1",
  id: "issue-300-20260815-g2",
  protectedEnvironment: "production",
  providerTrialReportDigest:
    "sha256:7dda5fbbb118ae6cc8023a026223477d35376ce5f6c2565a47a6496a78514c44",
  region: "sfo3",
  measuredRunnerSizeSlug: "s-1vcpu-2gb",
  rollbackRunnerSizeSlug: "s-2vcpu-2gb",
  rollbackExercises: ["dispatch", "snapshot", "validation", "runner_size"],
  credentialScopes: [
    "vercel_production_configuration",
    "qstash_publication_and_verification",
    "digitalocean_snapshot_availability",
    "runner_control",
  ],
  maximumExerciseSpendCents: 0,
  cleanup: {
    temporaryProviderResources: "authoritatively_absent",
    exerciseDeployments: "superseded",
    approvedSnapshot: "intentionally_retained",
  },
  evidenceRetentionDays: 90,
} as const;

export type ProductionRolloutDefaults = {
  dispatchMode: "cron" | "qstash";
  recoveryMaxPublishAttempts: 12;
  imageMode: "stock" | "snapshot";
  validationMode: "full" | "release_attested";
  runnerSizeSlug: "s-1vcpu-2gb" | "s-2vcpu-2gb";
};

export type ProductionRolloutStepName =
  | "baseline"
  | "qstash"
  | "qstash_rollback"
  | "qstash_restored"
  | "snapshot"
  | "snapshot_rollback"
  | "snapshot_restored"
  | "release_attested"
  | "validation_rollback"
  | "measured_size"
  | "size_rollback"
  | "size_restored"
  | "optimized";

export type ProductionRolloutStep = {
  name: ProductionRolloutStepName;
  generation: number;
  defaults: ProductionRolloutDefaults;
  coldProvisioningHaltReason: "rollout_exercise" | null;
};

const BASELINE_DEFAULTS = {
  dispatchMode: "cron",
  recoveryMaxPublishAttempts: 12,
  imageMode: "stock",
  validationMode: "full",
  runnerSizeSlug: PRODUCTION_ROLLOUT_AUTHORIZATION.rollbackRunnerSizeSlug,
} as const satisfies ProductionRolloutDefaults;

// Authorization g1 deployed generations 2 through 14 while exercising the original order.
// The corrected g2 plan starts at 15 so stored deployment choices are never reinterpreted.
export const PRODUCTION_ROLLOUT_STEPS: readonly ProductionRolloutStep[] = [
  step("baseline", 15, BASELINE_DEFAULTS),
  step("qstash", 16, { ...BASELINE_DEFAULTS, dispatchMode: "qstash" }),
  step("qstash_rollback", 17, BASELINE_DEFAULTS),
  step("qstash_restored", 18, { ...BASELINE_DEFAULTS, dispatchMode: "qstash" }),
  step("measured_size", 19, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("size_rollback", 20, { ...BASELINE_DEFAULTS, dispatchMode: "qstash" }),
  step("size_restored", 21, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("snapshot", 22, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    imageMode: "snapshot",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("snapshot_rollback", 23, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("snapshot_restored", 24, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    imageMode: "snapshot",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("release_attested", 25, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    imageMode: "snapshot",
    validationMode: "release_attested",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step("validation_rollback", 26, {
    ...BASELINE_DEFAULTS,
    dispatchMode: "qstash",
    imageMode: "snapshot",
    runnerSizeSlug: "s-1vcpu-2gb",
  }),
  step(
    "optimized",
    27,
    {
      dispatchMode: "qstash",
      recoveryMaxPublishAttempts: 12,
      imageMode: "snapshot",
      validationMode: "release_attested",
      runnerSizeSlug: "s-1vcpu-2gb",
    },
    null,
  ),
];

export type ProductionRolloutSafetyReason =
  | "ownership_violation"
  | "authentication_violation"
  | "artifact_identity_violation"
  | "duplicate_billable_effect"
  | "cleanup_violation";

export type ProductionRolloutFeature = "dispatch" | "snapshot" | "validation" | "runner_size";

export type ProductionRolloutSignal =
  | { kind: "safety_violation"; reason: ProductionRolloutSafetyReason }
  | { kind: "functional_failure"; feature: ProductionRolloutFeature }
  | {
      kind: "latency_miss";
      feature: ProductionRolloutFeature;
      stage: string;
    };

export type ProductionRolloutPreflightIssue =
  | "authorization"
  | "protected_environment"
  | "provider_credentials"
  | "qstash_credentials"
  | "snapshot_evidence"
  | "release_evidence"
  | "configuration";

export function getProductionRolloutStep(name: ProductionRolloutStepName): ProductionRolloutStep {
  const found = PRODUCTION_ROLLOUT_STEPS.find((candidate) => candidate.name === name);
  if (!found) throw new Error("Production rollout step is invalid.");
  return structuredClone(found);
}

export function productionRolloutEnvironmentForStep(
  name: ProductionRolloutStepName,
): Record<string, string> {
  const rolloutStep = getProductionRolloutStep(name);
  return {
    ...(rolloutStep.coldProvisioningHaltReason
      ? { BRUNO_COLD_PROVISIONING_HALT_REASON: rolloutStep.coldProvisioningHaltReason }
      : {}),
    BRUNO_DEPLOYMENT_DISPATCH_MODE: rolloutStep.defaults.dispatchMode,
    BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: String(
      rolloutStep.defaults.recoveryMaxPublishAttempts,
    ),
    BRUNO_DIGITALOCEAN_IMAGE_MODE: rolloutStep.defaults.imageMode,
    BRUNO_DIGITALOCEAN_SIZE_SLUG: rolloutStep.defaults.runnerSizeSlug,
    BRUNO_ROLLOUT_CONFIGURATION_GENERATION: String(rolloutStep.generation),
    BRUNO_RUNNER_BOOT_VALIDATION_MODE: rolloutStep.defaults.validationMode,
  };
}

export function listProductionRolloutPreflightIssues(
  name: ProductionRolloutStepName,
  env: Readonly<Record<string, string | undefined>>,
): ProductionRolloutPreflightIssue[] {
  const rolloutStep = getProductionRolloutStep(name);
  const issues: ProductionRolloutPreflightIssue[] = [];
  if (
    env.BRUNO_PRODUCTION_ROLLOUT_AUTHORIZATION_ID !== PRODUCTION_ROLLOUT_AUTHORIZATION.id ||
    env.BRUNO_PRODUCTION_ROLLOUT_MAX_EXERCISE_SPEND_CENTS !==
      String(PRODUCTION_ROLLOUT_AUTHORIZATION.maximumExerciseSpendCents) ||
    env.BRUNO_PRODUCTION_ROLLOUT_LIVE_CONFIRMATION !==
      "authorize-issue-300-protected-production-rollout"
  ) {
    issues.push("authorization");
  }
  if (
    env.BRUNO_PRODUCTION_ROLLOUT_PROTECTED_ENVIRONMENT !==
    PRODUCTION_ROLLOUT_AUTHORIZATION.protectedEnvironment
  ) {
    issues.push("protected_environment");
  }
  if (
    !hasValues(env, ["BRUNO_DIGITALOCEAN_TOKEN", "BRUNO_RUNNER_BEARER_TOKEN", "BRUNO_RUNNER_IMAGE"])
  ) {
    issues.push("provider_credentials");
  }
  if (
    rolloutStep.defaults.dispatchMode === "qstash" &&
    !hasValues(env, ["QSTASH_TOKEN", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY"])
  ) {
    issues.push("qstash_credentials");
  }
  if (
    rolloutStep.defaults.imageMode === "snapshot" &&
    !hasValues(env, [
      "BRUNO_DIGITALOCEAN_SNAPSHOT_BUNDLE",
      "BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST",
      "BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET",
      "BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID",
      "BRUNO_HERMES_WORKLOAD_AMD64_MANIFEST_DIGEST",
    ])
  ) {
    issues.push("snapshot_evidence");
  }
  if (
    rolloutStep.defaults.validationMode === "release_attested" &&
    !hasValues(env, [
      "BRUNO_RUNNER_RELEASE_BUNDLE",
      "BRUNO_RUNNER_APPROVED_RELEASE_DIGEST",
      "BRUNO_RUNNER_RELEASE_TRUST_SET",
      "BRUNO_RUNNER_APPROVED_SNAPSHOT_OCI",
    ])
  ) {
    issues.push("release_evidence");
  }
  const expected = productionRolloutEnvironmentForStep(name);
  if (Object.entries(expected).some(([key, value]) => env[key] !== value)) {
    issues.push("configuration");
  }
  return issues;
}

export function evaluateProductionRolloutSignals(input: {
  activeDeploymentGenerations: number[];
  currentStep: ProductionRolloutStepName;
  signals: ProductionRolloutSignal[];
}):
  | {
      action: "halt";
      haltReason: ProductionRolloutSafetyReason;
      preserveActiveDeploymentGenerations: number[];
    }
  | {
      action: "rollback";
      feature: ProductionRolloutFeature;
      targetDefaults: ProductionRolloutDefaults;
      preserveActiveDeploymentGenerations: number[];
    }
  | {
      action: "investigate";
      latencyMisses: Array<{
        feature: ProductionRolloutFeature;
        stage: string;
      }>;
      preserveActiveDeploymentGenerations: number[];
    }
  | { action: "continue"; preserveActiveDeploymentGenerations: number[] } {
  const preserveActiveDeploymentGenerations = [...input.activeDeploymentGenerations];
  const safetyViolation = input.signals.find(
    (signal): signal is Extract<ProductionRolloutSignal, { kind: "safety_violation" }> =>
      signal.kind === "safety_violation",
  );
  if (safetyViolation) {
    return {
      action: "halt",
      haltReason: safetyViolation.reason,
      preserveActiveDeploymentGenerations,
    };
  }

  const functionalFailureCounts = new Map<ProductionRolloutFeature, number>();
  for (const signal of input.signals) {
    if (signal.kind !== "functional_failure") continue;
    const count = (functionalFailureCounts.get(signal.feature) ?? 0) + 1;
    functionalFailureCounts.set(signal.feature, count);
    if (count >= 2) {
      return {
        action: "rollback",
        feature: signal.feature,
        targetDefaults: rollbackDefaults(
          signal.feature,
          getProductionRolloutStep(input.currentStep),
        ),
        preserveActiveDeploymentGenerations,
      };
    }
  }

  const latencyMisses = input.signals.flatMap((signal) =>
    signal.kind === "latency_miss" ? [{ feature: signal.feature, stage: signal.stage }] : [],
  );
  if (latencyMisses.length > 0) {
    return { action: "investigate", latencyMisses, preserveActiveDeploymentGenerations };
  }
  return { action: "continue", preserveActiveDeploymentGenerations };
}

function step(
  name: ProductionRolloutStepName,
  generation: number,
  defaults: ProductionRolloutDefaults,
  coldProvisioningHaltReason: "rollout_exercise" | null = "rollout_exercise",
): ProductionRolloutStep {
  return { name, generation, defaults, coldProvisioningHaltReason };
}

function rollbackDefaults(
  feature: ProductionRolloutFeature,
  current: ProductionRolloutStep,
): ProductionRolloutDefaults {
  if (feature === "dispatch") return { ...current.defaults, dispatchMode: "cron" };
  if (feature === "validation") return { ...current.defaults, validationMode: "full" };
  if (feature === "runner_size") {
    return {
      ...current.defaults,
      imageMode: "stock",
      validationMode: "full",
      runnerSizeSlug: PRODUCTION_ROLLOUT_AUTHORIZATION.rollbackRunnerSizeSlug,
    };
  }
  return { ...current.defaults, imageMode: "stock", validationMode: "full" };
}

function hasValues(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): boolean {
  return names.every((name) => typeof env[name] === "string" && env[name]?.length !== 0);
}
