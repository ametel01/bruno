import { readFile, writeFile } from "node:fs/promises";
import { OrasRunnerSnapshotRegistryAdapter } from "@/src/server/runners/oras-runner-snapshot-registry";
import type { RunnerSnapshotTrustedPublicKeys } from "@/src/server/runners/runner-snapshot-manifest";
import {
  publishRunnerSnapshotBundle,
  RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
  verifyRetainedRunnerSnapshotBundles,
} from "@/src/server/runners/runner-snapshot-registry";

const [command, ...values] = process.argv.slice(2);

if (command !== "publish") {
  throw new Error("Runner snapshot registry command must be publish.");
}

const args = parseArgs(values);
const trustedPublicKeys = readTrustSet(readRequiredEnv("BRUNO_SNAPSHOT_TRUST_SET"));
const previousOciReference = process.env.BRUNO_SNAPSHOT_PREVIOUS_OCI_REFERENCE?.trim();
const previousBundleDigest = process.env.BRUNO_SNAPSHOT_PREVIOUS_BUNDLE_DIGEST?.trim();

if (Boolean(previousOciReference) !== Boolean(previousBundleDigest)) {
  throw new Error("Previous snapshot OCI reference and bundle digest must be configured together.");
}

const registry = new OrasRunnerSnapshotRegistryAdapter();
const bundleBytes = await readFile(args.bundlePath, "utf8");
const expectedBundleDigest = (await readFile(args.digestPath, "utf8")).trim();
const active = await publishRunnerSnapshotBundle({
  repository: args.repository,
  bundleBytes,
  expectedBundleDigest,
  trustedPublicKeys,
  registry,
});
const retained = await verifyRetainedRunnerSnapshotBundles({
  active,
  previous:
    previousOciReference && previousBundleDigest
      ? { ociReference: previousOciReference, bundleDigest: previousBundleDigest }
      : active,
  trustedPublicKeys,
  registry,
});
const activeArtifact = await registry.retrieve(active.ociReference);
const publicKey = activeArtifact.files.find(
  (file) => file.name === "runner-snapshot-signing-key.pem",
);

if (!publicKey) {
  throw new Error("Published snapshot artifact did not retain its signing public key.");
}

await writeFile(args.publicKeyOut, publicKey.contents, { mode: 0o600 });
await writeFile(
  args.publicationOut,
  `${JSON.stringify(
    {
      schemaVersion: "bruno.runner.snapshot.oci-publication.v1",
      artifactType: RUNNER_SNAPSHOT_OCI_ARTIFACT_TYPE,
      active: retained.active,
      previous: retained.previous,
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
process.stdout.write(
  "Runner Snapshot Attestation v2 bundle published and re-verified by immutable OCI digest.\n",
);

function parseArgs(input: string[]): {
  repository: string;
  bundlePath: string;
  digestPath: string;
  publicationOut: string;
  publicKeyOut: string;
} {
  const parsed = new Map<string, string>();

  for (let index = 0; index < input.length; index += 2) {
    const key = input[index];
    const value = input[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid runner snapshot registry argument near ${key ?? "<end>"}.`);
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

function readTrustSet(value: string): RunnerSnapshotTrustedPublicKeys {
  let raw: unknown;

  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("BRUNO_SNAPSHOT_TRUST_SET must be valid JSON.");
  }

  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.keys(raw).length === 0 ||
    Object.values(raw).some((key) => typeof key !== "string")
  ) {
    throw new Error("BRUNO_SNAPSHOT_TRUST_SET must map signing key IDs to public keys.");
  }

  return raw as RunnerSnapshotTrustedPublicKeys;
}
