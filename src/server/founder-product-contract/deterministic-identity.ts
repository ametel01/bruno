import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

const SUBJECT_HEADER = "x-bruno-founder-contract-clerk-subject";
const SIGNATURE_HEADER = "x-bruno-founder-contract-clerk-signature";
const ISSUED_AT_HEADER = "x-bruno-founder-contract-issued-at";
const EXPIRES_AT_HEADER = "x-bruno-founder-contract-expires-at";
const IDENTITY_ENVELOPE_TTL_MS = 5 * 60 * 1_000;

type HeaderReader = Pick<Headers, "get">;

export type FounderContractIdentityResolution =
  | { present: false }
  | { present: true; valid: false }
  | { present: true; valid: true; subject: string };

export function createFounderContractIdentityHeaders(
  subject: string,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Record<string, string> {
  const authority = readAuthority(env);
  if (!authority || !isValidSubject(subject)) {
    throw new Error("Founder Product Contract identity authority is unavailable.");
  }
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.valueOf() + IDENTITY_ENVELOPE_TTL_MS).toISOString();
  return {
    [SUBJECT_HEADER]: subject,
    [ISSUED_AT_HEADER]: issuedAt,
    [EXPIRES_AT_HEADER]: expiresAt,
    [SIGNATURE_HEADER]: signSubject({ subject, issuedAt, expiresAt }, authority),
  };
}

export function resolveFounderContractIdentity(
  headers: HeaderReader,
  env: Record<string, string | undefined> = process.env,
): FounderContractIdentityResolution {
  const subject = headers.get(SUBJECT_HEADER)?.trim() ?? "";
  const signature = headers.get(SIGNATURE_HEADER)?.trim() ?? "";
  const issuedAt = headers.get(ISSUED_AT_HEADER)?.trim() ?? "";
  const expiresAt = headers.get(EXPIRES_AT_HEADER)?.trim() ?? "";
  if (!subject && !signature && !issuedAt && !expiresAt) return { present: false };
  const authority = readAuthority(env);
  const issuedAtDate = new Date(issuedAt);
  const expiresAtDate = new Date(expiresAt);
  const now = new Date();
  if (
    !authority ||
    !isValidSubject(subject) ||
    !/^[a-f0-9]{64}$/.test(signature) ||
    Number.isNaN(issuedAtDate.valueOf()) ||
    Number.isNaN(expiresAtDate.valueOf()) ||
    issuedAtDate > now ||
    expiresAtDate <= now ||
    expiresAtDate.valueOf() - issuedAtDate.valueOf() !== IDENTITY_ENVELOPE_TTL_MS
  ) {
    return { present: true, valid: false };
  }
  const expected = Buffer.from(signSubject({ subject, issuedAt, expiresAt }, authority), "hex");
  const provided = Buffer.from(signature, "hex");
  return timingSafeEqual(expected, provided)
    ? { present: true, valid: true, subject }
    : { present: true, valid: false };
}

function readAuthority(env: Record<string, string | undefined>) {
  if (
    env.BRUNO_AUTH_MODE !== "development" ||
    env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE !== "deterministic" ||
    Boolean(env.VERCEL_ENV) ||
    !isLoopbackApplicationUrl(env.NEXT_PUBLIC_APP_URL)
  ) {
    return null;
  }
  const runId = env.BRUNO_FOUNDER_CONTRACT_RUN_ID?.trim();
  const sourceRevision = env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION?.trim();
  const signingSecret = env.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET?.trim();
  if (!runId || !sourceRevision || !signingSecret || signingSecret.length < 32) return null;
  return { runId, sourceRevision, signingSecret };
}

function signSubject(
  envelope: { subject: string; issuedAt: string; expiresAt: string },
  authority: { runId: string; sourceRevision: string; signingSecret: string },
): string {
  return createHmac("sha256", authority.signingSecret)
    .update(
      `${authority.runId}\n${authority.sourceRevision}\n${envelope.subject}\n${envelope.issuedAt}\n${envelope.expiresAt}`,
    )
    .digest("hex");
}

function isValidSubject(subject: string): boolean {
  return subject.length > 0 && subject.length <= 256 && subject.trim() === subject;
}

function isLoopbackApplicationUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname;
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}
