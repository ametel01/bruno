import { describe, expect, it, vi } from "vitest";
import {
  buildReadyCreateRequest,
  READY_SECRET_FIELD_NAMES,
  type LogicalSubmission,
  type ModelConnectionOption,
} from "@/app/agents/_components/create-agent-form-controller";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

const CONNECTIONS: ModelConnectionOption[] = [
  {
    assistant: "chatgpt",
    displayName: "ChatGPT",
    credentialLabel: "OpenAI API key",
    credentialHelpUrl: "https://platform.openai.com/api-keys",
    credentialBillingNote: "OpenAI API usage is billed separately.",
    status: "action_required",
  },
  {
    assistant: "claude",
    displayName: "Claude",
    credentialLabel: "Anthropic API key",
    credentialHelpUrl: "https://console.anthropic.com/settings/keys",
    credentialBillingNote: "Anthropic API usage is billed separately.",
    status: "connected",
  },
];

describe("create agent form controller", () => {
  it("builds the server-owned ChatGPT setup payload without technical choices", () => {
    const result = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "CREATE-KEY-1",
      currentSubmission: null,
      form: readyForm(),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.payload).toEqual({
      assistant: "chatgpt",
      idempotencyKey: "create-key-1",
      launchMode: "ready",
      modelApiKey: "sk-openai-secret-key-1234567890",
      name: "Research Agent",
      runnerId: null,
      telegramAllowedUserIds: ["123", "456"],
      telegramBotToken: "123:telegram-secret",
      templateKey: "research_agent",
    });
    expect(JSON.stringify(result.payload)).not.toContain("provider");
    expect(JSON.stringify(result.payload)).not.toContain("modelName");
  });

  it("omits the API key when the selected assistant is already connected", () => {
    const result = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "CREATE-KEY-2",
      currentSubmission: null,
      form: readyForm({ assistant: "claude", modelApiKey: "" }),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.assistant).toBe("claude");
    expect(result.payload).not.toHaveProperty("modelApiKey");
  });

  it("requires a key only for an assistant that is not connected", () => {
    const result = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "CREATE-KEY-3",
      currentSubmission: null,
      form: readyForm({ modelApiKey: "" }),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(result).toEqual({
      ok: false,
      message: "OpenAI API key is required.",
      field: "modelApiKey",
    });
  });

  it("keeps one idempotency key and immutable public choices across ambiguous retries", () => {
    const first = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "KEY-A",
      currentSubmission: null,
      form: readyForm(),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const ambiguous: LogicalSubmission = { ...first.nextSubmission, envelopeLocked: true };
    const retry = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "KEY-B",
      currentSubmission: ambiguous,
      form: readyForm({ assistant: "claude", name: "Edited Agent" }),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(retry.ok).toBe(true);
    if (!retry.ok) return;
    expect(retry.payload.idempotencyKey).toBe("key-a");
    expect(retry.payload.name).toBe("Research Agent");
    expect(retry.payload.assistant).toBe("chatgpt");
  });

  it("keeps all secrets out of the logical submission seam", () => {
    const result = buildReadyCreateRequest({
      availableConnections: CONNECTIONS,
      createIdempotencyKey: () => "KEY-A",
      currentSubmission: null,
      form: readyForm(),
      maxNameLength: 80,
      readyModeEnabled: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.credentialFieldNames).toBe(READY_SECRET_FIELD_NAMES);
    expect(JSON.stringify(result.nextSubmission)).not.toContain("secret");
    expect(JSON.stringify(result.nextSubmission)).not.toContain("123");
  });
});

function readyForm(
  overrides: Partial<Parameters<typeof buildReadyCreateRequest>[0]["form"]> = {},
): Parameters<typeof buildReadyCreateRequest>[0]["form"] {
  return {
    name: "Research Agent",
    assistant: "chatgpt",
    modelApiKey: "sk-openai-secret-key-1234567890",
    telegramAllowedUserIds: "123\n456\n123",
    telegramBotToken: "123:telegram-secret",
    ...overrides,
  };
}
