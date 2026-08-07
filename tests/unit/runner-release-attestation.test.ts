import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createRunnerReleaseAttestation,
  RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION,
  verifyRunnerReleaseAttestation,
  type RunnerReleaseAttestation,
} from "@/src/runner-service/release-attestation";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const RELEASE = {
  version: "1".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  bootContractVersion: "plingpling.runner.boot.v2",
};
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_EXPIRES_AT = "2026-08-15T00:00:00.000Z";
const SOURCE_REVISION = "1".repeat(40);

describe("runner release attestation", () => {
  it("verifies an exact fresh signed release and snapshot identity", () => {
    const keys = generateKeyPairSync("ed25519");
    const signed = createRunnerReleaseAttestation({
      attestation: attestation(),
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: signed.canonicalBytes,
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: {
          release: RELEASE,
          snapshotId: "1102",
          snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
          snapshotManifestDigest: SNAPSHOT_DIGEST,
          sourceRevision: SOURCE_REVISION,
          now: NOW,
        },
      }),
    ).toMatchObject({ ok: true, digest: signed.digest, attestation: attestation() });
  });

  it.each([
    ["release", { release: { ...RELEASE, version: "2".repeat(40) } }],
    ["snapshot", { snapshotId: "1103" }],
    ["manifest", { snapshotManifestDigest: `sha256:${"c".repeat(64)}` }],
    ["source", { sourceRevision: "2".repeat(40) }],
  ])("fails closed for a mismatched %s identity", (_label, expectedOverride) => {
    const keys = generateKeyPairSync("ed25519");
    const signed = createRunnerReleaseAttestation({
      attestation: attestation(),
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: signed.canonicalBytes,
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: {
          release: RELEASE,
          snapshotId: "1102",
          snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
          snapshotManifestDigest: SNAPSHOT_DIGEST,
          sourceRevision: SOURCE_REVISION,
          now: NOW,
          ...expectedOverride,
        },
      }),
    ).toEqual({ ok: false, reason: "attestation_identity_mismatch" });
  });

  it("rejects stale, tampered, unknown-field, and wrong-key evidence", () => {
    const keys = generateKeyPairSync("ed25519");
    const wrongKeys = generateKeyPairSync("ed25519");
    const signed = createRunnerReleaseAttestation({
      attestation: attestation(),
      privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });
    const expected = {
      release: RELEASE,
      snapshotId: "1102",
      snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
      snapshotManifestDigest: SNAPSHOT_DIGEST,
      sourceRevision: SOURCE_REVISION,
    };

    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: signed.canonicalBytes,
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: { ...expected, now: new Date("2026-08-20T00:00:00.000Z") },
      }),
    ).toEqual({ ok: false, reason: "attestation_stale" });
    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: signed.canonicalBytes.replace("1102", "1103"),
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: { ...expected, now: NOW },
      }),
    ).toEqual({ ok: false, reason: "attestation_signature_invalid" });
    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: JSON.stringify({ ...attestation(), unexpected: true }),
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: { ...expected, now: NOW },
      }),
    ).toEqual({ ok: false, reason: "attestation_schema_invalid" });
    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: JSON.stringify({
          ...attestation(),
          release: { ...attestation().release, unexpected: true },
        }),
        signature: signed.signature,
        publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: { ...expected, now: NOW },
      }),
    ).toEqual({ ok: false, reason: "attestation_schema_invalid" });
    expect(
      verifyRunnerReleaseAttestation({
        attestationBytes: signed.canonicalBytes,
        signature: signed.signature,
        publicKeyPem: wrongKeys.publicKey.export({ format: "pem", type: "spki" }).toString(),
        expected: { ...expected, now: NOW },
      }),
    ).toEqual({ ok: false, reason: "attestation_signature_invalid" });
  });
});

function attestation(): RunnerReleaseAttestation {
  return {
    schemaVersion: RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION,
    release: RELEASE,
    snapshot: {
      expiresAt: SNAPSHOT_EXPIRES_AT,
      id: "1102",
      manifestDigest: SNAPSHOT_DIGEST,
    },
    sourceRevision: SOURCE_REVISION,
    workflow: { runId: "123456", runAttempt: "1" },
    validation: {
      fullFixturePassedAt: "2026-08-07T09:55:00.000Z",
      cleanupVerifiedAt: "2026-08-07T09:56:00.000Z",
    },
    issuedAt: "2026-08-07T09:57:00.000Z",
    expiresAt: "2026-08-14T09:57:00.000Z",
  };
}
