export const PUBLIC_AGENT_RUNTIME_KINDS = [
  "healthy",
  "recovering",
  "stopping",
  "intentionally_stopped",
  "attention_required",
  "unavailable",
] as const;

export const PUBLIC_AGENT_RUNTIME_ACTIONS = ["none", "wait", "start", "restart"] as const;

export type PublicAgentRuntimeKind = (typeof PUBLIC_AGENT_RUNTIME_KINDS)[number];
export type PublicAgentRuntimeAction = (typeof PUBLIC_AGENT_RUNTIME_ACTIONS)[number];

/**
 * The complete browser-safe runtime projection. Deliberately do not add diagnostic
 * codes, identifiers, counters, timestamps, or controller correlation fields here.
 */
export type PublicAgentRuntimePresentation = {
  kind: PublicAgentRuntimeKind;
  action: PublicAgentRuntimeAction;
  label: string;
  message: string;
};

export type SafeRuntimeGetParseResult =
  | { ok: true; runtime: PublicAgentRuntimePresentation | null }
  | { ok: false };

const RUNTIME_KIND_SET = new Set<string>(PUBLIC_AGENT_RUNTIME_KINDS);
const RUNTIME_ACTION_SET = new Set<string>(PUBLIC_AGENT_RUNTIME_ACTIONS);

export function parseSafeRuntimeGetBody(value: unknown): SafeRuntimeGetParseResult {
  const record = readExactDataRecord(value, ["runtime"]);

  if (record === null) {
    return { ok: false };
  }

  if (record.runtime === null) {
    return { ok: true, runtime: null };
  }

  const runtime = parseSafeRuntimePresentation(record.runtime);
  return runtime === null ? { ok: false } : { ok: true, runtime };
}

export function parseSafeRuntimePresentation(
  value: unknown,
): PublicAgentRuntimePresentation | null {
  const record = readExactDataRecord(value, ["kind", "action", "label", "message"]);

  if (record === null) {
    return null;
  }

  if (
    typeof record.kind !== "string" ||
    !RUNTIME_KIND_SET.has(record.kind) ||
    typeof record.action !== "string" ||
    !RUNTIME_ACTION_SET.has(record.action) ||
    !isSafeCopy(record.label) ||
    !isSafeCopy(record.message)
  ) {
    return null;
  }

  return {
    kind: record.kind as PublicAgentRuntimeKind,
    action: record.action as PublicAgentRuntimeAction,
    label: record.label,
    message: record.message,
  };
}

export function runtimePollDelayMs(foregroundElapsedMs: number): number {
  if (!Number.isFinite(foregroundElapsedMs) || foregroundElapsedMs < 0) {
    return 5_000;
  }

  if (foregroundElapsedMs < 5 * 60_000) {
    return 5_000;
  }

  if (foregroundElapsedMs < 15 * 60_000) {
    return 15_000;
  }

  return 30_000;
}

function isSafeCopy(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 240 && value.trim() === value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readExactDataRecord(
  value: unknown,
  expected: readonly string[],
): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }

  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expectedSorted = [...expected].sort();

    if (
      actual.length !== expectedSorted.length ||
      !actual.every((key, index) => key === expectedSorted[index])
    ) {
      return null;
    }

    const record: Record<string, unknown> = {};
    for (const key of expected) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) {
        return null;
      }
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}
