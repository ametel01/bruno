import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const HERMES_STAGING_ATTESTATION_CHALLENGE_TTL_MS = 5 * 60_000;

const CHALLENGE_DOMAIN = "bruno-hermes-staging-challenge-v1";
const ATTESTATION_DOMAIN = "bruno-hermes-staging-attestation-v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BEARER_PATTERN = /^[A-Za-z0-9._~+/=-]{32,256}$/;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export type HermesStagingAttestationPurpose = "initial" | "post_restart";

export type HermesStagingAttestationChallenge = {
  purpose: HermesStagingAttestationPurpose;
  challengeId: string;
  text: string;
  digest: string;
  expiresAt: Date;
};

export function createHermesStagingAttestationChallenge(input: {
  runId: string;
  purpose: HermesStagingAttestationPurpose;
  now: Date;
  deadlineAt: Date;
}): HermesStagingAttestationChallenge | null {
  if (
    !UUID_PATTERN.test(input.runId) ||
    !isValidDate(input.now) ||
    !isValidDate(input.deadlineAt) ||
    input.deadlineAt.getTime() <= input.now.getTime()
  ) {
    return null;
  }

  const challengeId = deterministicUuid(`${CHALLENGE_DOMAIN}:${input.runId}:${input.purpose}`);
  const text = `Bruno.Ai Hermes ${input.purpose === "initial" ? "initial" : "post-restart"} acceptance ${challengeId}`;
  return {
    purpose: input.purpose,
    challengeId,
    text,
    digest: digest(text),
    expiresAt: new Date(
      Math.min(
        input.now.getTime() + HERMES_STAGING_ATTESTATION_CHALLENGE_TTL_MS,
        input.deadlineAt.getTime(),
      ),
    ),
  };
}

export function createHermesStagingAttestationToken(input: {
  bearerSecret: string;
  runId: string;
  challenge: Pick<HermesStagingAttestationChallenge, "purpose" | "challengeId" | "digest">;
}): string | null {
  if (
    !BEARER_PATTERN.test(input.bearerSecret) ||
    !UUID_PATTERN.test(input.runId) ||
    !UUID_PATTERN.test(input.challenge.challengeId) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.challenge.digest)
  ) {
    return null;
  }

  return createHmac("sha256", input.bearerSecret)
    .update(
      `${ATTESTATION_DOMAIN}:${input.runId}:${input.challenge.purpose}:${input.challenge.challengeId}:${input.challenge.digest}`,
    )
    .digest("hex");
}

export function digestHermesStagingAttestationChallengeText(text: string): string | null {
  if (
    text.length < 1 ||
    text.length > 512 ||
    ![...text].every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && codePoint >= 32 && codePoint !== 127;
    })
  ) {
    return null;
  }

  return digest(text);
}

export function verifyHermesStagingAttestationToken(input: {
  bearerSecret: string;
  runId: string;
  challenge: Pick<HermesStagingAttestationChallenge, "purpose" | "challengeId" | "digest">;
  token: string;
}): boolean {
  const expected = createHermesStagingAttestationToken(input);
  if (!expected || !TOKEN_PATTERN.test(input.token)) return false;
  return timingSafeEqual(Buffer.from(input.token, "hex"), Buffer.from(expected, "hex"));
}

export function createHermesStagingAttestationDigest(input: {
  runId: string;
  challenge: Pick<HermesStagingAttestationChallenge, "purpose" | "digest">;
  token: string;
}): string | null {
  if (
    !UUID_PATTERN.test(input.runId) ||
    !/^sha256:[a-f0-9]{64}$/.test(input.challenge.digest) ||
    !TOKEN_PATTERN.test(input.token)
  ) {
    return null;
  }
  return digest(
    `${ATTESTATION_DOMAIN}:${input.runId}:${input.challenge.purpose}:${input.challenge.digest}:${input.token}`,
  );
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}
