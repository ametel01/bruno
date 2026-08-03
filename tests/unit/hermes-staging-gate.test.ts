import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL,
  HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL,
  evaluateHermesStagingCapabilities,
  planHermesStagingVerification,
  runHermesStagingVerification,
  serializeHermesStagingPlan,
} from "@/scripts/verify-hermes-staging";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";

const SAFE_PUBLISHED_IMAGE =
  "ghcr.io/ametel01/agentbay-hermes:staging@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SAFE_UNTAGGED_PUBLISHED_IMAGE =
  "ghcr.io/ametel01/agentbay-hermes@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const SECRET_VALUES = {
  digitalOceanToken: `dop_v1_${"a".repeat(64)}`,
  runnerBearerToken: "agb_run_secret1234567890123456789012345678901234567890123",
  openRouterKey: "sk-or-v1-secret12345678901234567890",
  telegramToken: "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
  telegramUserId: "123456789",
  telegramChatId: "-1001234567890",
};

function completeEnv(): Record<string, string | undefined> {
  return {
    AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: SAFE_PUBLISHED_IMAGE,
    AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION:
      HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL,
    AGENTBAY_DIGITALOCEAN_TOKEN: SECRET_VALUES.digitalOceanToken,
    AGENTBAY_RUNNER_BEARER_TOKEN: SECRET_VALUES.runnerBearerToken,
    AGENTBAY_HERMES_STAGING_OPENROUTER_API_KEY: SECRET_VALUES.openRouterKey,
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
    expect(plan.capabilities).toHaveLength(9);
    expect(plan.capabilities.every((capability) => capability.state === "missing")).toBe(true);
    expect(report).toContain('"sideEffectsAttempted": false');
    expect(report).toContain("AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF");
    expect(report).not.toContain("process.env");
  });

  it("fails blank, placeholder, malformed, tag-only, and source-pinned inputs closed", () => {
    const malformedEnv = {
      ...completeEnv(),
      AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: "ghcr.io/ametel01/agentbay-hermes:staging",
      AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION: "true",
      AGENTBAY_DIGITALOCEAN_TOKEN: "replace-with-digitalocean-token",
      AGENTBAY_RUNNER_BEARER_TOKEN: "runner credential with spaces",
      AGENTBAY_HERMES_STAGING_OPENROUTER_API_KEY: " ",
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
    ]);
    expect(capabilities.map((capability) => capability.detail)).toEqual([
      "published_ghcr_digest_required",
      "exact_sentinel_required",
      "placeholder",
      "credential_without_whitespace_required",
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
        AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: `ghcr.io/ametel01/agentbay-hermes:staging@${digest}`,
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

    expect(capabilities[1]).toMatchObject({
      name: "digitalocean_budget_authorization",
      state: "malformed",
      detail: "exact_sentinel_required",
    });
    expect(capabilities[8]).toMatchObject({
      name: "live_side_effect_confirmation",
      state: "malformed",
      detail: "exact_sentinel_required",
    });
  });

  it("accepts only the exact published Hermes image repository with an optional tag", () => {
    for (const imageRef of [SAFE_PUBLISHED_IMAGE, SAFE_UNTAGGED_PUBLISHED_IMAGE]) {
      const [imageCapability] = evaluateHermesStagingCapabilities({
        ...completeEnv(),
        AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF: imageRef,
      });

      expect(imageCapability).toMatchObject({
        name: "published_image",
        state: "configured",
      });
    }

    for (const imageRef of [
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

  it("never prints credentials or Telegram numeric PII in success-shaped preflight output", () => {
    const plan = planHermesStagingVerification(completeEnv());
    const report = serializeHermesStagingPlan(plan);

    expect(plan.code).toBe("live_executor_unavailable");
    expect(plan.capabilities.every((capability) => capability.state === "configured")).toBe(true);
    expect(report).toContain("live_executor_unavailable");
    expect(report).toContain("no side effects were attempted");
    expect(report).toContain('"sideEffectsAttempted": false');

    for (const secret of Object.values(SECRET_VALUES)) {
      expect(report).not.toContain(secret);
    }
  });

  it("does not invoke an effect seam and returns nonzero for rejected and complete capability sets", () => {
    const missingWrites: string[] = [];
    const completeWrites: string[] = [];

    expect(
      runHermesStagingVerification({}, { write: (message) => missingWrites.push(message) }),
    ).toBe(1);
    expect(
      runHermesStagingVerification(completeEnv(), {
        write: (message) => completeWrites.push(message),
      }),
    ).toBe(1);

    expect(missingWrites.join("")).toContain("capability_unavailable");
    expect(completeWrites.join("")).toContain("live_executor_unavailable");
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
    expect(output).not.toContain(SECRET_VALUES.openRouterKey);

    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts["verify:hermes:staging"]).toBe(
      "bun scripts/verify-hermes-staging.ts",
    );
  });
});
