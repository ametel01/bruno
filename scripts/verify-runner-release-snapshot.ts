import { readFile, writeFile } from "node:fs/promises";
import { verifyRunnerReleaseSnapshotInput } from "@/src/server/runners/runner-release-attestation-artifact";
import type { RunnerSnapshotTrustedPublicKeys } from "@/src/server/runners/runner-snapshot-manifest";

const args = parseArgs(process.argv.slice(2));
const bundleBytes = await readFile(requiredArg(args, "snapshot-bundle"), "utf8");
const approvedSnapshotDigest = requiredArg(args, "snapshot-bundle-digest");
const runnerImage = requiredArg(args, "runner-image");
const output = requiredArg(args, "output");
const snapshotTrustedPublicKeys = readTrustSet(readRequiredEnv("BRUNO_SNAPSHOT_TRUST_SET"));
const verified = verifyRunnerReleaseSnapshotInput({
  runnerImage,
  snapshotBundleBytes: bundleBytes,
  approvedSnapshotDigest,
  snapshotTrustedPublicKeys,
});

await writeFile(
  output,
  `${JSON.stringify({
    snapshotBundleDigest: verified.digest,
    signingKeyId: verified.signingKeyId,
    defaultAgentImage: verified.manifest.defaultAgentImage.reference,
    hermesImage: verified.manifest.hermesImage.reference,
  })}\n`,
  { mode: 0o600 },
);

function parseArgs(input: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < input.length; index += 2) {
    const key = input[index];
    const value = input[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid snapshot verification argument near ${key ?? "<end>"}.`);
    }
    parsed.set(key.slice(2), value);
  }
  return parsed;
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
