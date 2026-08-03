import "server-only";

export const HERMES_MINIMUM_CONTEXT_TOKENS = 32_768;

export type OpenRouterModelMetadata = {
  id: string;
  provider: "openrouter";
  displayName: string;
  contextTokens: number;
  enabled: boolean;
};

export const APPROVED_OPENROUTER_MODELS = [
  {
    id: "openai/gpt-4.1-mini",
    provider: "openrouter",
    displayName: "GPT-4.1 Mini",
    contextTokens: 1_047_576,
    enabled: true,
  },
] as const satisfies readonly OpenRouterModelMetadata[];

export type ApprovedOpenRouterModelId = (typeof APPROVED_OPENROUTER_MODELS)[number]["id"];

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function getApprovedOpenRouterModel(
  modelId: string,
  registry: readonly OpenRouterModelMetadata[] = APPROVED_OPENROUTER_MODELS,
): OpenRouterModelMetadata | null {
  if (!isSafeOpenRouterModelId(modelId)) {
    return null;
  }

  const model = registry.find((candidate) => candidate.id === modelId);

  if (
    !model?.enabled ||
    model.provider !== "openrouter" ||
    model.id.endsWith("/not_configured") ||
    model.contextTokens < HERMES_MINIMUM_CONTEXT_TOKENS
  ) {
    return null;
  }

  return model;
}

export function isSafeOpenRouterModelId(modelId: string): boolean {
  return MODEL_ID_PATTERN.test(modelId);
}
