import "server-only";

export type TelegramBotMetadata = {
  botId: string;
  username: string | null;
};

export type TelegramBotValidationResult =
  | {
      ok: true;
      bot: TelegramBotMetadata;
    }
  | {
      ok: false;
      reason:
        | "invalid_bot_token"
        | "telegram_validation_timeout"
        | "telegram_validation_unavailable"
        | "telegram_validation_invalid_response";
    };

export type TelegramWebhookDiagnosticResult = "empty" | "nonempty" | "uncertain";

export type TelegramClientDependencies = {
  fetch?: typeof fetch;
  createAbortController?: () => AbortController;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
};

export type TelegramWebhookDiagnosticDependencies = TelegramClientDependencies & {
  parseJson?: (text: string) => unknown;
};

export const TELEGRAM_GET_ME_TIMEOUT_MS = 5_000;
export const TELEGRAM_GET_ME_MAX_BYTES = 16 * 1024;
export const TELEGRAM_WEBHOOK_DIAGNOSTIC_TIMEOUT_MS = TELEGRAM_GET_ME_TIMEOUT_MS;
export const TELEGRAM_WEBHOOK_DIAGNOSTIC_MAX_BYTES = TELEGRAM_GET_ME_MAX_BYTES;

const TELEGRAM_BOT_TOKEN_PATTERN = /^([1-9][0-9]{5,19}):[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

export async function diagnoseTelegramWebhook(
  token: string,
  dependencies: TelegramWebhookDiagnosticDependencies = {},
): Promise<TelegramWebhookDiagnosticResult> {
  if (!TELEGRAM_BOT_TOKEN_PATTERN.test(token)) {
    return "uncertain";
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const abortController = dependencies.createAbortController?.() ?? new AbortController();
    const setTimer = dependencies.setTimeout ?? setTimeout;
    const clearTimer = dependencies.clearTimeout ?? clearTimeout;

    timeout = setTimer(() => abortController.abort(), TELEGRAM_WEBHOOK_DIAGNOSTIC_TIMEOUT_MS);

    try {
      const response = await (dependencies.fetch ?? fetch)(
        `https://api.telegram.org/bot${encodeURIComponent(token)}/getWebhookInfo`,
        {
          method: "POST",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: abortController.signal,
        },
      );

      if (!response.ok) {
        return "uncertain";
      }

      const body = await readBoundedBody(response);

      if (!body.ok) {
        return "uncertain";
      }

      return parseTelegramWebhookInfoResponse(body.text, dependencies.parseJson ?? JSON.parse);
    } finally {
      if (timeout !== undefined) {
        clearTimer(timeout);
      }
    }
  } catch {
    return "uncertain";
  }
}

export async function validateTelegramBotTokenWithGetMe(
  token: string,
  dependencies: TelegramClientDependencies = {},
): Promise<TelegramBotValidationResult> {
  const tokenMatch = TELEGRAM_BOT_TOKEN_PATTERN.exec(token);

  if (!tokenMatch) {
    return { ok: false, reason: "invalid_bot_token" };
  }

  const tokenBotId = tokenMatch[1];

  if (!tokenBotId) {
    return { ok: false, reason: "invalid_bot_token" };
  }
  const abortController = dependencies.createAbortController?.() ?? new AbortController();
  const setTimer = dependencies.setTimeout ?? setTimeout;
  const clearTimer = dependencies.clearTimeout ?? clearTimeout;
  const timeout = setTimer(() => abortController.abort(), TELEGRAM_GET_ME_TIMEOUT_MS);

  try {
    const response = await (dependencies.fetch ?? fetch)(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`,
      {
        method: "POST",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: abortController.signal,
      },
    );

    if (response.status === 401 || response.status === 404) {
      return { ok: false, reason: "invalid_bot_token" };
    }

    if (response.status === 429 || response.status >= 500) {
      return { ok: false, reason: "telegram_validation_unavailable" };
    }

    const body = await readBoundedBody(response);

    if (!body.ok) {
      return { ok: false, reason: "telegram_validation_invalid_response" };
    }

    if (!response.ok) {
      const parsed = parseTelegramGetMeResponse(body.text, tokenBotId);

      return !parsed.ok && parsed.reason === "invalid_bot_token"
        ? parsed
        : { ok: false, reason: "telegram_validation_invalid_response" };
    }

    const parsed = parseTelegramGetMeResponse(body.text, tokenBotId);

    return parsed;
  } catch (error) {
    if (abortController.signal.aborted || isAbortError(error)) {
      return { ok: false, reason: "telegram_validation_timeout" };
    }

    return { ok: false, reason: "telegram_validation_unavailable" };
  } finally {
    clearTimer(timeout);
  }
}

async function readBoundedBody(
  response: Response,
): Promise<{ ok: true; text: string } | { ok: false }> {
  const declaredLength = response.headers.get("content-length");

  if (declaredLength !== null) {
    const parsedLength = Number.parseInt(declaredLength, 10);

    if (
      !Number.isInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > TELEGRAM_GET_ME_MAX_BYTES
    ) {
      return { ok: false };
    }
  }

  if (!response.body) {
    const text = await response.text();
    return Buffer.byteLength(text, "utf8") <= TELEGRAM_GET_ME_MAX_BYTES
      ? { ok: true, text }
      : { ok: false };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    if (value) {
      bytes += value.byteLength;

      if (bytes > TELEGRAM_GET_ME_MAX_BYTES) {
        await reader.cancel();
        return { ok: false };
      }

      chunks.push(value);
    }
  }

  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

function parseTelegramGetMeResponse(text: string, tokenBotId: string): TelegramBotValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  if (parsed.ok === false) {
    return { ok: false, reason: "invalid_bot_token" };
  }

  if (parsed.ok !== true || !isPlainObject(parsed.result)) {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  const id = parsed.result.id;
  const isBot = parsed.result.is_bot;
  const username = parsed.result.username;

  if (
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    isBot !== true ||
    String(id) !== tokenBotId
  ) {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  if (username !== undefined && username !== null && typeof username !== "string") {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  if (typeof username === "string" && !TELEGRAM_USERNAME_PATTERN.test(username)) {
    return { ok: false, reason: "telegram_validation_invalid_response" };
  }

  return {
    ok: true,
    bot: {
      botId: String(id),
      username: typeof username === "string" ? username : null,
    },
  };
}

function parseTelegramWebhookInfoResponse(
  text: string,
  parseJson: (text: string) => unknown,
): TelegramWebhookDiagnosticResult {
  let parsed: unknown;

  try {
    parsed = parseJson(text);
  } catch {
    return "uncertain";
  }

  if (!isStrictPlainRecord(parsed)) {
    return "uncertain";
  }

  const ok = readOwnDataProperty(parsed, "ok");
  const result = readOwnDataProperty(parsed, "result");

  if (ok !== true || !isStrictPlainRecord(result)) {
    return "uncertain";
  }

  const url = readOwnDataProperty(result, "url");

  if (typeof url !== "string") {
    return "uncertain";
  }

  return url.length === 0 ? "empty" : "nonempty";
}

function isStrictPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  try {
    const prototype = Object.getPrototypeOf(value);

    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }

    return Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => "value" in descriptor,
    );
  } catch {
    return false;
  }
}

function readOwnDataProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}
