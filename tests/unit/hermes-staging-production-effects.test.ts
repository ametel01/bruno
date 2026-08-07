import { describe, expect, it, vi } from "vitest";
import type { HermesStagingAcceptanceEffectContext } from "@/src/server/staging/hermes-staging-acceptance-effects";
import {
  createProductionHermesStagingAcceptanceEffectExecutor,
  type HermesStagingProductionEffectPorts,
  hasHermesStagingDiagnosticLeak,
} from "@/src/server/staging/hermes-staging-production-effects";

const NOW = new Date("2026-08-03T10:00:00.000Z");
const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `ghcr.io/ametel01/agentbay-hermes@${DIGEST}`;
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const DEPLOYMENT_ID = "22222222-2222-4222-8222-222222222222";
const RUNNER_ID = "33333333-3333-4333-8333-333333333333";

function env(): Record<string, string> {
  return {
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.com",
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: "acceptance-bearer-credential-00001",
    AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: IMAGE,
    AGENTBAY_HERMES_WORKLOAD_IMAGE: IMAGE,
    AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION:
      "authorize-basic-4usd-digitalocean-staging",
    AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION:
      "send-telegram-and-spend-digitalocean-staging",
    AGENTBAY_HERMES_STAGING_ASSISTANT: "chatgpt",
    AGENTBAY_HERMES_STAGING_OPENAI_API_KEY: "sk-abcdefghijklmnopqrstuvwxyz123456",
    AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN: "123456789:abcdefghijklmnopqrstuvwxyz123456",
    AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID: "123456789",
    AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID: "-123456789",
    AGENTBAY_DIGITALOCEAN_TOKEN: "digitalocean-provider-token-0000000001",
    AGENTBAY_RUNNER_BEARER_TOKEN: "runner-bearer-credential-000000001",
    AGENTBAY_RUNNER_IMAGE: `ghcr.io/ametel01/agentbay-runner:sha-staging@${DIGEST}`,
    AGENTBAY_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
    AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
    AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({
      v1: Buffer.alloc(32, 7).toString("base64"),
    }),
  };
}

function context(
  overrides: Partial<HermesStagingAcceptanceEffectContext> = {},
): HermesStagingAcceptanceEffectContext {
  return {
    runId: "44444444-4444-4444-8444-444444444444",
    ownerUserId: "55555555-5555-4555-8555-555555555555",
    idempotencyKey: "staging-acceptance-0001",
    generation: 1,
    attemptCount: 0,
    deploymentStageIndex: -1,
    expectedSourceRevision: "0123456789abcdef0123456789abcdef01234567",
    expectedPublishWorkflowRunId: "123456",
    expectedImageDigest: DIGEST,
    observedImageDigest: null,
    agentId: AGENT_ID,
    deploymentId: DEPLOYMENT_ID,
    runnerId: RUNNER_ID,
    providerResourceId: "12345678",
    providerFirewallId: "firewall-12345678",
    restartRequestedAt: new Date(NOW.getTime() - 1_000),
    challenge: {
      purpose: "initial",
      challengeId: "challenge-1",
      text: "bruno staging challenge",
      digest: `sha256:${"b".repeat(64)}`,
      expiresAt: new Date(NOW.getTime() + 60_000),
    },
    ...overrides,
  };
}

function ports(
  overrides: Partial<HermesStagingProductionEffectPorts> = {},
): HermesStagingProductionEffectPorts {
  return {
    checkPreflightOwner: vi.fn(async () => "confirmed" as const),
    attestPublishedImage: vi.fn(
      async () =>
        ({
          state: "confirmed",
          releaseDigest: DIGEST,
          amd64ManifestDigest: DIGEST,
        }) as const,
    ),
    createReadyAgent: vi.fn(
      async () =>
        ({
          state: "accepted",
          resource: {
            agentId: AGENT_ID,
            deploymentId: DEPLOYMENT_ID,
            runnerId: RUNNER_ID,
            providerResourceId: "12345678",
            providerFirewallId: "firewall-12345678",
          },
        }) as const,
    ),
    observeAgentCreation: vi.fn(
      async () =>
        ({
          state: "found",
          resource: {
            agentId: AGENT_ID,
            deploymentId: DEPLOYMENT_ID,
            runnerId: RUNNER_ID,
            providerResourceId: "12345678",
            providerFirewallId: "firewall-12345678",
          },
        }) as const,
    ),
    advanceDeployment: vi.fn(
      async () =>
        ({
          state: "observed",
          stage: "pending",
          resource: {
            agentId: AGENT_ID,
            deploymentId: DEPLOYMENT_ID,
            runnerId: RUNNER_ID,
            providerResourceId: "12345678",
            providerFirewallId: "firewall-12345678",
          },
        }) as const,
    ),
    observeStrictRuntime: vi.fn(
      async () =>
        ({
          state: "exact_ready",
          imageDigest: DIGEST,
          acceptedAt: NOW,
          operationAction: "restart",
        }) as const,
    ),
    restartAgent: vi.fn(async () => "accepted" as const),
    observeRestart: vi.fn(async () => "completed" as const),
    auditDiagnostics: vi.fn(async () => "safe" as const),
    stopAgent: vi.fn(async () => "accepted" as const),
    observeStopIntent: vi.fn(async () => "desired_stopped" as const),
    observeStopStability: vi.fn(async () => "stopped" as const),
    cleanupWorkload: vi.fn(async () => "accepted" as const),
    observeWorkloadAbsence: vi.fn(async () => "absent" as const),
    cleanupSecrets: vi.fn(async () => "accepted" as const),
    observeSecretsAbsence: vi.fn(async () => "absent" as const),
    cleanupFirewall: vi.fn(async () => "accepted" as const),
    observeFirewallAbsence: vi.fn(async () => "absent" as const),
    cleanupDroplet: vi.fn(async () => "accepted" as const),
    observeDropletAbsence: vi.fn(async () => "absent" as const),
    cleanupRunner: vi.fn(async () => "accepted" as const),
    observeRunnerAbsence: vi.fn(async () => "absent" as const),
    ...overrides,
  };
}

function executor(portOverrides: Partial<HermesStagingProductionEffectPorts> = {}) {
  const allPorts = ports(portOverrides);
  return {
    allPorts,
    executor: createProductionHermesStagingAcceptanceEffectExecutor({
      env: env(),
      now: () => NOW,
      ports: allPorts,
    }),
  };
}

describe("production Hermes staging acceptance effects", () => {
  it("fails preflight closed before any product boundary when exact live capabilities mismatch", async () => {
    const allPorts = ports();
    const malformed = env();
    malformed.AGENTBAY_HERMES_WORKLOAD_IMAGE = `${IMAGE}-other`;
    const effect = createProductionHermesStagingAcceptanceEffectExecutor({
      env: malformed,
      now: () => NOW,
      ports: allPorts,
    });

    await expect(
      effect.execute("preflight", context(), new AbortController().signal),
    ).resolves.toEqual({ result: { effect: "preflight", outcome: "failed" } });
    expect(allPorts.checkPreflightOwner).not.toHaveBeenCalled();
  });

  it("rejects an invalid Telegram token fixture without contacting Telegram", async () => {
    const allPorts = ports();
    const malformed = env();
    malformed.AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN = "invalid-token";
    const effect = createProductionHermesStagingAcceptanceEffectExecutor({
      env: malformed,
      now: () => NOW,
      ports: allPorts,
    });

    await expect(
      effect.execute("preflight", context(), new AbortController().signal),
    ).resolves.toEqual({ result: { effect: "preflight", outcome: "failed" } });
    expect(allPorts.checkPreflightOwner).not.toHaveBeenCalled();
    expect(allPorts.createReadyAgent).not.toHaveBeenCalled();
  });

  it("requires both published release and amd64 manifest digests to match", async () => {
    const { executor: effect } = executor({
      attestPublishedImage: vi.fn(
        async () =>
          ({
            state: "confirmed",
            releaseDigest: DIGEST,
            amd64ManifestDigest: `sha256:${"c".repeat(64)}`,
          }) as const,
      ),
    });

    await expect(
      effect.execute("attest_published_image", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "attest_published_image", outcome: "failed" },
    });
  });

  it("maps create and duplicate replay only with exact correlated identifiers", async () => {
    const { executor: effect } = executor();
    const created = await effect.execute(
      "create_ready_agent",
      context(),
      new AbortController().signal,
    );
    const replay = await effect.execute(
      "observe_agent_creation",
      context(),
      new AbortController().signal,
    );

    expect(created).toMatchObject({
      result: { effect: "create_ready_agent", outcome: "accepted" },
      evidence: { agentId: AGENT_ID, deploymentId: DEPLOYMENT_ID, runnerId: RUNNER_ID },
    });
    expect(replay).toMatchObject({
      result: { effect: "observe_agent_creation", outcome: "found" },
      evidence: { agentId: AGENT_ID, deploymentId: DEPLOYMENT_ID },
    });
  });

  it("recovers an unknown create mutation only through exact idempotent rediscovery", async () => {
    const { executor: effect } = executor({
      createReadyAgent: vi.fn(async () => ({ state: "unknown" }) as const),
    });

    await expect(
      effect.execute("create_ready_agent", context(), new AbortController().signal),
    ).resolves.toEqual({ result: { effect: "create_ready_agent", outcome: "unknown" } });
    await expect(
      effect.execute("observe_agent_creation", context(), new AbortController().signal),
    ).resolves.toMatchObject({
      result: { effect: "observe_agent_creation", outcome: "found" },
      evidence: { agentId: AGENT_ID, deploymentId: DEPLOYMENT_ID },
    });
  });

  it("keeps provider failure and runner delay distinct and fail closed", async () => {
    const { executor: failed } = executor({
      advanceDeployment: vi.fn(async () => ({ state: "failed" }) as const),
    });
    const { executor: delayed } = executor({
      observeStrictRuntime: vi.fn(async () => ({ state: "not_ready" }) as const),
    });

    await expect(
      failed.execute("observe_next_deployment_stage", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "observe_next_deployment_stage", outcome: "failed" },
    });
    await expect(
      delayed.execute("verify_strict_host_image", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "verify_strict_host_image", outcome: "not_ready" },
    });
  });

  it("rejects mismatched image and stale or non-restart post-restart observations", async () => {
    const { executor: mismatched } = executor({
      observeStrictRuntime: vi.fn(async () => ({ state: "mismatch" }) as const),
    });
    const { executor: stale } = executor({
      observeStrictRuntime: vi.fn(
        async () =>
          ({
            state: "exact_ready",
            imageDigest: DIGEST,
            acceptedAt: new Date(NOW.getTime() - 2_000),
            operationAction: "start",
          }) as const,
      ),
    });

    await expect(
      mismatched.execute("verify_strict_host_image", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "verify_strict_host_image", outcome: "mismatch" },
    });
    await expect(
      stale.execute("verify_restarted_image_and_telegram", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "verify_restarted_image_and_telegram", outcome: "mismatch" },
    });
  });

  it("never promotes unsafe or unknown diagnostics to redaction evidence", async () => {
    for (const outcome of ["unsafe", "unknown"] as const) {
      const { executor: effect } = executor({ auditDiagnostics: vi.fn(async () => outcome) });
      const execution = await effect.execute(
        "audit_safe_diagnostics",
        context(),
        new AbortController().signal,
      );
      expect(execution.result).toEqual({ effect: "audit_safe_diagnostics", outcome });
      expect(execution.evidence).toBeUndefined();
    }
  });

  it("detects actual secrets, Telegram PII, private endpoints, and provider bodies", () => {
    const actualSecrets = ["real-secret-value", "123456789", "https://10.0.0.4:3045"];

    expect(
      hasHermesStagingDiagnosticLeak({ message: "token real-secret-value" }, actualSecrets),
    ).toBe(true);
    expect(hasHermesStagingDiagnosticLeak({ actor: "123456789" }, actualSecrets)).toBe(true);
    expect(
      hasHermesStagingDiagnosticLeak({ endpoint: "https://10.0.0.4:3045" }, actualSecrets),
    ).toBe(true);
    expect(hasHermesStagingDiagnosticLeak({ providerResponse: { id: 123 } }, [])).toBe(true);
    expect(
      hasHermesStagingDiagnosticLeak(
        { message: "Runner provisioning failed safely.", token: "[redacted]" },
        actualSecrets,
      ),
    ).toBe(false);
  });

  it("fails owner and identifier conflicts without retaining evidence", async () => {
    const { executor: ownerFailure } = executor({
      checkPreflightOwner: vi.fn(async () => "failed" as const),
    });
    const { executor: idConflict } = executor({
      observeAgentCreation: vi.fn(async () => ({ state: "conflict" }) as const),
    });

    await expect(
      ownerFailure.execute("preflight", context(), new AbortController().signal),
    ).resolves.toEqual({ result: { effect: "preflight", outcome: "failed" } });
    await expect(
      idConflict.execute("observe_agent_creation", context(), new AbortController().signal),
    ).resolves.toEqual({
      result: { effect: "observe_agent_creation", outcome: "conflict" },
    });
  });

  it("records Stop and cleanup evidence only after confirmed observations in order", async () => {
    const { executor: effect } = executor();
    const sequence = [
      "stop_agent_db_first",
      "observe_stop_intent",
      "observe_stop_stability",
      "cleanup_workload",
      "observe_workload_absence",
      "cleanup_secrets",
      "observe_secrets_absence",
      "cleanup_firewall",
      "observe_firewall_absence",
      "cleanup_droplet",
      "observe_droplet_absence",
      "cleanup_runner",
      "observe_runner_absence",
    ] as const;
    const results = [];
    for (const effectKind of sequence) {
      results.push(await effect.execute(effectKind, context(), new AbortController().signal));
    }

    expect(results[2]).toMatchObject({ evidence: { stopVerifiedAt: NOW } });
    expect(results[4]).toMatchObject({ evidence: { workloadCleanupConfirmedAt: NOW } });
    expect(results[6]).toMatchObject({ evidence: { secretsCleanupConfirmedAt: NOW } });
    expect(results[8]).toMatchObject({ evidence: { firewallCleanupConfirmedAt: NOW } });
    expect(results[10]).toMatchObject({ evidence: { dropletCleanupConfirmedAt: NOW } });
    expect(results[12]).toMatchObject({ evidence: { runnerCleanupConfirmedAt: NOW } });
  });

  it("does not record Stop or cleanup evidence for instability, ambiguity, or presence", async () => {
    const { executor: effect } = executor({
      observeStopStability: vi.fn(async () => "active" as const),
      cleanupFirewall: vi.fn(async () => "failed" as const),
      observeDropletAbsence: vi.fn(async () => "present" as const),
      observeRunnerAbsence: vi.fn(async () => "unknown" as const),
    });

    const unstable = await effect.execute(
      "observe_stop_stability",
      context(),
      new AbortController().signal,
    );
    const ambiguous = await effect.execute(
      "cleanup_firewall",
      context(),
      new AbortController().signal,
    );
    const present = await effect.execute(
      "observe_droplet_absence",
      context(),
      new AbortController().signal,
    );
    const unknown = await effect.execute(
      "observe_runner_absence",
      context(),
      new AbortController().signal,
    );

    expect(unstable).toEqual({
      result: { effect: "observe_stop_stability", outcome: "active" },
    });
    expect(ambiguous).toEqual({ result: { effect: "cleanup_firewall", outcome: "failed" } });
    expect(present).toEqual({
      result: { effect: "observe_droplet_absence", outcome: "present" },
    });
    expect(unknown).toEqual({
      result: { effect: "observe_runner_absence", outcome: "unknown" },
    });
  });

  it("returns unknown without invoking any boundary after abort", async () => {
    const { executor: effect, allPorts } = executor();
    const controller = new AbortController();
    controller.abort();

    await expect(effect.execute("cleanup_droplet", context(), controller.signal)).resolves.toEqual({
      result: { effect: "cleanup_droplet", outcome: "unknown" },
    });
    expect(allPorts.cleanupDroplet).not.toHaveBeenCalled();
  });

  it("echoes only the core-issued human challenge and never contacts Telegram", async () => {
    const { executor: effect, allPorts } = executor();
    const issued = await effect.execute(
      "issue_initial_human_challenge",
      context(),
      new AbortController().signal,
    );

    expect(issued).toEqual({
      result: {
        effect: "issue_initial_human_challenge",
        outcome: "issued",
        challengeDigest: `sha256:${"b".repeat(64)}`,
        expiresAtMs: NOW.getTime() + 60_000,
      },
    });
    expect(allPorts.createReadyAgent).not.toHaveBeenCalled();
  });
});
