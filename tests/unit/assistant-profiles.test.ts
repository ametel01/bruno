import { describe, expect, it } from "vitest";
import {
  getAssistantProfile,
  getAssistantProfileForManagedModel,
  isAssistantChoice,
  validateAssistantApiKey,
} from "@/src/server/agents/assistant-profiles";

describe("assistant profiles", () => {
  it("exposes only ChatGPT and Claude with server-owned Hermes bindings", () => {
    expect(isAssistantChoice("chatgpt")).toBe(true);
    expect(isAssistantChoice("claude")).toBe(true);
    expect(isAssistantChoice("openrouter")).toBe(false);

    expect(getAssistantProfile("chatgpt")).toMatchObject({
      displayName: "ChatGPT",
      hermesProvider: "openai-api",
      secretKind: "openai_api_key",
      environmentKey: "OPENAI_API_KEY",
    });
    expect(getAssistantProfile("claude")).toMatchObject({
      displayName: "Claude",
      hermesProvider: "anthropic",
      secretKind: "anthropic_api_key",
      environmentKey: "ANTHROPIC_API_KEY",
    });
  });

  it("resolves only the exact pinned provider and model pair", () => {
    const chatgpt = getAssistantProfile("chatgpt");

    expect(getAssistantProfileForManagedModel(chatgpt.hermesProvider, chatgpt.model)).toEqual(
      chatgpt,
    );
    expect(getAssistantProfileForManagedModel(chatgpt.hermesProvider, "client-model")).toBeNull();
    expect(getAssistantProfileForManagedModel("openrouter", chatgpt.model)).toBeNull();
  });

  it("validates each provider credential without accepting the other provider or OpenRouter", () => {
    const openAiKey = `sk-${"a".repeat(32)}`;
    const anthropicKey = `sk-ant-${"b".repeat(32)}`;
    const openRouterKey = `sk-or-v1-${"c".repeat(32)}`;

    expect(validateAssistantApiKey(getAssistantProfile("chatgpt"), openAiKey)).toEqual({
      ok: true,
      value: openAiKey,
    });
    expect(validateAssistantApiKey(getAssistantProfile("chatgpt"), anthropicKey)).toEqual({
      ok: false,
    });
    expect(validateAssistantApiKey(getAssistantProfile("chatgpt"), openRouterKey)).toEqual({
      ok: false,
    });
    expect(validateAssistantApiKey(getAssistantProfile("claude"), anthropicKey)).toEqual({
      ok: true,
      value: anthropicKey,
    });
    expect(validateAssistantApiKey(getAssistantProfile("claude"), openAiKey)).toEqual({
      ok: false,
    });
  });
});
