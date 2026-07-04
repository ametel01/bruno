import { describe, expect, it } from "vitest";
import {
  createRunnerCredential,
  createRunnerRegistrationToken,
  hashRunnerSecret,
  REGISTRATION_TOKEN_PREFIX,
  RUNNER_AUTH_HASH_ALGORITHM,
  RUNNER_CREDENTIAL_PREFIX,
  verifyRunnerSecret,
} from "@/src/server/runners/runner-auth-secrets";

describe("runner auth secret helpers", () => {
  it("creates registration token material with only hash and prefix suitable for storage", () => {
    const generated = createRunnerRegistrationToken({
      randomBytes: (size) => Buffer.alloc(size, 7),
    });

    expect(generated.value).toMatch(new RegExp(`^${REGISTRATION_TOKEN_PREFIX}_`));
    expect(generated.hashAlgorithm).toBe(RUNNER_AUTH_HASH_ALGORITHM);
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.prefix).toBe(generated.value.slice(0, 16));
    expect(generated.prefix.length).toBeLessThan(generated.value.length);
    expect(generated.hash).not.toContain(generated.value);
    expect(verifyRunnerSecret({ value: generated.value, expectedHash: generated.hash })).toBe(true);
  });

  it("creates runner credential material independently from registration tokens", () => {
    const generated = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 9),
    });

    expect(generated.value).toMatch(new RegExp(`^${RUNNER_CREDENTIAL_PREFIX}_`));
    expect(generated.hashAlgorithm).toBe(RUNNER_AUTH_HASH_ALGORITHM);
    expect(generated.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.prefix).toBe(generated.value.slice(0, 16));
    expect(generated.hash).not.toContain(generated.value);
    expect(verifyRunnerSecret({ value: generated.value, expectedHash: generated.hash })).toBe(true);
  });

  it("hashes trimmed runner secrets and verifies without accepting mismatches", () => {
    const value = createRunnerCredential({
      randomBytes: (size) => Buffer.alloc(size, 11),
    }).value;
    const hash = hashRunnerSecret(`  ${value}  `);

    expect(verifyRunnerSecret({ value, expectedHash: hash })).toBe(true);
    expect(verifyRunnerSecret({ value: `${value}-wrong`, expectedHash: hash })).toBe(false);
    expect(verifyRunnerSecret({ value, expectedHash: "not-a-hash" })).toBe(false);
    expect(verifyRunnerSecret({ value, expectedHash: "" })).toBe(false);
  });

  it("rejects empty runner secret values without echoing them in the error", () => {
    expect(() => hashRunnerSecret("   ")).toThrow("Runner secret must not be empty.");
  });
});
