import { readFileSync } from "node:fs";
import { captureAgentDeploymentChoicesFromEnvironment } from "@/src/server/agents/agent-deployment-choices";
import {
  evaluateProductionRolloutSignals,
  getProductionRolloutStep,
  listProductionRolloutPreflightIssues,
  PRODUCTION_ROLLOUT_AUTHORIZATION,
  PRODUCTION_ROLLOUT_STEPS,
  productionRolloutEnvironmentForStep,
  type ProductionRolloutPreflightIssue,
  type ProductionRolloutFeature,
  type ProductionRolloutSignal,
  type ProductionRolloutStepName,
} from "@/src/server/agents/production-rollout";

type Command = "evaluate" | "plan" | "preflight";

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function isStepName(value: string | undefined): value is ProductionRolloutStepName {
  return PRODUCTION_ROLLOUT_STEPS.some((step) => step.name === value);
}

function plan(): number {
  write({
    schemaVersion: "bruno.production-rollout.plan.v1",
    authorizationId: PRODUCTION_ROLLOUT_AUTHORIZATION.id,
    effects: 0,
    maximumExerciseSpendCents: PRODUCTION_ROLLOUT_AUTHORIZATION.maximumExerciseSpendCents,
    steps: PRODUCTION_ROLLOUT_STEPS.map((step) => ({
      name: step.name,
      generation: step.generation,
      defaults: step.defaults,
      coldProvisioningHaltReason: step.coldProvisioningHaltReason,
      environment: productionRolloutEnvironmentForStep(step.name),
    })),
  });
  return 0;
}

function preflight(stepName: ProductionRolloutStepName): number {
  const issues = listProductionRolloutPreflightIssues(stepName, process.env);
  if (issues.length === 0 && !configurationMatchesStep(stepName)) {
    issues.push("configuration");
  }
  write({
    schemaVersion: "bruno.production-rollout.preflight.v1",
    command: "preflight",
    step: stepName,
    effects: 0,
    ok: issues.length === 0,
    issues,
  });
  return issues.length === 0 ? 0 : 1;
}

function evaluate(stepName: ProductionRolloutStepName, inputPath: string): number {
  try {
    const input = JSON.parse(readFileSync(inputPath, "utf8")) as unknown;
    if (!isSignalInput(input)) throw new Error("invalid signal input");
    const decision = evaluateProductionRolloutSignals({
      activeDeploymentGenerations: input.activeDeploymentGenerations,
      currentStep: stepName,
      signals: input.signals,
    });
    write({
      schemaVersion: "bruno.production-rollout.signal-decision.v1",
      command: "evaluate",
      step: stepName,
      effects: 0,
      decision,
    });
    return 0;
  } catch {
    write({
      schemaVersion: "bruno.production-rollout.signal-decision.v1",
      command: "evaluate",
      step: stepName,
      effects: 0,
      decision: { action: "halt", haltReason: "artifact_identity_violation" },
    });
    return 1;
  }
}

function isSignalInput(input: unknown): input is {
  activeDeploymentGenerations: number[];
  signals: ProductionRolloutSignal[];
} {
  if (!isObject(input)) return false;
  if (
    !Array.isArray(input.activeDeploymentGenerations) ||
    !input.activeDeploymentGenerations.every(
      (generation) => Number.isSafeInteger(generation) && generation >= 1,
    ) ||
    !Array.isArray(input.signals)
  ) {
    return false;
  }
  return input.signals.every(isSignal);
}

function isSignal(signal: unknown): signal is ProductionRolloutSignal {
  if (!isObject(signal) || typeof signal.kind !== "string") return false;
  if (signal.kind === "functional_failure") return isFeature(signal.feature);
  if (signal.kind === "latency_miss") {
    return isFeature(signal.feature) && typeof signal.stage === "string" && signal.stage.length > 0;
  }
  return (
    signal.kind === "safety_violation" &&
    [
      "ownership_violation",
      "authentication_violation",
      "artifact_identity_violation",
      "duplicate_billable_effect",
      "cleanup_violation",
    ].includes(String(signal.reason))
  );
}

function isFeature(value: unknown): value is ProductionRolloutFeature {
  return ["dispatch", "snapshot", "validation", "runner_size"].includes(String(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationMatchesStep(stepName: ProductionRolloutStepName): boolean {
  try {
    const expected = getProductionRolloutStep(stepName);
    const choices = captureAgentDeploymentChoicesFromEnvironment(process.env, expected.generation);
    return (
      choices.dispatchMode === expected.defaults.dispatchMode &&
      choices.provider.mode === "digitalocean" &&
      choices.provider.region === PRODUCTION_ROLLOUT_AUTHORIZATION.region &&
      choices.provider.sizeSlug === expected.defaults.runnerSizeSlug &&
      choices.provider.snapshotMode.mode === expected.defaults.imageMode &&
      choices.validation.mode === expected.defaults.validationMode
    );
  } catch {
    return false;
  }
}

function main(): number {
  const command = process.argv[2] as Command | undefined;
  if (command === "plan") return plan();
  if (command === "preflight" && isStepName(process.argv[3])) return preflight(process.argv[3]);
  if (command === "evaluate" && isStepName(process.argv[3]) && process.argv[4]) {
    return evaluate(process.argv[3], process.argv[4]);
  }
  const issues: ProductionRolloutPreflightIssue[] = ["configuration"];
  write({
    schemaVersion: "bruno.production-rollout.preflight.v1",
    command: command ?? null,
    step: process.argv[3] ?? null,
    effects: 0,
    ok: false,
    issues,
  });
  return 1;
}

process.exitCode = main();
