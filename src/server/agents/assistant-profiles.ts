import "server-only";

export const ASSISTANT_CHOICES = ["chatgpt", "claude"] as const;

export type AssistantChoice = (typeof ASSISTANT_CHOICES)[number];
export type DirectHermesModelProvider = "openai-api" | "anthropic";
export type DirectModelSecretKind = "openai_api_key" | "anthropic_api_key";

export type AssistantProfile = {
  assistant: AssistantChoice;
  displayName: "ChatGPT" | "Claude";
  credentialLabel: "OpenAI API key" | "Anthropic API key";
  credentialHelpUrl: string;
  credentialBillingNote: string;
  hermesProvider: DirectHermesModelProvider;
  model: string;
  modelDisplayName: string;
  contextTokens: number;
  secretKind: DirectModelSecretKind;
  environmentKey: "OPENAI_API_KEY" | "ANTHROPIC_API_KEY";
};

const ASSISTANT_PROFILES = {
  chatgpt: {
    assistant: "chatgpt",
    displayName: "ChatGPT",
    credentialLabel: "OpenAI API key",
    credentialHelpUrl: "https://platform.openai.com/api-keys",
    credentialBillingNote: "OpenAI API usage is billed separately from a ChatGPT subscription.",
    hermesProvider: "openai-api",
    model: "gpt-5.4",
    modelDisplayName: "GPT-5.4",
    contextTokens: 1_050_000,
    secretKind: "openai_api_key",
    environmentKey: "OPENAI_API_KEY",
  },
  claude: {
    assistant: "claude",
    displayName: "Claude",
    credentialLabel: "Anthropic API key",
    credentialHelpUrl: "https://console.anthropic.com/settings/keys",
    credentialBillingNote: "Anthropic API usage is billed separately from a Claude subscription.",
    hermesProvider: "anthropic",
    model: "claude-sonnet-4-6",
    modelDisplayName: "Claude Sonnet 4.6",
    contextTokens: 1_000_000,
    secretKind: "anthropic_api_key",
    environmentKey: "ANTHROPIC_API_KEY",
  },
} as const satisfies Record<AssistantChoice, AssistantProfile>;

export function isAssistantChoice(value: unknown): value is AssistantChoice {
  return typeof value === "string" && ASSISTANT_CHOICES.includes(value as AssistantChoice);
}

export function getAssistantProfile(choice: AssistantChoice): AssistantProfile {
  return ASSISTANT_PROFILES[choice];
}

export function getAssistantProfileForManagedModel(
  provider: string,
  model: string,
): AssistantProfile | null {
  return (
    Object.values(ASSISTANT_PROFILES).find(
      (profile) => profile.hermesProvider === provider && profile.model === model,
    ) ?? null
  );
}

export function validateAssistantApiKey(
  profile: AssistantProfile,
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string") {
    return { ok: false };
  }

  const normalized = value.trim();
  const validShape =
    profile.assistant === "chatgpt"
      ? /^sk-(?!ant-|or-v1-)[A-Za-z0-9_-]{20,}$/.test(normalized)
      : /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(normalized);

  if (
    !validShape ||
    Buffer.byteLength(normalized, "utf8") > 512 ||
    hasControlCharacter(normalized)
  ) {
    return { ok: false };
  }

  return { ok: true, value: normalized };
}

export function isManagedDirectModel(provider: string, model: string): boolean {
  return getAssistantProfileForManagedModel(provider, model) !== null;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}
