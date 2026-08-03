import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  APPROVED_OPENROUTER_MODELS,
  HERMES_MINIMUM_CONTEXT_TOKENS,
  getApprovedOpenRouterModel,
  isSafeOpenRouterModelId,
  type OpenRouterModelMetadata,
} from "@/src/server/agents/openrouter-models";

describe("approved OpenRouter model catalog", () => {
  it("exposes exactly the approved Hermes-ready OpenRouter model", () => {
    expect(HERMES_MINIMUM_CONTEXT_TOKENS).toBe(32_768);
    expect(APPROVED_OPENROUTER_MODELS).toEqual([
      {
        id: "openai/gpt-4.1-mini",
        provider: "openrouter",
        displayName: "GPT-4.1 Mini",
        contextTokens: 1_047_576,
        enabled: true,
      },
    ]);
    expect(getApprovedOpenRouterModel("openai/gpt-4.1-mini")).toEqual(
      APPROVED_OPENROUTER_MODELS[0],
    );
  });

  it("rejects unsafe, disabled, wrong-provider, not-configured, and undersized entries", () => {
    const registry: OpenRouterModelMetadata[] = [
      {
        id: "openai/disabled",
        provider: "openrouter",
        displayName: "Disabled",
        contextTokens: 1_047_576,
        enabled: false,
      },
      {
        id: "openai/not_configured",
        provider: "openrouter",
        displayName: "Not Configured",
        contextTokens: 1_047_576,
        enabled: true,
      },
      {
        id: "openai/tiny",
        provider: "openrouter",
        displayName: "Tiny",
        contextTokens: HERMES_MINIMUM_CONTEXT_TOKENS - 1,
        enabled: true,
      },
    ];
    const forgedWrongProvider = [
      {
        id: "openai/wrong-provider",
        provider: "other",
        displayName: "Wrong Provider",
        contextTokens: 1_047_576,
        enabled: true,
      },
    ] as unknown as OpenRouterModelMetadata[];

    expect(getApprovedOpenRouterModel("openai/disabled", registry)).toBeNull();
    expect(getApprovedOpenRouterModel("openai/not_configured", registry)).toBeNull();
    expect(getApprovedOpenRouterModel("openai/tiny", registry)).toBeNull();
    expect(getApprovedOpenRouterModel("openai/wrong-provider", forgedWrongProvider)).toBeNull();
    expect(isSafeOpenRouterModelId("openai/gpt-4.1-mini")).toBe(true);
    expect(isSafeOpenRouterModelId("openai/gpt 4.1")).toBe(false);
    expect(isSafeOpenRouterModelId("../openai/gpt-4.1-mini")).toBe(false);
    expect(isSafeOpenRouterModelId("openai/gpt-4.1-mini?context=1")).toBe(false);
  });

  it("keeps the approved model registry server-owned", async () => {
    const source = await readFile("src/server/agents/openrouter-models.ts", "utf8");
    const sharedFiles = await readdir("src/shared");

    expect(source).toContain("export const APPROVED_OPENROUTER_MODELS");
    expect(source).not.toContain("@/src/shared/openrouter-model-registry");
    expect(sharedFiles).not.toContain("openrouter-model-registry.ts");
  });
});
