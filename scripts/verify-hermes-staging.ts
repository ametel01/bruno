import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
} from "@/src/runner-service/constants";

export const HERMES_STAGING_DIGITALOCEAN_BUDGET_SENTINEL =
  "authorize-basic-4usd-digitalocean-staging";
export const HERMES_STAGING_LIVE_SIDE_EFFECT_SENTINEL =
  "send-telegram-and-spend-digitalocean-staging";

export type HermesStagingCapabilityState = "configured" | "missing" | "malformed";

export type HermesStagingCapabilityName =
  | "published_image"
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
      ok: false;
      code: "live_executor_unavailable";
      capabilities: HermesStagingCapability[];
    };

type CapabilitySpec = {
  name: HermesStagingCapabilityName;
  envName: string;
  validate: (value: string) => string | null;
};

const PLACEHOLDER_PATTERN = /^(?:replace-|example|placeholder|test-|changeme|todo|xxx)/i;
const IMAGE_DIGEST_PATTERN =
  /^ghcr\.io\/ametel01\/agentbay-hermes(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?@sha256:[a-f0-9]{64}$/;

const CAPABILITY_SPECS: CapabilitySpec[] = [
  {
    name: "published_image",
    envName: "AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF",
    validate: validatePublishedImage,
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
    ok: false,
    code: "live_executor_unavailable",
    capabilities,
  };
}

export function serializeHermesStagingPlan(plan: HermesStagingPlan): string {
  return JSON.stringify(
    {
      ok: plan.ok,
      code: plan.code,
      message:
        plan.code === "live_executor_unavailable"
          ? "Hermes staging live executor is not implemented in Step 1; no side effects were attempted."
          : "Hermes staging capability preflight failed closed; no side effects were attempted.",
      capabilities: plan.capabilities,
      sideEffectsAttempted: false,
    },
    null,
    2,
  );
}

export function runHermesStagingVerification(
  env: Record<string, string | undefined> = process.env,
  output: { write: (message: string) => void } = { write: (message) => console.error(message) },
): number {
  const plan = planHermesStagingVerification(env);

  output.write(`${serializeHermesStagingPlan(plan)}\n`);

  return 1;
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
  process.exitCode = runHermesStagingVerification();
}
