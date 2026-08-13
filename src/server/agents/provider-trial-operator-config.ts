import "server-only";

import { parseRunnerReleaseBundle } from "@/src/runner-service/release-attestation";
import { captureAgentDeploymentChoicesFromEnvironment } from "@/src/server/agents/agent-deployment-choices";
import { fingerprintTelegramBotTokenForUniqueness } from "@/src/server/agents/agent-secrets";
import {
  type AssistantChoice,
  getAssistantProfile,
  isAssistantChoice,
  validateAssistantApiKey,
} from "@/src/server/agents/assistant-profiles";
import { CURRENT_ROLLOUT_CONFIGURATION_GENERATION } from "@/src/server/agents/deployment-slo-identity";
import {
  providerTrialBenchmarkTelegramIdentityHash,
  providerTrialDeploymentChoicesDigest,
} from "@/src/server/agents/provider-trial-driver";

export const PROVIDER_TRIAL_AUTHORIZATION = {
  id: "issue-299-20260813-g4",
  generation: 4,
} as const;

export const PROVIDER_TRIAL_APPROVED_SCOPE = {
  region: "sfo3",
  runnerSizeSlug: "s-1vcpu-2gb",
  maxSpendCents: 500,
  maxSlotCostCents: 16,
  maxProviderResources: 1,
  perSlotTimeoutMs: 15 * 60 * 1_000,
  cleanupTimeoutMs: 5 * 60 * 1_000,
  evidenceRetentionDays: 90,
} as const;

export const PROVIDER_TRIAL_LIVE_CONFIRMATION = "authorize-issue-299-live-provider-trial";

const REQUIRED_GROUPS = [
  ["authorization_id", ["BRUNO_PROVIDER_TRIAL_AUTHORIZATION_ID"]],
  ["authorization_generation", ["BRUNO_PROVIDER_TRIAL_AUTHORIZATION_GENERATION"]],
  ["cohort_key", ["BRUNO_PROVIDER_TRIAL_COHORT_KEY"]],
  ["live_confirmation", ["BRUNO_PROVIDER_TRIAL_LIVE_SIDE_EFFECT_CONFIRMATION"]],
  ["digitalocean_token", ["BRUNO_DIGITALOCEAN_TOKEN"]],
  [
    "deployment_choices",
    [
      "BRUNO_DIGITALOCEAN_PROVIDER_MODE",
      "BRUNO_DIGITALOCEAN_REGION",
      "BRUNO_DIGITALOCEAN_SIZE_SLUG",
      "BRUNO_RUNNER_IMAGE",
      "BRUNO_RUNNER_BEARER_TOKEN",
      "BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION",
      "BRUNO_AGENT_SECRET_KEYS_JSON",
    ],
  ],
  ["model_fixture", ["BRUNO_PROVIDER_TRIAL_ASSISTANT", "BRUNO_PROVIDER_TRIAL_MODEL_API_KEY"]],
  [
    "signing_key",
    ["BRUNO_PROVIDER_TRIAL_SIGNING_KEY_ID", "BRUNO_PROVIDER_TRIAL_SIGNING_PRIVATE_KEY_PATH"],
  ],
  ["prerequisite_gates", ["BRUNO_PROVIDER_TRIAL_GATE_EVIDENCE_PATH"]],
  ["credential_cleanup", ["BRUNO_PROVIDER_TRIAL_CREDENTIAL_FILE_PATH"]],
  [
    "telegram_fixture",
    [
      "BRUNO_PROVIDER_TRIAL_TELEGRAM_BOT_TOKEN",
      "BRUNO_PROVIDER_TRIAL_TELEGRAM_USER_ID",
      "BRUNO_PROVIDER_TRIAL_TELEGRAM_CHAT_ID",
    ],
  ],
] as const;

export type ProviderTrialPreflightIssue =
  | (typeof REQUIRED_GROUPS)[number][0]
  | "approved_scope"
  | "invalid_configuration";

export type ProviderTrialOperatorConfiguration = {
  authorization: typeof PROVIDER_TRIAL_AUTHORIZATION;
  cohortKey: string;
  fixture: {
    assistant: AssistantChoice;
    modelApiKey: string;
    telegramBotToken: string;
    telegramUserId: string;
    telegramChatId: string;
  };
  deploymentChoicesDigest: string;
  releaseBundleDigest: string;
  releaseSourceRevision: string;
  benchmarkTelegramIdentityHash: string;
  signing: { keyId: string; privateKeyPath: string };
  gateEvidencePath: string;
  credentialFilePath: string;
};

type ProviderTrialGateEvidenceBinding = {
  digest: string;
  identities: {
    digitalOceanAccount: string;
    telegramBot: string;
    telegramChat: string;
    telegramUser: string;
  };
};

export function matchesProviderTrialGateEvidence(
  value: unknown,
  gateEvidence: ProviderTrialGateEvidenceBinding,
  mode: "exact" | "renewed_authorization",
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const configuration = value as Record<string, unknown>;
  const identitiesMatch =
    configuration.digitalOceanAccountIdentityHash === gateEvidence.identities.digitalOceanAccount &&
    configuration.telegramBotIdentityHash === gateEvidence.identities.telegramBot &&
    configuration.telegramChatIdentityHash === gateEvidence.identities.telegramChat &&
    configuration.telegramUserIdentityHash === gateEvidence.identities.telegramUser;
  if (!identitiesMatch) return false;
  return (
    configuration.prerequisiteGateEvidenceDigest === gateEvidence.digest ||
    mode === "renewed_authorization"
  );
}

export function listProviderTrialPreflightIssues(
  env: Readonly<Record<string, string | undefined>>,
): ProviderTrialPreflightIssue[] {
  const missing = REQUIRED_GROUPS.flatMap(([issue, names]) =>
    names.every((name) => Boolean(env[name])) ? [] : [issue],
  );
  if (missing.length > 0) return missing;

  if (
    !(
      env.BRUNO_PROVIDER_TRIAL_AUTHORIZATION_ID === PROVIDER_TRIAL_AUTHORIZATION.id &&
      env.BRUNO_PROVIDER_TRIAL_AUTHORIZATION_GENERATION ===
        String(PROVIDER_TRIAL_AUTHORIZATION.generation) &&
      env.BRUNO_DIGITALOCEAN_PROVIDER_MODE === "digitalocean" &&
      env.BRUNO_DIGITALOCEAN_REGION === PROVIDER_TRIAL_APPROVED_SCOPE.region &&
      env.BRUNO_DIGITALOCEAN_SIZE_SLUG === PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug
    )
  ) {
    return ["approved_scope"];
  }

  return parseProviderTrialOperatorConfiguration(env) ? [] : ["invalid_configuration"];
}

export function parseProviderTrialOperatorConfiguration(
  env: Readonly<Record<string, string | undefined>>,
): ProviderTrialOperatorConfiguration | null {
  const cohortKey = env.BRUNO_PROVIDER_TRIAL_COHORT_KEY;
  const assistant = env.BRUNO_PROVIDER_TRIAL_ASSISTANT;
  const modelApiKey = env.BRUNO_PROVIDER_TRIAL_MODEL_API_KEY;
  const telegramBotToken = env.BRUNO_PROVIDER_TRIAL_TELEGRAM_BOT_TOKEN;
  const telegramUserId = env.BRUNO_PROVIDER_TRIAL_TELEGRAM_USER_ID;
  const telegramChatId = env.BRUNO_PROVIDER_TRIAL_TELEGRAM_CHAT_ID;
  const keyId = env.BRUNO_PROVIDER_TRIAL_SIGNING_KEY_ID;
  const privateKeyPath = env.BRUNO_PROVIDER_TRIAL_SIGNING_PRIVATE_KEY_PATH;
  const gateEvidencePath = env.BRUNO_PROVIDER_TRIAL_GATE_EVIDENCE_PATH;
  const credentialFilePath = env.BRUNO_PROVIDER_TRIAL_CREDENTIAL_FILE_PATH;
  if (
    env.BRUNO_PROVIDER_TRIAL_AUTHORIZATION_ID !== PROVIDER_TRIAL_AUTHORIZATION.id ||
    env.BRUNO_PROVIDER_TRIAL_AUTHORIZATION_GENERATION !==
      String(PROVIDER_TRIAL_AUTHORIZATION.generation) ||
    env.BRUNO_PROVIDER_TRIAL_LIVE_SIDE_EFFECT_CONFIRMATION !== PROVIDER_TRIAL_LIVE_CONFIRMATION ||
    !cohortKey ||
    !/^[a-z0-9][a-z0-9._:-]{7,127}$/.test(cohortKey) ||
    !isAssistantChoice(assistant) ||
    !modelApiKey ||
    !validateAssistantApiKey(getAssistantProfile(assistant), modelApiKey).ok ||
    !telegramBotToken ||
    !/^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{20,}$/.test(telegramBotToken) ||
    !telegramUserId ||
    !/^[1-9][0-9]{0,19}$/.test(telegramUserId) ||
    !telegramChatId ||
    !/^-?[1-9][0-9]{0,19}$/.test(telegramChatId) ||
    !keyId ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(keyId) ||
    !privateKeyPath ||
    !gateEvidencePath ||
    !credentialFilePath ||
    !env.BRUNO_DIGITALOCEAN_TOKEN ||
    env.BRUNO_DIGITALOCEAN_TOKEN.length < 32 ||
    env.BRUNO_DIGITALOCEAN_TAGS?.split(",").includes("bruno-provider-trial") !== true
  ) {
    return null;
  }

  try {
    const choices = captureAgentDeploymentChoicesFromEnvironment(
      env as Record<string, string | undefined>,
      CURRENT_ROLLOUT_CONFIGURATION_GENERATION,
    );
    if (
      choices.provider.mode !== "digitalocean" ||
      choices.provider.region !== PROVIDER_TRIAL_APPROVED_SCOPE.region ||
      choices.provider.sizeSlug !== PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug ||
      choices.validation.mode !== "release_attested"
    ) {
      return null;
    }
    const release = parseRunnerReleaseBundle(env.BRUNO_RUNNER_RELEASE_BUNDLE ?? "");
    if (!release.ok || release.digest !== choices.validation.releaseBundleDigest) return null;
    return {
      authorization: PROVIDER_TRIAL_AUTHORIZATION,
      cohortKey,
      fixture: {
        assistant,
        modelApiKey,
        telegramBotToken,
        telegramUserId,
        telegramChatId,
      },
      deploymentChoicesDigest: providerTrialDeploymentChoicesDigest(choices),
      releaseBundleDigest: release.digest,
      releaseSourceRevision: release.bundle.manifest.controlPlane.source.revision,
      benchmarkTelegramIdentityHash: providerTrialBenchmarkTelegramIdentityHash(
        fingerprintTelegramBotTokenForUniqueness(telegramBotToken),
      ),
      signing: { keyId, privateKeyPath },
      gateEvidencePath,
      credentialFilePath,
    };
  } catch {
    return null;
  }
}
