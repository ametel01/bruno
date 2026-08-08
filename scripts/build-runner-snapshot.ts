import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildRunnerSnapshot } from "@/src/server/runners/runner-snapshot-build";
import { DigitalOceanApiProvider } from "@/src/server/runners/digitalocean-provider";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 55 * 60 * 1000);
const tempDir = await mkdtemp(join(tmpdir(), "bruno-runner-snapshot-"));
let provider: DigitalOceanApiProvider | null = null;
let builderSshKeyId: string | null = null;

try {
  validatePreEffectArgs(args);
  const privateKeyPem = await readRequiredFile(args.signingKeyPath, "signing key");
  const token = readRequiredEnv("BRUNO_DIGITALOCEAN_TOKEN");
  provider = new DigitalOceanApiProvider({ token });
  const builderSshPrivateKeyPath = join(tempDir, "builder_ssh_key");

  await execFileAsync(
    "ssh-keygen",
    ["-t", "ed25519", "-N", "", "-C", "bruno-snapshot-builder", "-f", builderSshPrivateKeyPath],
    { signal: controller.signal },
  );
  const builderSshPublicKey = await readRequiredFile(
    `${builderSshPrivateKeyPath}.pub`,
    "builder SSH public key",
  );
  const builderSshKey = await provider.createSshKey(
    {
      name: `bruno-snapshot-builder-${args.runId}`,
      publicKey: builderSshPublicKey,
    },
    { signal: controller.signal },
  );

  if (!builderSshKey.ok) {
    throw new Error("Snapshot build failed closed: builder SSH key creation failed.");
  }
  builderSshKeyId = builderSshKey.value.id;

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
    controllerSshSourceCidr: args.controllerCidr,
    builderSshKeyId,
    builderSshPrivateKeyPath,
    privateKeyPem,
    provider,
    context: { signal: controller.signal },
  });
  if (result.cleanup.deletedSshKeyId === builderSshKeyId) {
    builderSshKeyId = null;
  }

  if (!result.ok) {
    throw new Error(`Snapshot build failed closed: ${result.reason}.`);
  }

  await writeFile(args.bootResultOut, `${JSON.stringify(result.bootResult, null, 2)}\n`, {
    mode: 0o600,
  });
  await writeFile(
    args.sanitationResultOut,
    `${JSON.stringify(result.sanitationResult, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFile(args.manifestOut, result.manifestBytes, { mode: 0o600 });
  await writeFile(args.signatureOut, `${result.signature}\n`, { mode: 0o600 });
  await writeFile(args.digestOut, `${result.digest}\n`, { mode: 0o600 });
  process.stdout.write("Runner snapshot manifest written with allowlisted evidence only.\n");
} finally {
  clearTimeout(timeout);
  if (builderSshKeyId && provider) {
    const cleanupController = new AbortController();
    const cleanupTimeout = setTimeout(() => cleanupController.abort(), 30_000);
    try {
      await provider.deleteSshKey({ id: builderSshKeyId }, { signal: cleanupController.signal });
    } catch {
      // The provider cleanup result is intentionally not logged: key ID and provider errors are
      // reconciliation-sensitive evidence. The orchestrator also records deletion failures.
    } finally {
      clearTimeout(cleanupTimeout);
    }
  }
  await rm(tempDir, { recursive: true, force: true });
}

function validatePreEffectArgs(input: ReturnType<typeof parseArgs>): void {
  if (input.costAuthorization !== "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER") {
    throw new Error("Exact snapshot build authorization sentinel is required.");
  }
  if (!/^[1-9][0-9]{0,18}$/.test(input.runId)) throw new Error("--run-id is invalid.");
  if (!/^[a-f0-9]{40}$/.test(input.sourceRevision)) {
    throw new Error("--source-revision is invalid.");
  }
  for (const [key, value] of [
    ["region", input.region],
    ["size-slug", input.sizeSlug],
    ["base-image-slug", input.baseImageSlug],
  ] as const) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value)) {
      throw new Error(`--${key} is invalid.`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.baseImageId)) {
    throw new Error("--base-image-id is invalid.");
  }
  for (const [key, value] of [
    ["runner-image", input.runnerImage],
    ["default-agent-image", input.defaultAgentImage],
    ["hermes-image", input.hermesImage],
  ] as const) {
    if (!/@sha256:[a-f0-9]{64}$/.test(value)) throw new Error(`--${key} is invalid.`);
  }
  if (!isExplicitControllerCidr(input.controllerCidr)) {
    throw new Error("--controller-cidr must be an explicit controller /32 IPv4 or /128 IPv6 CIDR.");
  }
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
    controllerCidr: requiredArg(parsed, "controller-cidr"),
    signingKeyPath: requiredArg(parsed, "signing-key"),
    bootResultOut: requiredArg(parsed, "boot-result-out"),
    sanitationResultOut: requiredArg(parsed, "sanitation-result-out"),
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

function isExplicitControllerCidr(value: string): boolean {
  const [address, prefix, extra] = value.trim().split("/");

  if (!address || !prefix || extra !== undefined) {
    return false;
  }

  if (value === "0.0.0.0/0" || value === "::/0" || address === "0.0.0.0" || address === "::") {
    return false;
  }

  return (prefix === "32" && isIP(address) === 4) || (prefix === "128" && isIP(address) === 6);
}
