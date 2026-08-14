import { describe, expect, it } from "vitest";
import {
  evaluateProductionRolloutSignals,
  getProductionRolloutStep,
  listProductionRolloutPreflightIssues,
  PRODUCTION_ROLLOUT_AUTHORIZATION,
  PRODUCTION_ROLLOUT_STEPS,
  productionRolloutEnvironmentForStep,
} from "@/src/server/agents/production-rollout";
import {
  readColdProvisioningPolicy,
  readRolloutConfigurationGeneration,
} from "@/src/server/agents/deployment-slo-identity";

describe("guarded production rollout", () => {
  it("binds the protected authorization to the passed provider gate and zero-spend exercises", () => {
    expect(PRODUCTION_ROLLOUT_AUTHORIZATION).toEqual({
      schemaVersion: "bruno.production-rollout.authorization.v1",
      id: "issue-300-20260815-g1",
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
    });
  });

  it("progressively selects the measured path and rolls back each axis independently", () => {
    expect(PRODUCTION_ROLLOUT_STEPS.map((step) => step.name)).toEqual([
      "baseline",
      "qstash",
      "qstash_rollback",
      "qstash_restored",
      "snapshot",
      "snapshot_rollback",
      "snapshot_restored",
      "release_attested",
      "validation_rollback",
      "validation_restored",
      "measured_size",
      "size_rollback",
      "optimized",
    ]);

    expectOnlyAxisChanged("qstash", "qstash_rollback", "dispatchMode");
    expectOnlyAxisChanged("snapshot", "snapshot_rollback", "imageMode");
    expectOnlyAxisChanged("release_attested", "validation_rollback", "validationMode");
    expect(getProductionRolloutStep("size_rollback").defaults).toEqual({
      dispatchMode: "qstash",
      recoveryMaxPublishAttempts: 12,
      imageMode: "stock",
      validationMode: "full",
      runnerSizeSlug: "s-2vcpu-2gb",
    });

    expect(getProductionRolloutStep("optimized")).toMatchObject({
      generation: 14,
      coldProvisioningHaltReason: null,
      defaults: {
        dispatchMode: "qstash",
        recoveryMaxPublishAttempts: 12,
        imageMode: "snapshot",
        validationMode: "release_attested",
        runnerSizeSlug: "s-1vcpu-2gb",
      },
    });
    expect(
      PRODUCTION_ROLLOUT_STEPS.slice(0, -1).every(
        (step) => step.coldProvisioningHaltReason === "rollout_exercise",
      ),
    ).toBe(true);
  });

  it("halts immediately for a safety violation without rewriting active deployments", () => {
    expect(
      evaluateProductionRolloutSignals({
        activeDeploymentGenerations: [3, 8, 11],
        currentStep: "optimized",
        signals: [{ kind: "safety_violation", reason: "duplicate_billable_effect" }],
      }),
    ).toEqual({
      action: "halt",
      haltReason: "duplicate_billable_effect",
      preserveActiveDeploymentGenerations: [3, 8, 11],
    });
  });

  it("rolls back only a repeatedly failing feature and records isolated latency misses", () => {
    expect(
      evaluateProductionRolloutSignals({
        activeDeploymentGenerations: [14],
        currentStep: "optimized",
        signals: [
          { kind: "functional_failure", feature: "dispatch" },
          { kind: "functional_failure", feature: "dispatch" },
        ],
      }),
    ).toEqual({
      action: "rollback",
      feature: "dispatch",
      preserveActiveDeploymentGenerations: [14],
      targetDefaults: expect.objectContaining({
        dispatchMode: "cron",
        imageMode: "snapshot",
        validationMode: "release_attested",
        runnerSizeSlug: "s-1vcpu-2gb",
      }),
    });

    expect(
      evaluateProductionRolloutSignals({
        activeDeploymentGenerations: [14],
        currentStep: "optimized",
        signals: [{ kind: "latency_miss", feature: "snapshot", stage: "provider_create" }],
      }),
    ).toEqual({
      action: "investigate",
      latencyMisses: [{ feature: "snapshot", stage: "provider_create" }],
      preserveActiveDeploymentGenerations: [14],
    });

    expect(
      evaluateProductionRolloutSignals({
        activeDeploymentGenerations: [14],
        currentStep: "optimized",
        signals: [
          { kind: "functional_failure", feature: "runner_size" },
          { kind: "functional_failure", feature: "runner_size" },
        ],
      }),
    ).toMatchObject({
      action: "rollback",
      feature: "runner_size",
      targetDefaults: {
        dispatchMode: "qstash",
        recoveryMaxPublishAttempts: 12,
        imageMode: "stock",
        validationMode: "full",
        runnerSizeSlug: "s-2vcpu-2gb",
      },
    });
  });

  it("reads only exact protected generations and fail-closed provisioning halt reasons", () => {
    expect(readRolloutConfigurationGeneration({})).toBe(1);
    expect(
      readRolloutConfigurationGeneration({ BRUNO_ROLLOUT_CONFIGURATION_GENERATION: "14" }),
    ).toBe(14);
    for (const generation of ["0", "1.5", " 14 ", "latest"]) {
      expect(() =>
        readRolloutConfigurationGeneration({
          BRUNO_ROLLOUT_CONFIGURATION_GENERATION: generation,
        }),
      ).toThrow("Rollout Configuration generation is invalid");
    }

    expect(readColdProvisioningPolicy({})).toEqual({ ok: true, enabled: true });
    expect(
      readColdProvisioningPolicy({
        BRUNO_COLD_PROVISIONING_HALT_REASON: "artifact_identity_violation",
      }),
    ).toEqual({ ok: true, enabled: false, reason: "artifact_identity_violation" });
    expect(
      readColdProvisioningPolicy({ BRUNO_COLD_PROVISIONING_HALT_REASON: "rollout_exercise" }),
    ).toEqual({ ok: true, enabled: false, reason: "rollout_exercise" });
    expect(
      readColdProvisioningPolicy({ BRUNO_COLD_PROVISIONING_HALT_REASON: " unknown " }),
    ).toEqual({ ok: false, enabled: false, reason: "invalid_configuration" });
    expect(readColdProvisioningPolicy({ BRUNO_COLD_PROVISIONING_HALT_REASON: "" })).toEqual({
      ok: false,
      enabled: false,
      reason: "invalid_configuration",
    });
  });

  it("emits only choice-bearing environment values and names missing protected credentials", () => {
    expect(productionRolloutEnvironmentForStep("baseline")).toEqual({
      BRUNO_COLD_PROVISIONING_HALT_REASON: "rollout_exercise",
      BRUNO_DEPLOYMENT_DISPATCH_MODE: "cron",
      BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "12",
      BRUNO_DIGITALOCEAN_IMAGE_MODE: "stock",
      BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-2vcpu-2gb",
      BRUNO_ROLLOUT_CONFIGURATION_GENERATION: "2",
      BRUNO_RUNNER_BOOT_VALIDATION_MODE: "full",
    });
    expect(productionRolloutEnvironmentForStep("optimized")).toEqual({
      BRUNO_DEPLOYMENT_DISPATCH_MODE: "qstash",
      BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "12",
      BRUNO_DIGITALOCEAN_IMAGE_MODE: "snapshot",
      BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      BRUNO_ROLLOUT_CONFIGURATION_GENERATION: "14",
      BRUNO_RUNNER_BOOT_VALIDATION_MODE: "release_attested",
    });

    expect(listProductionRolloutPreflightIssues("optimized", {})).toEqual([
      "authorization",
      "protected_environment",
      "provider_credentials",
      "qstash_credentials",
      "snapshot_evidence",
      "release_evidence",
      "configuration",
    ]);
  });
});

function expectOnlyAxisChanged(
  selectedStep: Parameters<typeof getProductionRolloutStep>[0],
  rollbackStep: Parameters<typeof getProductionRolloutStep>[0],
  axis: keyof ReturnType<typeof getProductionRolloutStep>["defaults"],
): void {
  const selected = getProductionRolloutStep(selectedStep).defaults;
  const rollback = getProductionRolloutStep(rollbackStep).defaults;
  const changed = Object.keys(selected).filter(
    (key) => selected[key as keyof typeof selected] !== rollback[key as keyof typeof rollback],
  );
  expect(changed).toEqual([axis]);
}
