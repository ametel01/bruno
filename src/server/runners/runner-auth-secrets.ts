import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const RUNNER_AUTH_HASH_ALGORITHM = "sha256";
export const REGISTRATION_TOKEN_PREFIX = "agb_reg";
export const RUNNER_CREDENTIAL_PREFIX = "agb_run";

const RANDOM_SECRET_BYTES = 32;
const STORED_PREFIX_LENGTH = 16;

type RandomBytes = (size: number) => Uint8Array;

export type GeneratedRunnerSecret = {
  value: string;
  hash: string;
  prefix: string;
  hashAlgorithm: typeof RUNNER_AUTH_HASH_ALGORITHM;
};

export function createRunnerRegistrationToken(
  dependencies: { randomBytes?: RandomBytes } = {},
): GeneratedRunnerSecret {
  return createRunnerSecret(REGISTRATION_TOKEN_PREFIX, dependencies.randomBytes);
}

export function createRunnerCredential(
  dependencies: { randomBytes?: RandomBytes } = {},
): GeneratedRunnerSecret {
  return createRunnerSecret(RUNNER_CREDENTIAL_PREFIX, dependencies.randomBytes);
}

export function hashRunnerSecret(value: string): string {
  const normalizedValue = normalizeRunnerSecret(value);

  return createHash(RUNNER_AUTH_HASH_ALGORITHM).update(normalizedValue, "utf8").digest("hex");
}

export function verifyRunnerSecret(input: { value: string; expectedHash: string }): boolean {
  const expectedHash = normalizeHash(input.expectedHash);

  if (!expectedHash) {
    return false;
  }

  const actualHash = hashRunnerSecret(input.value);
  const actual = Buffer.from(actualHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createRunnerSecret(
  prefix: string,
  randomBytesImplementation: RandomBytes = (size) => randomBytes(size),
): GeneratedRunnerSecret {
  const randomMaterial = Buffer.from(randomBytesImplementation(RANDOM_SECRET_BYTES)).toString(
    "base64url",
  );
  const value = `${prefix}_${randomMaterial}`;

  return {
    value,
    hash: hashRunnerSecret(value),
    prefix: value.slice(0, STORED_PREFIX_LENGTH),
    hashAlgorithm: RUNNER_AUTH_HASH_ALGORITHM,
  };
}

function normalizeRunnerSecret(value: string): string {
  const normalizedValue = value.trim();

  if (!normalizedValue) {
    throw new Error("Runner secret must not be empty.");
  }

  return normalizedValue;
}

function normalizeHash(value: string): string | null {
  const normalizedValue = value.trim().toLowerCase();

  return /^[0-9a-f]{64}$/.test(normalizedValue) ? normalizedValue : null;
}
