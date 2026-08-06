import { parseCanonicalTelegramAllowlist } from "@/src/shared/telegram-allowlist";

export type AssistantChoice = "chatgpt" | "claude";

export type ModelConnectionOption = {
  assistant: AssistantChoice;
  displayName: "ChatGPT" | "Claude";
  credentialLabel: "OpenAI API key" | "Anthropic API key";
  credentialHelpUrl: string;
  credentialBillingNote: string;
  status: "connected" | "action_required";
};

export type FieldName =
  | "name"
  | "assistant"
  | "modelApiKey"
  | "telegramBotToken"
  | "telegramAllowedUserIds";

export type ReadyEnvelope = {
  name: string;
  assistant: AssistantChoice;
};

export type LogicalSubmission = {
  idempotencyKey: string;
  envelope: ReadyEnvelope;
  envelopeLocked: boolean;
};

export const READY_SECRET_FIELD_NAMES = [
  "modelApiKey",
  "telegramBotToken",
  "telegramAllowedUserIds",
] as const;

const DEFAULT_TEMPLATE_KEY = "research_agent";

export type ReadyCreateFormSnapshot = {
  name: string;
  assistant: AssistantChoice;
  modelApiKey: string;
  telegramBotToken: string;
  telegramAllowedUserIds: string;
};

export type ReadyCreateRequestResult =
  | {
      ok: true;
      payload: {
        name: string;
        templateKey: typeof DEFAULT_TEMPLATE_KEY;
        runnerId: null;
        launchMode: "ready";
        idempotencyKey: string;
        assistant: AssistantChoice;
        modelApiKey?: string;
        telegramBotToken: string;
        telegramAllowedUserIds: string[];
      };
      nextSubmission: LogicalSubmission;
      credentialFieldNames: typeof READY_SECRET_FIELD_NAMES;
    }
  | { ok: false; message: string; field: FieldName };

export function buildReadyCreateRequest(input: {
  availableConnections: ModelConnectionOption[];
  createIdempotencyKey: () => string;
  currentSubmission: LogicalSubmission | null;
  form: ReadyCreateFormSnapshot;
  maxNameLength: number;
  readyModeEnabled: boolean;
}): ReadyCreateRequestResult {
  if (!input.readyModeEnabled || input.availableConnections.length === 0) {
    return { ok: false, message: "Automatic setup is unavailable.", field: "assistant" };
  }

  let envelope: ReadyEnvelope;
  if (input.currentSubmission?.envelopeLocked) {
    envelope = input.currentSubmission.envelope;
  } else {
    const name = input.form.name.trim();
    if (!name) return { ok: false, message: "Name is required.", field: "name" };
    if (name.length > input.maxNameLength) {
      return {
        ok: false,
        message: `Name must be ${input.maxNameLength} characters or fewer.`,
        field: "name",
      };
    }
    if (!input.availableConnections.some((item) => item.assistant === input.form.assistant)) {
      return { ok: false, message: "Choose ChatGPT or Claude.", field: "assistant" };
    }
    envelope = { name, assistant: input.form.assistant };
  }

  const connection = input.availableConnections.find(
    (item) => item.assistant === envelope.assistant,
  );
  const modelApiKey = input.form.modelApiKey.trim();
  if (connection?.status !== "connected" && !modelApiKey) {
    return {
      ok: false,
      message: `${connection?.credentialLabel ?? "API key"} is required.`,
      field: "modelApiKey",
    };
  }

  const telegramBotToken = input.form.telegramBotToken.trim();
  if (!telegramBotToken) {
    return { ok: false, message: "Telegram bot token is required.", field: "telegramBotToken" };
  }

  const allowlist = parseTelegramAllowlistInput(input.form.telegramAllowedUserIds);
  if (!allowlist.ok) return allowlist;

  const idempotencyKey =
    input.currentSubmission?.idempotencyKey ?? input.createIdempotencyKey().toLowerCase();
  const nextSubmission = {
    idempotencyKey,
    envelope,
    envelopeLocked: input.currentSubmission?.envelopeLocked ?? false,
  };

  return {
    ok: true,
    credentialFieldNames: READY_SECRET_FIELD_NAMES,
    nextSubmission,
    payload: {
      name: envelope.name,
      templateKey: DEFAULT_TEMPLATE_KEY,
      runnerId: null,
      launchMode: "ready",
      idempotencyKey,
      assistant: envelope.assistant,
      ...(modelApiKey ? { modelApiKey } : {}),
      telegramBotToken,
      telegramAllowedUserIds: allowlist.values,
    },
  };
}

function parseTelegramAllowlistInput(
  value: string,
):
  | { ok: true; values: string[] }
  | { ok: false; message: string; field: "telegramAllowedUserIds" } {
  const result = parseCanonicalTelegramAllowlist(value);
  if (result.ok) return result;
  return {
    ok: false,
    field: "telegramAllowedUserIds",
    message:
      result.reason === "empty" || result.reason === "too_many"
        ? "Enter one to 100 Telegram user IDs."
        : "Telegram user IDs must be canonical decimal strings.",
  };
}
