import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resolveRunnerBootValidation,
  RUNNER_BOOT_VALIDATION_MODE_ENV,
  RUNNER_RELEASE_ATTESTATION_ENV,
  RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_ENV,
  RUNNER_RELEASE_ATTESTATION_SIGNATURE_ENV,
  RUNNER_RELEASE_SOURCE_REVISION_ENV,
  RUNNER_SNAPSHOT_EXPIRES_AT_ENV,
  RUNNER_SNAPSHOT_ID_ENV,
  RUNNER_SNAPSHOT_MANIFEST_DIGEST_ENV,
} from "@/src/runner-service/boot-validation";
import {
  createRunnerReleaseAttestation,
  RUNNER_RELEASE_ATTESTATION_SCHEMA_VERSION,
  type RunnerReleaseAttestation,
} from "@/src/runner-service/release-attestation";

const RELEASE = {
  version: "1".repeat(40),
  imageDigest: `sha256:${"a".repeat(64)}`,
  bootContractVersion: "plingpling.runner.boot.v2",
};
const SNAPSHOT_DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT_EXPIRES_AT = "2026-08-15T00:00:00.000Z";
const SOURCE_REVISION = "1".repeat(40);

describe("runner boot validation", () => {
  it("defaults to full validation without attestation configuration", () => {
    expect(
      resolveRunnerBootValidation({
        env: {},
        releaseEvidence: { release: RELEASE, expectedMatch: null },
      }),
    ).toEqual({ mode: "full" });
  });

  it("accepts lightweight readiness only with exact fresh signed release and snapshot evidence", () => {
    const configured = attestedEnv();
    expect(
      resolveRunnerBootValidation({
        env: configured.env,
        releaseEvidence: { release: RELEASE, expectedMatch: true },
        now: new Date("2026-08-07T10:00:00.000Z"),
      }),
    ).toEqual({
      mode: "release_attested",
      releaseAttestationDigest: configured.digest,
      releaseAttestationExpiresAt: "2026-08-14T09:57:00.000Z",
      snapshotId: "1102",
      snapshotManifestDigest: SNAPSHOT_DIGEST,
      snapshotExpiresAt: SNAPSHOT_EXPIRES_AT,
    });
  });

  it.each([
    ["missing evidence", {}, "attestation_configuration_missing"],
    ["unverified image", attestedEnv().env, "release_identity_unverified"],
    [
      "wrong snapshot",
      { ...attestedEnv().env, [RUNNER_SNAPSHOT_ID_ENV]: "1103" },
      "attestation_identity_mismatch",
    ],
  ])("fails closed for %s", (_label, env, reason) => {
    expect(() =>
      resolveRunnerBootValidation({
        env: { [RUNNER_BOOT_VALIDATION_MODE_ENV]: "release_attested", ...env },
        releaseEvidence: {
          release: RELEASE,
          expectedMatch: reason === "release_identity_unverified" ? null : true,
        },
        now: new Date("2026-08-07T10:00:00.000Z"),
      }),
    ).toThrow(expect.objectContaining({ reason }));
  });
});

function attestedEnv(): { env: Record<string, string>; digest: string } {
  const keys = generateKeyPairSync("ed25519");
  const attestation: RunnerReleaseAttestation = {
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
  const signed = createRunnerReleaseAttestation({
    attestation,
    privateKeyPem: keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  });
  return {
    digest: signed.digest,
    env: {
      [RUNNER_BOOT_VALIDATION_MODE_ENV]: "release_attested",
      [RUNNER_RELEASE_ATTESTATION_ENV]: signed.canonicalBytes,
      [RUNNER_RELEASE_ATTESTATION_SIGNATURE_ENV]: signed.signature,
      [RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY_ENV]: keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      [RUNNER_SNAPSHOT_ID_ENV]: "1102",
      [RUNNER_SNAPSHOT_MANIFEST_DIGEST_ENV]: SNAPSHOT_DIGEST,
      [RUNNER_SNAPSHOT_EXPIRES_AT_ENV]: SNAPSHOT_EXPIRES_AT,
      [RUNNER_RELEASE_SOURCE_REVISION_ENV]: SOURCE_REVISION,
    },
  };
}
