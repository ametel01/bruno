import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createHermesStagingRemoteAdapter,
  evaluateHermesStagingCapabilities,
  HERMES_STAGING_ACCEPTANCE_API_PATH,
  HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL,
  HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL,
  planHermesStagingVerification,
  runHermesStagingVerification,
  serializeHermesStagingPlan,
} from "@/scripts/verify-hermes-staging";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";

const SAFE_PUBLISHED_IMAGE =
  "ghcr.io/ametel01/agentbay-hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";

const SECRET_VALUES = {
  acceptanceBearerSecret: "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345",
  digitalOceanToken: `dop_v1_${"a".repeat(64)}`,
  runnerBearerToken: "agb_run_secret1234567890123456789012345678901234567890123",
  openAiKey: "sk-openai-secret12345678901234567890",
  telegramToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
  telegramUserId: "123456789",
  telegramChatId: "-1001234567890",
};

function completeEnv(): Record<string, string | undefined> {
  return {
    AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: SAFE_PUBLISHED_IMAGE,
    AGENTBAY_HERMES_WORKLOAD_IMAGE: SAFE_PUBLISHED_IMAGE,
    AGENTBAY_HERMES_STAGING_IMAGE_SOURCE_REVISION: SOURCE_REVISION,
    AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID: "987654321",
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.test",
    AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: SECRET_VALUES.acceptanceBearerSecret,
    AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION:
      HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL,
    AGENTBAY_DIGITALOCEAN_TOKEN: SECRET_VALUES.digitalOceanToken,
    AGENTBAY_RUNNER_BEARER_TOKEN: SECRET_VALUES.runnerBearerToken,
    AGENTBAY_HERMES_STAGING_ASSISTANT: "chatgpt",
    AGENTBAY_HERMES_STAGING_OPENAI_API_KEY: SECRET_VALUES.openAiKey,
    AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN: SECRET_VALUES.telegramToken,
    AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID: SECRET_VALUES.telegramUserId,
    AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID: SECRET_VALUES.telegramChatId,
    AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION: HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL,
  };
}

function noCapabilityProcessEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };

  for (const envName of Object.keys(completeEnv())) {
    delete env[envName];
  }

  return env;
}

describe("Hermes staging verification gate", () => {
  it("reports every missing capability without side effects or secret fields", () => {
    const plan = planHermesStagingVerification({});
    const report = serializeHermesStagingPlan(plan);

    expect(plan.code).toBe("capability_unavailable");
    expect(plan.capabilities).toHaveLength(16);
    expect(plan.capabilities.every((capability) => capability.state === "missing")).toBe(true);
    expect(report).toContain('"sideEffectsAttempted": false');
    expect(report).toContain("AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF");
    expect(report).not.toContain("process.env");
  });

  it("fails blank, placeholder, malformed, tag-only, and source-pinned inputs closed", () => {
    const malformedEnv = {
      ...completeEnv(),
      AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: "ghcr.io/ametel01/agentbay-hermes:staging",
      AGENTBAY_HERMES_WORKLOAD_IMAGE: "nousresearch/hermes-agent:latest",
      AGENTBAY_HERMES_STAGING_IMAGE_SOURCE_REVISION: "A".repeat(40),
      AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID: "0",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "yes",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: "http://staging.example.test/private",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: "too-short",
      AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION: "true",
      AGENTBAY_DIGITALOCEAN_TOKEN: "replace-with-digitalocean-token",
      AGENTBAY_RUNNER_BEARER_TOKEN: "runner credential with spaces",
      AGENTBAY_HERMES_STAGING_ASSISTANT: "other",
      AGENTBAY_HERMES_STAGING_OPENAI_API_KEY: " ",
      AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN: "not-a-token",
      AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID: "user-123",
      AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID: "0",
      AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION: "yes",
    };

    const capabilities = evaluateHermesStagingCapabilities(malformedEnv);

    expect(capabilities.map((capability) => capability.state)).toEqual([
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
      "malformed",
    ]);
    expect(capabilities.map((capability) => capability.detail)).toEqual([
      "published_ghcr_digest_required",
      "published_ghcr_digest_required",
      "lowercase_40_hex_revision_required",
      "positive_safe_1_to_20_digit_run_id_required",
      "exact_sentinel_required",
      "exact_https_base_url_required",
      "dedicated_32_to_256_character_bearer_required",
      "exact_sentinel_required",
      "placeholder",
      "credential_without_whitespace_required",
      "chatgpt_or_claude_required",
      "blank",
      "telegram_token_shape_required",
      "positive_numeric_id_required",
      "numeric_chat_id_required",
      "exact_sentinel_required",
    ]);

    for (const digest of [
      DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
      DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
    ]) {
      const sourcePinned = evaluateHermesStagingCapabilities({
        ...completeEnv(),
        AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: `ghcr.io/ametel01/agentbay-hermes@${digest}`,
        AGENTBAY_HERMES_WORKLOAD_IMAGE: `ghcr.io/ametel01/agentbay-hermes@${digest}`,
      });

      expect(sourcePinned[0]).toMatchObject({
        name: "published_image",
        state: "malformed",
        detail: "source_pinned_digest_not_accepted",
      });
    }
  });

  it("requires exact budget and live side-effect sentinels", () => {
    const capabilities = evaluateHermesStagingCapabilities({
      ...completeEnv(),
      AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION: `${HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL} `,
      AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION:
        HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL.toUpperCase(),
    });

    expect(
      capabilities.find(({ name }) => name === "digitalocean_budget_authorization"),
    ).toMatchObject({
      name: "digitalocean_budget_authorization",
      state: "malformed",
      detail: "exact_sentinel_required",
    });
    expect(capabilities.find(({ name }) => name === "live_side_effect_confirmation")).toMatchObject(
      {
        name: "live_side_effect_confirmation",
        state: "malformed",
        detail: "exact_sentinel_required",
      },
    );
  });

  it("selects exactly one assistant-matched direct model key", () => {
    const claudeEnv = completeEnv();
    claudeEnv.AGENTBAY_HERMES_STAGING_ASSISTANT = "claude";
    delete claudeEnv.AGENTBAY_HERMES_STAGING_OPENAI_API_KEY;
    claudeEnv.AGENTBAY_HERMES_STAGING_ANTHROPIC_API_KEY = `sk-ant-${"a".repeat(32)}`;

    expect(
      evaluateHermesStagingCapabilities(claudeEnv).find(({ name }) => name === "model_api_key"),
    ).toMatchObject({
      envName: "AGENTBAY_HERMES_STAGING_ANTHROPIC_API_KEY",
      state: "configured",
    });

    claudeEnv.AGENTBAY_HERMES_STAGING_OPENAI_API_KEY = SECRET_VALUES.openAiKey;
    expect(
      evaluateHermesStagingCapabilities(claudeEnv).find(({ name }) => name === "model_api_key"),
    ).toMatchObject({ state: "malformed", detail: "unselected_model_api_key_must_be_unset" });
  });

  it("requires the HTTPS acceptance port and a bearer distinct from every existing authority", () => {
    for (const baseUrl of [
      "http://staging.example.test",
      " https://staging.example.test",
      "https://user:password@staging.example.test",
      "https://staging.example.test/private",
    ]) {
      const capability = evaluateHermesStagingCapabilities({
        ...completeEnv(),
        AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: baseUrl,
      }).find(({ name }) => name === "acceptance_base_url");
      expect(capability).toMatchObject({
        state: "malformed",
        detail: "exact_https_base_url_required",
      });
    }

    const sharedSecret = "shared_authority_abcdefghijklmnopqrstuvwxyz012345";
    for (const envName of [
      "CRON_SECRET",
      "AGENTBAY_RUNNER_BEARER_TOKEN",
      "AGENTBAY_OPERATOR_PASSWORD",
    ] as const) {
      const capability = evaluateHermesStagingCapabilities({
        ...completeEnv(),
        AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: sharedSecret,
        [envName]: sharedSecret,
      }).find(({ name }) => name === "acceptance_bearer_secret");
      expect(capability).toMatchObject({
        state: "malformed",
        detail: "dedicated_bearer_must_be_distinct",
      });
    }
  });

  it("accepts only the exact untagged published Hermes digest repository", () => {
    const [imageCapability] = evaluateHermesStagingCapabilities(completeEnv());
    expect(imageCapability).toMatchObject({
      name: "published_image",
      state: "configured",
    });

    for (const imageRef of [
      "ghcr.io/ametel01/agentbay-hermes:staging@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ghcr.io/ametel01/agentbay-hermes-evil:staging@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ghcr.io/ametel01/agentbay-hermes/other:staging@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ]) {
      const [imageCapability] = evaluateHermesStagingCapabilities({
        ...completeEnv(),
        AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: imageRef,
      });

      expect(imageCapability).toMatchObject({
        name: "published_image",
        state: "malformed",
        detail: "published_ghcr_digest_required",
      });
    }
  });

  it("requires the configured workload to equal the attested release and exact provenance shapes", () => {
    const mismatchedImage = evaluateHermesStagingCapabilities({
      ...completeEnv(),
      AGENTBAY_HERMES_WORKLOAD_IMAGE:
        "ghcr.io/ametel01/agentbay-hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    }).find(({ name }) => name === "configured_workload_image");
    expect(mismatchedImage).toMatchObject({
      state: "malformed",
      detail: "configured_image_must_match_published_image",
    });

    for (const sourceRevision of ["A".repeat(40), "a".repeat(39), ` ${SOURCE_REVISION}`]) {
      expect(
        evaluateHermesStagingCapabilities({
          ...completeEnv(),
          AGENTBAY_HERMES_STAGING_IMAGE_SOURCE_REVISION: sourceRevision,
        }).find(({ name }) => name === "image_source_revision"),
      ).toMatchObject({ state: "malformed", detail: "lowercase_40_hex_revision_required" });
    }

    for (const workflowRunId of ["0", "01", "1.5", "+1", "1".repeat(21), "9007199254740992"]) {
      expect(
        evaluateHermesStagingCapabilities({
          ...completeEnv(),
          AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID: workflowRunId,
        }).find(({ name }) => name === "publish_workflow_run_id"),
      ).toMatchObject({
        state: "malformed",
        detail: "positive_safe_1_to_20_digit_run_id_required",
      });
    }

    for (const workflowRunId of ["1", "9007199254740991"]) {
      expect(
        evaluateHermesStagingCapabilities({
          ...completeEnv(),
          AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID: workflowRunId,
        }).find(({ name }) => name === "publish_workflow_run_id"),
      ).toMatchObject({ state: "configured" });
    }
  });

  it("never prints credentials or Telegram numeric PII in success-shaped preflight output", () => {
    const plan = planHermesStagingVerification(completeEnv());
    const report = serializeHermesStagingPlan(plan);

    expect(plan.code).toBe("ready");
    expect(plan.capabilities.every((capability) => capability.state === "configured")).toBe(true);
    expect(report).toContain('"code": "ready"');
    expect(report).toContain("no side effects have been attempted yet");
    expect(report).toContain('"sideEffectsAttempted": false');

    for (const secret of Object.values(SECRET_VALUES)) {
      expect(report).not.toContain(secret);
    }
  });

  it("fails before the effect seam when capabilities or an interactive TTY are unavailable", async () => {
    const missingWrites: string[] = [];
    const completeWrites: string[] = [];

    expect(
      await runHermesStagingVerification({}, { write: (message) => missingWrites.push(message) }),
    ).toBe(1);
    expect(
      await runHermesStagingVerification(completeEnv(), {
        write: (message) => completeWrites.push(message),
      }),
    ).toBe(1);

    expect(missingWrites.join("")).toContain("capability_unavailable");
    expect(completeWrites.join("")).toContain("interactive_confirmation_unavailable");
    expect(completeWrites.join("")).toContain('"sideEffectsAttempted":false');
  });

  it("drives both explicit human attestations and reports only sanitized final evidence", async () => {
    const runId = "11111111-1111-4111-8111-111111111111";
    const initialChallengeId = "22222222-2222-4222-8222-222222222222";
    const restartChallengeId = "33333333-3333-4333-8333-333333333333";
    const commands: Array<Record<string, unknown>> = [];
    const confirmations: string[] = [];
    const writes: string[] = [];
    const allChecks = Object.fromEntries(
      [
        "imageAttested",
        "deploymentStagesObserved",
        "initialReplyAttested",
        "restartReady",
        "restartImageAttested",
        "postRestartReplyAttested",
        "diagnosticsRedacted",
        "intentionalStopStable",
        "rollbackVerified",
      ].map((key) => [key, true]),
    );
    const cleaned = {
      agent: "absent",
      workload: "absent",
      firewall: "absent",
      droplet: "absent",
      runner: "deleted",
      secretsRevoked: true,
    };
    const makeRun = (overrides: Record<string, unknown>) => ({
      runId,
      phase: "awaiting_initial_human_proof",
      desiredOutcome: "acceptance",
      nextAction: {
        kind: "operator_telegram",
        challengeId: initialChallengeId,
        text: `plingpling Hermes initial acceptance ${initialChallengeId}`,
        purpose: "initial",
        expiresAt: "2030-01-01T00:05:00.000Z",
      },
      checks: allChecks,
      cleanup: cleaned,
      errorCode: null,
      completedAt: null,
      ...overrides,
    });

    const responses = [
      makeRun({}),
      makeRun({
        phase: "restarting",
        nextAction: { kind: "automatic", retryAt: null },
      }),
      makeRun({
        phase: "awaiting_post_restart_human_proof",
        nextAction: {
          kind: "operator_telegram",
          challengeId: restartChallengeId,
          text: `plingpling Hermes post-restart acceptance ${restartChallengeId}`,
          purpose: "post_restart",
          expiresAt: "2030-01-01T00:10:00.000Z",
        },
      }),
      makeRun({
        phase: "checking_rollback",
        nextAction: { kind: "automatic", retryAt: null },
      }),
      makeRun({
        phase: "complete",
        desiredOutcome: "cleanup",
        nextAction: { kind: "none" },
        completedAt: "2030-01-01T00:15:00.000Z",
      }),
    ];
    const remoteAdapter = {
      async command(command: Record<string, unknown>) {
        commands.push(command);
        const run = responses.shift();
        if (!run) throw new Error("unexpected command");
        return { ok: true, run, processed: 1, outcome: "advanced" };
      },
    };

    expect(
      await runHermesStagingVerification(
        completeEnv(),
        { write: (message) => writes.push(message) },
        {
          remoteAdapter,
          isInteractive: true,
          confirmTelegramReply: async ({ challengeText }) => {
            confirmations.push(challengeText);
            return true;
          },
          sleep: async () => {},
          maxIterations: 10,
        },
      ),
    ).toBe(0);

    expect(confirmations).toHaveLength(2);
    expect(commands.map((command) => command.command)).toEqual([
      "begin",
      "attest_telegram_reply",
      "advance",
      "attest_telegram_reply",
      "advance",
    ]);
    expect(writes.join("\n")).toContain("interactive_human_attested");
    expect(writes.join("\n")).not.toContain(runId);
    for (const secret of Object.values(SECRET_VALUES)) {
      expect(writes.join("\n")).not.toContain(secret);
    }
  });

  it("requests and drains durable cleanup when the human attestation is declined", async () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const challengeId = "55555555-5555-4555-8555-555555555555";
    const commands: string[] = [];
    const writes: string[] = [];
    const checks = Object.fromEntries(
      [
        "imageAttested",
        "deploymentStagesObserved",
        "initialReplyAttested",
        "restartReady",
        "restartImageAttested",
        "postRestartReplyAttested",
        "diagnosticsRedacted",
        "intentionalStopStable",
        "rollbackVerified",
      ].map((key) => [key, false]),
    );
    const cleanup = {
      agent: "not_created",
      workload: "not_created",
      firewall: "not_created",
      droplet: "not_created",
      runner: "not_created",
      secretsRevoked: true,
    };
    const responses = [
      {
        runId,
        phase: "awaiting_initial_human_proof",
        desiredOutcome: "acceptance",
        nextAction: {
          kind: "operator_telegram",
          challengeId,
          text: `plingpling Hermes initial acceptance ${challengeId}`,
          purpose: "initial",
          expiresAt: "2030-01-01T00:05:00.000Z",
        },
        checks,
        cleanup,
        errorCode: null,
        completedAt: null,
      },
      {
        runId,
        phase: "complete",
        desiredOutcome: "cleanup",
        nextAction: { kind: "none" },
        checks,
        cleanup,
        errorCode: "acceptance_cancelled",
        completedAt: "2030-01-01T00:06:00.000Z",
      },
    ];
    const remoteAdapter = {
      async command(command: { command: string }) {
        commands.push(command.command);
        return { ok: true, run: responses.shift() };
      },
    };

    expect(
      await runHermesStagingVerification(
        completeEnv(),
        { write: (message) => writes.push(message) },
        {
          remoteAdapter,
          isInteractive: true,
          confirmTelegramReply: async () => false,
          sleep: async () => {},
          maxIterations: 3,
        },
      ),
    ).toBe(1);
    expect(commands).toEqual(["begin", "request_cleanup"]);
    expect(writes.join("\n")).toContain("acceptance_failed_safely");
    expect(writes.join("\n")).not.toContain(runId);
  });

  it("exposes a no-sequence remote command adapter over the dedicated HTTPS bearer port", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const adapter = createHermesStagingRemoteAdapter({
      baseUrl: "https://staging.example.test/",
      bearerSecret: "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345",
      fetchImpl: (async (url, init) => {
        requests.push({ url: String(url), init: init ?? {} });
        return Response.json({ ok: true, run: null });
      }) as typeof fetch,
    });

    await expect(adapter.command({ command: "begin" })).resolves.toEqual({
      ok: true,
      run: null,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://staging.example.test${HERMES_STAGING_ACCEPTANCE_API_PATH}`,
    );
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      redirect: "error",
      cache: "no-store",
      body: '{"command":"begin"}',
    });
    expect(new Headers(requests[0]?.init.headers).get("authorization")).toBe(
      "Bearer staging_acceptance_abcdefghijklmnopqrstuvwxyz012345",
    );
    expect(new Headers(requests[0]?.init.headers).get("content-type")).toBe("application/json");

    await expect(
      adapter.command({ command: "begin", rawReply: "must-not-send" } as never),
    ).rejects.toThrow("remote command is invalid");
    expect(requests).toHaveLength(1);
  });

  it("exposes the package entrypoint as a fail-closed no-capability command", () => {
    const result = spawnSync("bun", ["run", "verify:hermes:staging"], {
      cwd: process.cwd(),
      env: noCapabilityProcessEnv(),
      encoding: "utf8",
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).toBe(1);
    expect(output).toContain("capability_unavailable");
    expect(output).toContain("sideEffectsAttempted");
    expect(output).not.toContain(SECRET_VALUES.openAiKey);

    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["verify:hermes:staging"]).toBe(
      "bun scripts/verify-hermes-staging.ts",
    );
  });
});
