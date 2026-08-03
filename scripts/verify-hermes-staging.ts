import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";
import {
  createHermesStagingAttestationToken,
  digestHermesStagingAttestationChallengeText,
} from "@/src/shared/hermes-staging-attestation-protocol";

export const HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL =
  "authorize-basic-4usd-digitalocean-staging";
export const HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL =
  "send-telegram-and-spend-digitalocean-staging";

export type HermesStagingCapabilityState = "configured" | "missing" | "malformed";

export type HermesStagingCapabilityName =
  | "published_image"
  | "configured_workload_image"
  | "image_source_revision"
  | "publish_workflow_run_id"
  | "acceptance_enabled"
  | "acceptance_base_url"
  | "acceptance_bearer_secret"
  | "digitalocean_budget_authorization"
  | "digitalocean_token"
  | "runner_bearer_token"
  | "openrouter_api_key"
  | "telegram_bot_token"
  | "telegram_test_user_id"
  | "telegram_test_chat_id"
  | "live_side_effect_confirmation";

export type HermesStagingCapability = {
  name: HermesStagingCapabilityName;
  envName: string;
  state: HermesStagingCapabilityState;
  detail?: string;
};

export type HermesStagingPlan =
  | {
      ok: false;
      code: "capability_unavailable";
      capabilities: HermesStagingCapability[];
    }
  | {
      ok: true;
      code: "ready";
      capabilities: HermesStagingCapability[];
    };

type HermesStagingSafeRun = {
  runId: string;
  phase: string;
  desiredOutcome: "acceptance" | "cleanup";
  nextAction:
    | { kind: "automatic"; retryAt: string | null }
    | {
        kind: "operator_telegram";
        challengeId: string;
        text: string;
        purpose: "initial" | "post_restart";
        expiresAt: string;
      }
    | { kind: "none" };
  checks: Record<string, boolean>;
  cleanup: {
    agent: "not_created" | "present" | "absent";
    workload: "not_created" | "present" | "absent";
    firewall: "not_created" | "present" | "absent";
    droplet: "not_created" | "present" | "absent";
    runner: "not_created" | "present" | "deleted";
    secretsRevoked: boolean;
  };
  errorCode: string | null;
  completedAt: string | null;
};

export type HermesStagingTelegramConfirmation = {
  purpose: "initial" | "post_restart";
  challengeText: string;
  expiresAt: string;
};

export type HermesStagingVerificationDependencies = {
  remoteAdapter?: HermesStagingRemoteAdapter;
  confirmTelegramReply?: (confirmation: HermesStagingTelegramConfirmation) => Promise<boolean>;
  isInteractive?: boolean;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  maxIterations?: number;
};

type CapabilitySpec = {
  name: HermesStagingCapabilityName;
  envName: string;
  validate: (value: string) => string | null;
};

const PLACEHOLDER_PATTERN = /^(?:replace-|example|placeholder|test-|changeme|todo|xxx)/i;
const IMAGE_DIGEST_PATTERN = /^ghcr\.io\/ametel01\/agentbay-hermes@sha256:[a-f0-9]{64}$/;
const SOURCE_REVISION_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_RUN_ID_PATTERN = /^[1-9]\d{0,19}$/;
const DEDICATED_BEARER_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ATTESTATION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export const HERMES_STAGING_ACCEPTANCE_API_PATH = "/api/internal/hermes-staging/acceptance";

export type HermesStagingRemoteCommand =
  | { command: "begin" }
  | {
      command: "attest_telegram_reply";
      runId: string;
      challengeId: string;
      attestationToken: string;
    }
  | { command: "request_cleanup"; runId: string }
  | { command: "advance"; runId: string }
  | { command: "read"; runId: string };

export type HermesStagingRemoteAdapter = {
  command: (command: HermesStagingRemoteCommand) => Promise<unknown>;
};

const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    name: "published_image",
    envName: "AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF",
    validate: validatePublishedImage,
  },
  {
    name: "configured_workload_image",
    envName: "AGENTBAY_HERMES_WORKLOAD_IMAGE",
    validate: validatePublishedImage,
  },
  {
    name: "image_source_revision",
    envName: "AGENTBAY_HERMES_STAGING_IMAGE_SOURCE_REVISION",
    validate: validateImageSourceRevision,
  },
  {
    name: "publish_workflow_run_id",
    envName: "AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID",
    validate: validatePublishWorkflowRunId,
  },
  {
    name: "acceptance_enabled",
    envName: "AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED",
    validate: exactValueValidator("true"),
  },
  {
    name: "acceptance_base_url",
    envName: "AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL",
    validate: validateStagingAcceptanceBaseUrl,
  },
  {
    name: "acceptance_bearer_secret",
    envName: "AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET",
    validate: validateDedicatedBearerSecret,
  },
  {
    name: "digitalocean_budget_authorization",
    envName: "AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION",
    validate: exactValueValidator(HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL),
  },
  {
    name: "digitalocean_token",
    envName: "AGENTBAY_DIGITALOCEAN_TOKEN",
    validate: validateDigitalOceanToken,
  },
  {
    name: "runner_bearer_token",
    envName: "AGENTBAY_RUNNER_BEARER_TOKEN",
    validate: validateOpaqueCredential,
  },
  {
    name: "openrouter_api_key",
    envName: "AGENTBAY_HERMES_STAGING_OPENROUTER_API_KEY",
    validate: validateOpenRouterKey,
  },
  {
    name: "telegram_bot_token",
    envName: "AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN",
    validate: validateTelegramBotToken,
  },
  {
    name: "telegram_test_user_id",
    envName: "AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID",
    validate: validatePositiveInteger,
  },
  {
    name: "telegram_test_chat_id",
    envName: "AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID",
    validate: validateSignedInteger,
  },
  {
    name: "live_side_effect_confirmation",
    envName: "AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION",
    validate: exactValueValidator(HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL),
  },
];

export function evaluateHermesStagingCapabilities(
  env: Record<string, string | undefined>,
): HermesStagingCapability[] {
  return CAPABILITY_SPECS.map((spec) => {
    const rawValue = env[spec.envName];

    if (rawValue === undefined) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "missing",
      };
    }

    const value = rawValue.trim();

    if (!value) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "malformed",
        detail: "blank",
      };
    }

    if (PLACEHOLDER_PATTERN.test(value)) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "malformed",
        detail: "placeholder",
      };
    }

    const validationError = spec.validate(rawValue);

    if (validationError) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "malformed",
        detail: validationError,
      };
    }

    if (
      spec.name === "acceptance_bearer_secret" &&
      [env.CRON_SECRET, env.AGENTBAY_RUNNER_BEARER_TOKEN, env.AGENTBAY_OPERATOR_PASSWORD].some(
        (otherSecret) => otherSecret !== undefined && otherSecret === rawValue,
      )
    ) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "malformed",
        detail: "dedicated_bearer_must_be_distinct",
      };
    }

    if (
      spec.name === "configured_workload_image" &&
      rawValue !== env.AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF
    ) {
      return {
        name: spec.name,
        envName: spec.envName,
        state: "malformed",
        detail: "configured_image_must_match_published_image",
      };
    }

    return {
      name: spec.name,
      envName: spec.envName,
      state: "configured",
    };
  });
}

export function planHermesStagingVerification(
  env: Record<string, string | undefined>,
): HermesStagingPlan {
  const capabilities = evaluateHermesStagingCapabilities(env);

  if (capabilities.some((capability) => capability.state !== "configured")) {
    return {
      ok: false,
      code: "capability_unavailable",
      capabilities,
    };
  }

  return {
    ok: true,
    code: "ready",
    capabilities,
  };
}

export function serializeHermesStagingPlan(plan: HermesStagingPlan): string {
  return JSON.stringify(
    {
      ok: plan.ok,
      code: plan.code,
      message:
        plan.code === "ready"
          ? "Hermes staging capabilities are configured; no side effects have been attempted yet."
          : "Hermes staging capability preflight failed closed; no side effects were attempted.",
      capabilities: plan.capabilities,
      sideEffectsAttempted: false,
    },
    null,
    2,
  );
}

export async function runHermesStagingVerification(
  env: Record<string, string | undefined> = process.env,
  output: { write: (message: string) => void } = { write: (message) => console.error(message) },
  dependencies: HermesStagingVerificationDependencies = {},
): Promise<number> {
  const plan = planHermesStagingVerification(env);

  if (!plan.ok) {
    output.write(`${serializeHermesStagingPlan(plan)}\n`);
    return 1;
  }

  const interactive = dependencies.isInteractive ?? Boolean(stdin.isTTY && stdout.isTTY && !env.CI);
  if (!interactive || !dependencies.confirmTelegramReply) {
    const confirm = dependencies.confirmTelegramReply ?? defaultTelegramConfirmation;
    if (!interactive) {
      output.write(
        `${JSON.stringify({
          ok: false,
          code: "interactive_confirmation_unavailable",
          message:
            "Run this command in an interactive TTY; no staging side effects were attempted.",
          capabilities: plan.capabilities,
          sideEffectsAttempted: false,
        })}\n`,
      );
      return 1;
    }
    dependencies = { ...dependencies, confirmTelegramReply: confirm };
  }

  const bearerSecret = env.AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET as string;
  const adapter =
    dependencies.remoteAdapter ??
    createHermesStagingRemoteAdapter({
      baseUrl: env.AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL as string,
      bearerSecret,
    });
  const now = dependencies.now ?? (() => new Date());
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const maxIterations = dependencies.maxIterations ?? 20_000;
  const confirmTelegramReply = dependencies.confirmTelegramReply ?? defaultTelegramConfirmation;
  let run: HermesStagingSafeRun | null = null;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
  };

  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    run = requireRemoteRun(await adapter.command({ command: "begin" }));

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (interrupted) throw new Error("interrupted");

      if (run.completedAt !== null || run.phase === "complete") {
        const passed = isSuccessfulCompletedRun(run);
        output.write(`${serializeFinalRun(passed, run)}\n`);
        return passed ? 0 : 1;
      }

      output.write(
        `${JSON.stringify({
          event: "acceptance_progress",
          phase: run.phase,
          desiredOutcome: run.desiredOutcome,
        })}\n`,
      );

      if (run.nextAction.kind === "operator_telegram") {
        const action = run.nextAction;
        output.write(
          `${JSON.stringify({
            event: "interactive_human_attestation_required",
            purpose: action.purpose,
            challengeText: action.text,
            expiresAt: action.expiresAt,
            instruction:
              "The allowlisted user must send this exact text to the dedicated bot and confirm the correlated Hermes reply. Do not paste the reply here.",
          })}\n`,
        );
        const confirmed = await confirmTelegramReply({
          purpose: action.purpose,
          challengeText: action.text,
          expiresAt: action.expiresAt,
        });
        if (!confirmed) throw new Error("human_attestation_declined");

        const digest = digestHermesStagingAttestationChallengeText(action.text);
        const attestationToken = digest
          ? createHermesStagingAttestationToken({
              bearerSecret,
              runId: run.runId,
              challenge: {
                purpose: action.purpose,
                challengeId: action.challengeId,
                digest,
              },
            })
          : null;
        if (!attestationToken) throw new Error("human_attestation_invalid");

        run = requireRemoteRun(
          await adapter.command({
            command: "attest_telegram_reply",
            runId: run.runId,
            challengeId: action.challengeId,
            attestationToken,
          }),
        );
        continue;
      }

      if (run.nextAction.kind === "automatic") {
        await waitForRetry(run.nextAction.retryAt, now, sleep);
        const response = await adapter.command({ command: "advance", runId: run.runId });
        run =
          remoteRunOrNull(response) ??
          requireRemoteRun(await adapter.command({ command: "read", runId: run.runId }));
        continue;
      }

      await sleep(1_000);
      run = requireRemoteRun(await adapter.command({ command: "read", runId: run.runId }));
    }

    throw new Error("iteration_limit");
  } catch {
    if (run) {
      try {
        run = await requestAndDrainCleanup({ adapter, run, now, sleep, maxIterations });
      } catch {
        // The durable server-side deadline and cleanup-only cron path remain authoritative.
      }
    }
    output.write(
      `${JSON.stringify({
        ok: false,
        code: "acceptance_failed_safely",
        phase: run?.phase ?? "preflight",
        cleanup: run ? sanitizeCleanup(run.cleanup) : "not_started",
      })}\n`,
    );
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

async function defaultTelegramConfirmation(
  confirmation: HermesStagingTelegramConfirmation,
): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout, terminal: true });
  try {
    const answer = await prompt.question(
      `After the allowlisted user sends the exact ${confirmation.purpose} challenge and receives the correlated Hermes reply, type reply-confirmed: `,
    );
    return answer.trim() === "reply-confirmed";
  } finally {
    prompt.close();
  }
}

async function waitForRetry(
  retryAt: string | null,
  now: () => Date,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  const remaining = retryAt === null ? 0 : Date.parse(retryAt) - now().getTime();
  if (remaining > 0) await sleep(Math.min(remaining, 30_000));
}

async function requestAndDrainCleanup(input: {
  adapter: HermesStagingRemoteAdapter;
  run: HermesStagingSafeRun;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
  maxIterations: number;
}): Promise<HermesStagingSafeRun> {
  let run = requireRemoteRun(
    await input.adapter.command({ command: "request_cleanup", runId: input.run.runId }),
  );

  for (let iteration = 0; iteration < input.maxIterations; iteration += 1) {
    if (run.completedAt !== null || run.phase === "complete") return run;

    if (run.nextAction.kind === "automatic") {
      await waitForRetry(run.nextAction.retryAt, input.now, input.sleep);
      const response = await input.adapter.command({ command: "advance", runId: run.runId });
      run =
        remoteRunOrNull(response) ??
        requireRemoteRun(await input.adapter.command({ command: "read", runId: run.runId }));
      continue;
    }

    await input.sleep(1_000);
    run = requireRemoteRun(await input.adapter.command({ command: "read", runId: run.runId }));
  }

  return run;
}

function requireRemoteRun(payload: unknown): HermesStagingSafeRun {
  const run = remoteRunOrNull(payload);
  if (!run) throw new Error("Hermes staging remote response is invalid.");
  return run;
}

function remoteRunOrNull(payload: unknown): HermesStagingSafeRun | null {
  if (!isPlainRecord(payload) || payload.ok !== true || !("run" in payload)) return null;
  return parseSafeRun(payload.run);
}

const HERMES_STAGING_PHASES = new Set([
  "preflight",
  "attesting_image",
  "creating_ready_agent",
  "observing_deployment",
  "verifying_host_image",
  "awaiting_initial_human_proof",
  "restarting",
  "reverifying_runtime",
  "awaiting_post_restart_human_proof",
  "auditing_diagnostics",
  "stopping_agent",
  "observing_stop_stability",
  "checking_rollback",
  "cleaning_workload",
  "cleaning_secrets",
  "cleaning_firewall",
  "cleaning_droplet",
  "cleaning_runner",
  "complete",
]);

const HERMES_STAGING_CHECK_KEYS = [
  "imageAttested",
  "deploymentStagesObserved",
  "initialReplyAttested",
  "restartReady",
  "restartImageAttested",
  "postRestartReplyAttested",
  "diagnosticsRedacted",
  "intentionalStopStable",
  "rollbackVerified",
] as const;

function parseSafeRun(value: unknown): HermesStagingSafeRun | null {
  if (
    !isPlainRecord(value) ||
    !isUuid(value.runId) ||
    typeof value.phase !== "string" ||
    !HERMES_STAGING_PHASES.has(value.phase) ||
    (value.desiredOutcome !== "acceptance" && value.desiredOutcome !== "cleanup") ||
    !isPlainRecord(value.checks) ||
    !hasExactKeys(value.checks, HERMES_STAGING_CHECK_KEYS) ||
    HERMES_STAGING_CHECK_KEYS.some(
      (key) => typeof (value.checks as Record<string, unknown>)[key] !== "boolean",
    ) ||
    !isPlainRecord(value.cleanup) ||
    typeof value.cleanup.secretsRevoked !== "boolean" ||
    (value.errorCode !== null && typeof value.errorCode !== "string") ||
    (value.completedAt !== null && !isIsoTimestamp(value.completedAt))
  ) {
    return null;
  }

  const nextAction = parseSafeNextAction(value.nextAction);
  const cleanup = parseSafeCleanup(value.cleanup);
  if (!nextAction || !cleanup) return null;

  return {
    runId: value.runId,
    phase: value.phase,
    desiredOutcome: value.desiredOutcome,
    nextAction,
    checks: Object.fromEntries(
      HERMES_STAGING_CHECK_KEYS.map((key) => [
        key,
        (value.checks as Record<string, boolean>)[key] as boolean,
      ]),
    ),
    cleanup,
    errorCode: value.errorCode,
    completedAt: value.completedAt,
  };
}

function parseSafeNextAction(value: unknown): HermesStagingSafeRun["nextAction"] | null {
  if (!isPlainRecord(value) || typeof value.kind !== "string") return null;
  if (value.kind === "none" && hasExactKeys(value, ["kind"])) return { kind: "none" };

  if (
    value.kind === "automatic" &&
    hasExactKeys(value, ["kind", "retryAt"]) &&
    (value.retryAt === null || isIsoTimestamp(value.retryAt))
  ) {
    return { kind: "automatic", retryAt: value.retryAt };
  }

  if (
    value.kind === "operator_telegram" &&
    hasExactKeys(value, ["kind", "challengeId", "text", "purpose", "expiresAt"]) &&
    isUuid(value.challengeId) &&
    typeof value.text === "string" &&
    digestHermesStagingAttestationChallengeText(value.text) !== null &&
    (value.purpose === "initial" || value.purpose === "post_restart") &&
    isIsoTimestamp(value.expiresAt)
  ) {
    return {
      kind: "operator_telegram",
      challengeId: value.challengeId,
      text: value.text,
      purpose: value.purpose,
      expiresAt: value.expiresAt,
    };
  }

  return null;
}

function parseSafeCleanup(value: Record<string, unknown>): HermesStagingSafeRun["cleanup"] | null {
  if (
    !hasExactKeys(value, [
      "agent",
      "workload",
      "firewall",
      "droplet",
      "runner",
      "secretsRevoked",
    ]) ||
    !isCleanupResourceState(value.agent) ||
    !isCleanupResourceState(value.workload) ||
    !isCleanupResourceState(value.firewall) ||
    !isCleanupResourceState(value.droplet) ||
    (value.runner !== "not_created" && value.runner !== "present" && value.runner !== "deleted") ||
    typeof value.secretsRevoked !== "boolean"
  ) {
    return null;
  }

  return {
    agent: value.agent,
    workload: value.workload,
    firewall: value.firewall,
    droplet: value.droplet,
    runner: value.runner,
    secretsRevoked: value.secretsRevoked,
  };
}

function isCleanupResourceState(value: unknown): value is "not_created" | "present" | "absent" {
  return value === "not_created" || value === "present" || value === "absent";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function isSuccessfulCompletedRun(run: HermesStagingSafeRun): boolean {
  return (
    run.phase === "complete" &&
    run.completedAt !== null &&
    run.errorCode === null &&
    HERMES_STAGING_CHECK_KEYS.every((key) => run.checks[key] === true) &&
    run.cleanup.agent !== "present" &&
    run.cleanup.workload !== "present" &&
    run.cleanup.firewall !== "present" &&
    run.cleanup.droplet !== "present" &&
    run.cleanup.runner !== "present" &&
    run.cleanup.secretsRevoked
  );
}

function serializeFinalRun(passed: boolean, run: HermesStagingSafeRun): string {
  return JSON.stringify({
    ok: passed,
    code: passed ? "hermes_staging_acceptance_passed" : "hermes_staging_acceptance_failed",
    mode: "interactive_human_attested",
    phase: run.phase,
    checks: run.checks,
    cleanup: sanitizeCleanup(run.cleanup),
    errorCode: run.errorCode,
  });
}

function sanitizeCleanup(
  cleanup: HermesStagingSafeRun["cleanup"],
): HermesStagingSafeRun["cleanup"] {
  return { ...cleanup };
}

export function createHermesStagingRemoteAdapter(input: {
  baseUrl: string;
  bearerSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): HermesStagingRemoteAdapter {
  const baseUrlError = validateStagingAcceptanceBaseUrl(input.baseUrl);
  const timeoutMs = input.timeoutMs ?? 15_000;

  if (
    baseUrlError ||
    validateDedicatedBearerSecret(input.bearerSecret) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000
  ) {
    throw new Error("Hermes staging remote adapter configuration is invalid.");
  }

  const endpoint = `${new URL(input.baseUrl).origin}${HERMES_STAGING_ACCEPTANCE_API_PATH}`;
  const fetchImpl = input.fetchImpl ?? fetch;

  return {
    async command(command) {
      const body = serializeRemoteCommand(command);
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          Authorization: `Bearer ${input.bearerSecret}`,
          "Content-Type": "application/json",
        },
        body,
      });

      return await readBoundedRemoteResponse(response);
    },
  };
}

function serializeRemoteCommand(command: HermesStagingRemoteCommand): string {
  if (!isPlainRecord(command) || typeof command.command !== "string") {
    throw new Error("Hermes staging remote command is invalid.");
  }

  if (command.command === "begin" && hasExactKeys(command, ["command"])) {
    return JSON.stringify({ command: "begin" });
  }

  if (
    command.command === "attest_telegram_reply" &&
    hasExactKeys(command, ["command", "runId", "challengeId", "attestationToken"]) &&
    isUuid(command.runId) &&
    isUuid(command.challengeId) &&
    typeof command.attestationToken === "string" &&
    ATTESTATION_TOKEN_PATTERN.test(command.attestationToken)
  ) {
    return JSON.stringify({
      command: command.command,
      runId: command.runId,
      challengeId: command.challengeId,
      attestationToken: command.attestationToken,
    });
  }

  if (
    (command.command === "request_cleanup" ||
      command.command === "advance" ||
      command.command === "read") &&
    hasExactKeys(command, ["command", "runId"]) &&
    isUuid(command.runId)
  ) {
    return JSON.stringify({ command: command.command, runId: command.runId });
  }

  throw new Error("Hermes staging remote command is invalid.");
}

function exactValueValidator(expected: string): (value: string) => string | null {
  return (value) => (value === expected ? null : "exact_sentinel_required");
}

function validatePublishedImage(value: string): string | null {
  if (!IMAGE_DIGEST_PATTERN.test(value)) {
    return "published_ghcr_digest_required";
  }

  if (
    value === DEFAULT_HERMES_WORKLOAD_IMAGE ||
    value.endsWith(`@${DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST}`) ||
    value.endsWith(`@${DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST}`)
  ) {
    return "source_pinned_digest_not_accepted";
  }

  return null;
}

function validateImageSourceRevision(value: string): string | null {
  return SOURCE_REVISION_PATTERN.test(value) ? null : "lowercase_40_hex_revision_required";
}

function validatePublishWorkflowRunId(value: string): string | null {
  return WORKFLOW_RUN_ID_PATTERN.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
    ? null
    : "positive_safe_1_to_20_digit_run_id_required";
}

function validateStagingAcceptanceBaseUrl(value: string): string | null {
  if (value.trim() !== value) {
    return "exact_https_base_url_required";
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? null
      : "exact_https_base_url_required";
  } catch {
    return "exact_https_base_url_required";
  }
}

function validateDedicatedBearerSecret(value: string): string | null {
  return DEDICATED_BEARER_PATTERN.test(value)
    ? null
    : "dedicated_32_to_256_character_bearer_required";
}

async function readBoundedRemoteResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const declaredLength = response.headers.get("content-length");
  const maxBytes = 16 * 1024;

  if (
    contentType !== "application/json" ||
    (declaredLength !== null &&
      (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes))
  ) {
    throw new Error("Hermes staging remote response is invalid.");
  }

  const bytes = await readResponseBytes(response, maxBytes);

  if (bytes.byteLength === 0) {
    throw new Error("Hermes staging remote response is invalid.");
  }

  let payload: unknown;

  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("Hermes staging remote response is invalid.");
  }

  if (!response.ok) {
    throw new Error("Hermes staging remote command failed safely.");
  }

  return payload;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) {
    return new Uint8Array();
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error("Hermes staging remote response is invalid.");
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const result = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return result;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateDigitalOceanToken(value: string): string | null {
  return /^dop_v1_[A-Za-z0-9]{48,}$/.test(value) ? null : "digitalocean_token_shape_required";
}

function validateOpaqueCredential(value: string): string | null {
  if (/\s/.test(value)) {
    return "credential_without_whitespace_required";
  }

  return value.length >= 20 ? null : "credential_too_short";
}

function validateOpenRouterKey(value: string): string | null {
  return /^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(value) ? null : "openrouter_key_shape_required";
}

function validateTelegramBotToken(value: string): string | null {
  return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(value) ? null : "telegram_token_shape_required";
}

function validatePositiveInteger(value: string): string | null {
  return /^[1-9]\d*$/.test(value) ? null : "positive_numeric_id_required";
}

function validateSignedInteger(value: string): string | null {
  return /^-?[1-9]\d*$/.test(value) ? null : "numeric_chat_id_required";
}

if (import.meta.main) {
  process.exitCode = await runHermesStagingVerification();
}
