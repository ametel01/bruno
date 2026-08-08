import "server-only";

import pino, { type DestinationStream, type Logger as PinoLogger } from "pino";

export const LOG_REDACTION_CENSOR = "[REDACTED]";

const DEFAULT_LOG_LEVEL = "info";
const LOG_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "silent"]);
const MAX_LOG_VALUE_DEPTH = 8;
const MAX_LOG_ARRAY_LENGTH = 100;
const MAX_ERROR_CAUSE_DEPTH = 4;

type LogMetadata = Record<string, unknown>;
type AppLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type AppLogger = {
  child(bindings: LogMetadata): AppLogger;
  trace(event: string, metadata?: LogMetadata, message?: string): void;
  debug(event: string, metadata?: LogMetadata, message?: string): void;
  info(event: string, metadata?: LogMetadata, message?: string): void;
  warn(event: string, metadata?: LogMetadata, message?: string): void;
  errorEvent(event: string, metadata?: LogMetadata, message?: string): void;
  error(event: string, error: unknown, metadata?: LogMetadata, message?: string): void;
  fatal(event: string, error: unknown, metadata?: LogMetadata, message?: string): void;
};

export type CreateAppLoggerOptions = {
  level?: string;
  stream?: DestinationStream;
  base?: LogMetadata;
};

export function createAppLogger(
  component: string,
  options: CreateAppLoggerOptions = {},
): AppLogger {
  const configuredLevel =
    options.level ??
    process.env.BRUNO_LOG_LEVEL ??
    (process.env.NODE_ENV === "test" ? "silent" : undefined);
  const logger = pino(
    {
      level: normalizeLogLevel(configuredLevel),
      base: {
        service: "bruno",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        ...(process.env.VERCEL_GIT_COMMIT_SHA
          ? { release: process.env.VERCEL_GIT_COMMIT_SHA }
          : {}),
        ...sanitizeLogMetadata(options.base ?? {}),
        component,
      },
      messageKey: "message",
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
      },
      redact: {
        paths: [
          "authorization",
          "cookie",
          "password",
          "secret",
          "token",
          "apiKey",
          "privateKey",
          "credential",
          "*.authorization",
          "*.cookie",
          "*.password",
          "*.secret",
          "*.token",
          "*.apiKey",
          "*.privateKey",
          "*.credential",
        ],
        censor: LOG_REDACTION_CENSOR,
      },
    },
    options.stream,
  );

  return wrapLogger(logger);
}

export function normalizeLogLevel(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase();

  return normalized && LOG_LEVELS.has(normalized) ? normalized : DEFAULT_LOG_LEVEL;
}

export function sanitizeLogMetadata(metadata: LogMetadata): LogMetadata {
  return sanitizeRecord(metadata, new WeakSet<object>(), 0);
}

export function serializeLogError(error: unknown): LogMetadata {
  return serializeError(error, new WeakSet<object>(), 0);
}

function wrapLogger(logger: PinoLogger): AppLogger {
  const write = (
    level: AppLogLevel,
    event: string,
    metadata: LogMetadata = {},
    message = event,
  ) => {
    logger[level]({ ...sanitizeLogMetadata(metadata), event }, redactSensitiveText(message));
  };
  const writeError = (
    level: Extract<AppLogLevel, "error" | "fatal">,
    event: string,
    error: unknown,
    metadata: LogMetadata = {},
    message = event,
  ) => {
    logger[level](
      {
        ...sanitizeLogMetadata(metadata),
        event,
        error: serializeLogError(error),
      },
      redactSensitiveText(message),
    );
  };

  return {
    child: (bindings) => wrapLogger(logger.child(sanitizeLogMetadata(bindings))),
    trace: (event, metadata, message) => write("trace", event, metadata, message),
    debug: (event, metadata, message) => write("debug", event, metadata, message),
    info: (event, metadata, message) => write("info", event, metadata, message),
    warn: (event, metadata, message) => write("warn", event, metadata, message),
    errorEvent: (event, metadata, message) => write("error", event, metadata, message),
    error: (event, error, metadata, message) =>
      writeError("error", event, error, metadata, message),
    fatal: (event, error, metadata, message) =>
      writeError("fatal", event, error, metadata, message),
  };
}

function sanitizeRecord(value: LogMetadata, seen: WeakSet<object>, depth: number): LogMetadata {
  if (depth >= MAX_LOG_VALUE_DEPTH) {
    return { truncated: true };
  }

  if (seen.has(value)) {
    return { circular: true };
  }

  seen.add(value);
  const sanitized: LogMetadata = {};

  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = isSensitiveKey(key, nestedValue)
      ? LOG_REDACTION_CENSOR
      : sanitizeValue(nestedValue, seen, depth + 1);
  }

  seen.delete(value);
  return sanitized;
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }

  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "undefined"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return serializeError(value, seen, 0);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_LOG_VALUE_DEPTH) {
      return ["[TRUNCATED]"];
    }

    if (seen.has(value)) {
      return "[CIRCULAR]";
    }

    seen.add(value);
    const sanitized = value
      .slice(0, MAX_LOG_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, seen, depth + 1));

    if (value.length > MAX_LOG_ARRAY_LENGTH) {
      sanitized.push(`[TRUNCATED ${value.length - MAX_LOG_ARRAY_LENGTH} ITEMS]`);
    }

    seen.delete(value);
    return sanitized;
  }

  if (typeof value === "object") {
    return sanitizeRecord(value as LogMetadata, seen, depth);
  }

  return String(value);
}

function serializeError(error: unknown, seen: WeakSet<object>, depth: number): LogMetadata {
  if (depth >= MAX_ERROR_CAUSE_DEPTH) {
    return { type: "Error", message: "[TRUNCATED ERROR CAUSE]" };
  }

  if (!(error instanceof Error)) {
    return {
      type: typeof error,
      message: redactSensitiveText(toSafeString(error)),
    };
  }

  if (seen.has(error)) {
    return { type: error.name || "Error", message: "[CIRCULAR ERROR CAUSE]" };
  }

  seen.add(error);
  const serialized: LogMetadata = {
    type: error.name || "Error",
    message: redactSensitiveText(error.message),
  };

  if (error.stack) {
    serialized.stack = redactSensitiveText(error.stack);
  }

  if (error.cause !== undefined) {
    serialized.cause = serializeError(error.cause, seen, depth + 1);
  }

  for (const [key, value] of Object.entries(error)) {
    if (key === "name" || key === "message" || key === "stack" || key === "cause") {
      continue;
    }

    serialized[key] = isSensitiveKey(key, value)
      ? LOG_REDACTION_CENSOR
      : sanitizeValue(value, seen, depth + 1);
  }

  seen.delete(error);
  return serialized;
}

function isSensitiveKey(key: string, value: unknown): boolean {
  const normalized = key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
  const safeDerivedValue =
    normalized.endsWith("fingerprint") ||
    normalized.endsWith("count") ||
    normalized.endsWith("configured") ||
    normalized.endsWith("present") ||
    normalized.endsWith("enabled") ||
    (normalized.startsWith("has") && typeof value === "boolean");

  if (safeDerivedValue) {
    return false;
  }

  return [
    "authorization",
    "cookie",
    "password",
    "passphrase",
    "secret",
    "token",
    "apikey",
    "privatekey",
    "credential",
  ].some((sensitiveFragment) => normalized.includes(sensitiveFragment));
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /\b(https?|postgres(?:ql)?|redis|mysql):\/\/[^\s/@]+(?::[^\s/@]*)?@/gi,
      "$1://[REDACTED]@",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${LOG_REDACTION_CENSOR}`)
    .replace(
      /\b(token|secret|password|passphrase|api[_-]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+/gi,
      `$1=${LOG_REDACTION_CENSOR}`,
    )
    .replace(/\b(?:dop_v1_|sk-)[A-Za-z0-9._~+/=-]+/gi, LOG_REDACTION_CENSOR)
    .replace(/\bbruno_(?:reg|run)_[A-Za-z0-9._~+/=-]+/gi, LOG_REDACTION_CENSOR);
}

function toSafeString(value: unknown): string {
  try {
    return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}
