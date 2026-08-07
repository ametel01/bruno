import { readFile, writeFile } from "node:fs/promises";
import { buildRunnerSnapshot } from "@/src/server/runners/runner-snapshot-build";
import { DigitalOceanApiProvider } from "@/src/server/runners/digitalocean-provider";

const args = parseArgs(process.argv.slice(2));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 55 * 60 * 1000);

try {
  const privateKeyPem = await readRequiredFile(args.signingKeyPath, "signing key");
  const token = readRequiredEnv("AGENTBAY_DIGITALOCEAN_TOKEN");
  const provider = new DigitalOceanApiProvider({ token });
  const result = await buildRunnerSnapshot({
    costAuthorization: args.costAuthorization,
    operationId: args.runId,
    sourceRevision: args.sourceRevision,
    region: args.region,
    sizeSlug: args.sizeSlug,
    baseImageId: args.baseImageId,
    baseImageSlug: args.baseImageSlug,
    runnerImage: args.runnerImage,
    defaultAgentImage: args.defaultAgentImage,
    hermesImage: args.hermesImage,
    bootResult: JSON.parse(await readRequiredFile(args.bootResultPath, "boot result")),
    sanitationResult: JSON.parse(
      await readRequiredFile(args.sanitationResultPath, "sanitation result"),
    ),
    privateKeyPem,
    provider,
    context: { signal: controller.signal },
  });

  if (!result.ok) {
    throw new Error(`Snapshot build failed closed: ${result.reason}.`);
  }

  await writeFile(args.manifestOut, result.manifestBytes, { mode: 0o600 });
  await writeFile(args.signatureOut, `${result.signature}\n`, { mode: 0o600 });
  await writeFile(args.digestOut, `${result.digest}\n`, { mode: 0o600 });
  process.stdout.write("Runner snapshot manifest written with allowlisted evidence only.\n");
} finally {
  clearTimeout(timeout);
}

function parseArgs(values: string[]) {
  const parsed = new Map<string, string>();

  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument near ${key ?? "<end>"}.`);
    }
    parsed.set(key.slice(2), value);
  }

  return {
    costAuthorization: requiredArg(parsed, "cost-authorization"),
    runId: requiredArg(parsed, "run-id"),
    sourceRevision: requiredArg(parsed, "source-revision"),
    region: requiredArg(parsed, "region"),
    sizeSlug: requiredArg(parsed, "size-slug"),
    baseImageId: requiredArg(parsed, "base-image-id"),
    baseImageSlug: requiredArg(parsed, "base-image-slug"),
    runnerImage: requiredArg(parsed, "runner-image"),
    defaultAgentImage: requiredArg(parsed, "default-agent-image"),
    hermesImage: requiredArg(parsed, "hermes-image"),
    bootResultPath: requiredArg(parsed, "boot-result"),
    sanitationResultPath: requiredArg(parsed, "sanitation-result"),
    signingKeyPath: requiredArg(parsed, "signing-key"),
    manifestOut: requiredArg(parsed, "manifest-out"),
    signatureOut: requiredArg(parsed, "signature-out"),
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
  return value;
}
