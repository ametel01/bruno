import { readFile, writeFile } from "node:fs/promises";
import { buildRunnerReleaseAttestationArtifact } from "@/src/server/runners/runner-release-attestation-artifact";

const args = parseArgs(process.argv.slice(2));
const artifact = buildRunnerReleaseAttestationArtifact({
  runnerImage: args.runnerImage,
  snapshotManifestBytes: await readRequiredFile(args.snapshotManifest, "snapshot manifest"),
  snapshotSignature: await readRequiredFile(args.snapshotSignature, "snapshot signature"),
  snapshotPublicKeyPem: await readRequiredFile(args.snapshotPublicKey, "snapshot public key"),
  releasePrivateKeyPem: await readRequiredFile(args.releaseSigningKey, "release signing key"),
  workflowRunId: args.runId,
  workflowRunAttempt: args.runAttempt,
  fullFixturePassedAt: args.fullFixturePassedAt,
  cleanupVerifiedAt: args.cleanupVerifiedAt,
});

await writeFile(args.attestationOut, artifact.canonicalBytes, { mode: 0o600 });
await writeFile(args.signatureOut, `${artifact.signature}\n`, { mode: 0o600 });
await writeFile(args.digestOut, `${artifact.digest}\n`, { mode: 0o600 });
process.stdout.write("Exact signed runner release attestation written.\n");

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    parsed.set(key.slice(2), value);
  }
  return {
    runnerImage: requiredArg(parsed, "runner-image"),
    snapshotManifest: requiredArg(parsed, "snapshot-manifest"),
    snapshotSignature: requiredArg(parsed, "snapshot-signature"),
    snapshotPublicKey: requiredArg(parsed, "snapshot-public-key"),
    releaseSigningKey: requiredArg(parsed, "release-signing-key"),
    runId: requiredArg(parsed, "run-id"),
    runAttempt: requiredArg(parsed, "run-attempt"),
    fullFixturePassedAt: requiredArg(parsed, "full-fixture-passed-at"),
    cleanupVerifiedAt: requiredArg(parsed, "cleanup-verified-at"),
    attestationOut: requiredArg(parsed, "attestation-out"),
    signatureOut: requiredArg(parsed, "signature-out"),
    digestOut: requiredArg(parsed, "digest-out"),
  };
}

function requiredArg(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim();
  if (!value) throw new Error(`--${key} is required.`);
  return value;
}

async function readRequiredFile(path: string, label: string): Promise<string> {
  const value = await readFile(path, "utf8");
  if (!value.trim()) throw new Error(`${label} file was empty.`);
  return value.trim();
}
