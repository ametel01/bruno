import { readFile, writeFile } from "node:fs/promises";
import type { RunnerReleaseTrustedPublicKeys } from "@/src/runner-service/release-attestation";
import { OrasRunnerSnapshotRegistryAdapter } from "@/src/server/runners/oras-runner-snapshot-registry";
import {
  publishRunnerReleaseBundle,
  RUNNER_RELEASE_OCI_ARTIFACT_TYPE,
  verifyRetainedRunnerReleaseBundles,
} from "@/src/server/runners/runner-release-registry";

const [command, ...values] = process.argv.slice(2);
if (command !== "publish") throw new Error("Runner release registry command must be publish.");

const args = parseArgs(values);
const trustedPublicKeys = readTrustSet(readRequiredEnv("BRUNO_RELEASE_TRUST_SET"));
const previousOciReference = process.env.BRUNO_RELEASE_PREVIOUS_OCI_REFERENCE?.trim();
const previousBundleDigest = process.env.BRUNO_RELEASE_PREVIOUS_BUNDLE_DIGEST?.trim();
if (Boolean(previousOciReference) !== Boolean(previousBundleDigest)) {
  throw new Error("Previous release OCI reference and bundle digest must be configured together.");
}

const registry = new OrasRunnerSnapshotRegistryAdapter();
const bundleBytes = await readFile(args.bundlePath, "utf8");
const expectedBundleDigest = (await readFile(args.digestPath, "utf8")).trim();
const previous =
  previousOciReference && previousBundleDigest
    ? { ociReference: previousOciReference, bundleDigest: previousBundleDigest }
    : undefined;
const active = await publishRunnerReleaseBundle({
  repository: args.repository,
  bundleBytes,
  expectedBundleDigest,
  trustedPublicKeys,
  ...(previous ? { previous } : {}),
  registry,
});
const retained = await verifyRetainedRunnerReleaseBundles({
  active,
  previous: previous ?? active,
  trustedPublicKeys,
  registry,
});
const artifact = await registry.retrieve(active.ociReference);
const publicKey = artifact.files.find((file) => file.name === "runner-release-signing-key.pem");
if (!publicKey)
  throw new Error("Published release artifact did not retain its signing public key.");

await writeFile(args.publicKeyOut, publicKey.contents, { mode: 0o600 });
await writeFile(
  args.publicationOut,
  `${JSON.stringify(
    {
      schemaVersion: "bruno.runner.release.oci-publication.v1",
      artifactType: RUNNER_RELEASE_OCI_ARTIFACT_TYPE,
      active: retained.active,
      previous: retained.previous,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
process.stdout.write("Verified Release published and re-verified by immutable OCI digest.\n");

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid runner release registry argument near ${key ?? "<end>"}.`);
    }
    parsed.set(key.slice(2), value);
  }
  return {
    repository: requiredArg(parsed, "repository"),
    bundlePath: requiredArg(parsed, "bundle"),
    digestPath: requiredArg(parsed, "digest"),
    publicationOut: requiredArg(parsed, "publication-out"),
    publicKeyOut: requiredArg(parsed, "public-key-out"),
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

function readTrustSet(value: string): RunnerReleaseTrustedPublicKeys {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("BRUNO_RELEASE_TRUST_SET must be valid JSON.");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0 ||
    Object.values(raw).some((key) => typeof key !== "string")
  ) {
    throw new Error("BRUNO_RELEASE_TRUST_SET must map signing key IDs to public keys.");
  }
  return raw as RunnerReleaseTrustedPublicKeys;
}
