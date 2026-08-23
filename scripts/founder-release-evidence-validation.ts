export type FounderEvidenceDigest = `sha256:${string}`;

export function tryParseEvidenceRecord(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    return isEvidenceRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isEvidenceRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGitRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

export function isRuntimeRevision(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(value);
}

export function isEvidenceDigest(value: unknown): value is FounderEvidenceDigest {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

export function isExactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}
