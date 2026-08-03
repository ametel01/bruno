export type TelegramAllowlistParseResult =
  | { ok: true; values: string[] }
  | { ok: false; reason: "empty" | "invalid_id" | "too_many" };

export function parseCanonicalTelegramAllowlist(value: string): TelegramAllowlistParseResult {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const seen = new Set<string>();
  const parsed: string[] = [];

  if (lines.length === 0) {
    return { ok: false, reason: "empty" };
  }

  if (lines.length > 100) {
    return { ok: false, reason: "too_many" };
  }

  for (const line of lines) {
    if (!/^[1-9][0-9]*$/.test(line)) {
      return { ok: false, reason: "invalid_id" };
    }

    if (!seen.has(line)) {
      seen.add(line);
      parsed.push(line);
    }
  }

  return { ok: true, values: parsed };
}
