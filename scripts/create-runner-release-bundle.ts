import { readFile, writeFile } from "node:fs/promises";
import { buildRunnerReleaseBundleArtifact } from "@/src/server/runners/runner-release-attestation-artifact";
import type { RunnerSnapshotTrustedPublicKeys } from "@/src/server/runners/runner-snapshot-manifest";

const args = parseArgs(process.argv.slice(2));
const artifact = buildRunnerReleaseBundleArtifact({
  controlPlaneSourceRevision: args.controlPlaneSourceRevision,
  runnerImage: args.runnerImage,
  snapshotOciReference: args.snapshotOciReference,
  snapshotBundleBytes: await readRequiredFile(args.snapshotBundle, "snapshot bundle"),
  approvedSnapshotDigest: args.snapshotBundleDigest,
  snapshotTrustedPublicKeys: readTrustSet(
    readRequiredEnv("BRUNO_SNAPSHOT_TRUST_SET"),
    "BRUNO_SNAPSHOT_TRUST_SET",
  ),
  releaseSigningKeyId: readRequiredEnv("BRUNO_RELEASE_SIGNING_KEY_ID"),
  releasePrivateKeyPem: readRequiredEnv("BRUNO_RELEASE_SIGNING_KEY_PEM"),
  workflowRunId: args.runId,
  workflowRunAttempt: args.runAttempt,
  smokeResult: JSON.parse(await readRequiredFile(args.smokeResult, "release smoke result")),
  fullFixturePassedAt: args.fullFixturePassedAt,
  cleanupVerifiedAt: args.cleanupVerifiedAt,
});

await writeFile(args.bundleOut, artifact.bundleBytes, { mode: 0o600 });
await writeFile(args.digestOut, `${artifact.digest}\n`, { mode: 0o600 });
process.stdout.write("Canonical signed Verified Release bundle written.\n");

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid Verified Release argument near ${key ?? "<end>"}.`);
    }
    parsed.set(key.slice(2), value);
  }
  return {
    controlPlaneSourceRevision: requiredArg(parsed, "control-plane-source-revision"),
    runnerImage: requiredArg(parsed, "runner-image"),
    snapshotOciReference: requiredArg(parsed, "snapshot-oci-reference"),
    snapshotBundleDigest: requiredArg(parsed, "snapshot-bundle-digest"),
    snapshotBundle: requiredArg(parsed, "snapshot-bundle"),
    smokeResult: requiredArg(parsed, "smoke-result"),
    runId: requiredArg(parsed, "run-id"),
    runAttempt: requiredArg(parsed, "run-attempt"),
    fullFixturePassedAt: requiredArg(parsed, "full-fixture-passed-at"),
    cleanupVerifiedAt: requiredArg(parsed, "cleanup-verified-at"),
    bundleOut: requiredArg(parsed, "bundle-out"),
    digestOut: requiredArg(parsed, "digest-out"),
  };
}

function requiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

function readRequiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  const value = await readFile(path, "utf8");
  if (!value.trim()) throw new Error(`${label} file was empty.`);
  return value.trim();
}

function readTrustSet(value: string, envName: string): RunnerSnapshotTrustedPublicKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error(`${envName} must be valid JSON.`);
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0 ||
    Object.values(raw).some((key) => typeof key !== "string")
  ) {
    throw new Error(`${envName} must map signing key IDs to public keys.`);
  }
  return raw as RunnerSnapshotTrustedPublicKeys;
}
