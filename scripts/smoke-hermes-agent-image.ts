import { spawn } from "node:child_process";
import { mkdtemp, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LOCAL_HERMES_IMAGE = "bruno-hermes:local";
export const HERMES_UPSTREAM_IMAGE = "nousresearch/hermes-agent:v2026.7.7.2";
export const HERMES_UPSTREAM_INDEX_DIGEST =
  "sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973";
export const HERMES_AMD64_MANIFEST_DIGEST =
  "sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a";
export const HERMES_VERSION_FRAGMENT = "Hermes Agent v0.18.2 (2026.7.7.2)";
export const HERMES_RUNTIME_UID_GID = "10000:10000";
export const DEFAULT_LOCAL_OPTIMIZED_HERMES_IMAGE = "bruno-hermes-optimized:local";
export const OPTIMIZED_HERMES_SOURCE =
  "https://github.com/NousResearch/hermes-agent/archive/refs/tags/v2026.8.3.zip";
export const OPTIMIZED_HERMES_SOURCE_SHA256 =
  "sha256:47e0874a68d428882c0c3aeb7769a7ef330275485926745a9ea48050b00a6453";
export const OPTIMIZED_HERMES_VERSION_FRAGMENT = "Hermes Agent v0.20.0 (2026.8.3)";
export const OPTIMIZED_HERMES_MAX_UNPACKED_BYTES = 1_000_000_000;

export type HermesImageContract = {
  source: string;
  sourceDigest: string;
  platformManifestDigest: string | null;
  version: string;
  runtimeUser: string;
  maxUnpackedBytes?: number;
};

export const LEGACY_HERMES_IMAGE_CONTRACT: HermesImageContract = {
  source: HERMES_UPSTREAM_IMAGE,
  sourceDigest: HERMES_UPSTREAM_INDEX_DIGEST,
  platformManifestDigest: HERMES_AMD64_MANIFEST_DIGEST,
  version: HERMES_VERSION_FRAGMENT,
  runtimeUser: HERMES_RUNTIME_UID_GID,
};

export const OPTIMIZED_HERMES_IMAGE_CONTRACT: HermesImageContract = {
  source: OPTIMIZED_HERMES_SOURCE,
  sourceDigest: OPTIMIZED_HERMES_SOURCE_SHA256,
  platformManifestDigest: null,
  version: OPTIMIZED_HERMES_VERSION_FRAGMENT,
  runtimeUser: HERMES_RUNTIME_UID_GID,
  maxUnpackedBytes: OPTIMIZED_HERMES_MAX_UNPACKED_BYTES,
};

const SAFE_IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const HERMES_DATA_DIR_PREFIX = join(tmpdir(), "bruno-hermes-data-");
const HERMES_DATA_DIR_SUFFIX_PATTERN = /^[A-Za-z0-9_-]+$/;
const GATEWAY_START_TIMEOUT_MS = 15_000;
const SECRET_HISTORY_CANARIES = [
  "OPENROUTER_API_KEY=",
  "TELEGRAM_BOT_TOKEN=",
  "TELEGRAM_ALLOWED_USERS=",
  "BRUNO_AGENT_SECRET_KEYS_JSON",
  "sk-or-v1-",
  ".env.local",
] as const;

type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type RunCommandOptions = {
  timeoutMs?: number;
};

export async function smokeHermesAgentImage(
  image = process.env.BRUNO_HERMES_IMAGE?.trim() || DEFAULT_LOCAL_HERMES_IMAGE,
  contract: HermesImageContract = LEGACY_HERMES_IMAGE_CONTRACT,
) {
  assertSafeImageReference(image);

  const versionProbe = await runDocker([
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--entrypoint",
    "/bin/sh",
    image,
    "-lc",
    [
      "set -eu",
      "/opt/hermes/bin/hermes --version",
      "getent passwd hermes",
      "getent group hermes",
      'stat -c "%u:%g %a %n" /opt/data',
    ].join("; "),
  ]);
  assertExitCode(versionProbe, "Hermes version and ownership probe");
  assertContains(versionProbe.stdout, contract.version, "Hermes version probe");
  assertContains(versionProbe.stdout, "hermes:x:10000:10000", "Hermes passwd probe");
  assertContains(versionProbe.stdout, "10000:10000 700 /opt/data", "Hermes data ownership probe");

  await withPreparedDataDir(image, async (dataDir) => {
    const writeProbe = await runDocker([
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      contract.runtimeUser,
      "--entrypoint",
      "/bin/sh",
      "-v",
      `${dataDir}:/opt/data`,
      image,
      "-lc",
      [
        "set -eu",
        "printf ok > /opt/data/bruno-write-test",
        'test "$(cat /opt/data/bruno-write-test)" = ok',
      ].join("; "),
    ]);
    assertExitCode(writeProbe, "Hermes prepared data directory write probe");
  });

  const gatewayProbe = await withPreparedDataDir(image, (dataDir) =>
    runDocker(
      [
        "run",
        "--rm",
        "--platform",
        "linux/amd64",
        "-v",
        `${dataDir}:/opt/data`,
        image,
        "gateway",
        "run",
        "--no-supervise",
      ],
      { timeoutMs: GATEWAY_START_TIMEOUT_MS },
    ),
  );
  const gatewayOutput = `${gatewayProbe.stdout}\n${gatewayProbe.stderr}`;

  if (!gatewayProbe.timedOut) {
    assertExitCode(gatewayProbe, "Hermes gateway startup probe");
  }

  assertContains(gatewayOutput, "Hermes Gateway Starting", "Hermes gateway startup probe");
  assertContains(gatewayOutput, "No messaging platforms enabled.", "Hermes gateway startup probe");

  const historyProbe = await runDocker(["history", "--no-trunc", image]);
  assertExitCode(historyProbe, "Hermes image history probe");

  for (const canary of SECRET_HISTORY_CANARIES) {
    if (historyProbe.stdout.includes(canary) || historyProbe.stderr.includes(canary)) {
      throw new Error(`Hermes image history contains forbidden secret marker: ${canary}`);
    }
  }

  const unpackedBytes =
    contract.maxUnpackedBytes === undefined
      ? null
      : await assertImageSizeBudget(image, contract.maxUnpackedBytes);

  return {
    image,
    upstreamImage: contract.source,
    upstreamIndexDigest: contract.sourceDigest,
    amd64ManifestDigest: contract.platformManifestDigest,
    version: contract.version,
    runtimeUser: contract.runtimeUser,
    gatewayStarted: true,
    unpackedBytes,
  };
}

export async function assertImageSizeBudget(image: string, maxBytes: number) {
  assertSafeImageReference(image);
  const sizeProbe = await runDocker(["image", "inspect", "--format", "{{.Size}}", image]);
  assertExitCode(sizeProbe, "Hermes image size probe");

  const rawSize = sizeProbe.stdout.trim();
  if (!/^\d+$/.test(rawSize)) {
    throw new Error(`Docker returned an invalid image size: ${rawSize}`);
  }

  const unpackedBytes = Number.parseInt(rawSize, 10);
  if (!Number.isSafeInteger(unpackedBytes) || unpackedBytes > maxBytes) {
    throw new Error(
      `Hermes image exceeds unpacked size budget: ${unpackedBytes} bytes > ${maxBytes} bytes.`,
    );
  }

  return unpackedBytes;
}

function assertSafeImageReference(image: string) {
  if (!SAFE_IMAGE_REFERENCE_PATTERN.test(image)) {
    throw new Error("BRUNO_HERMES_IMAGE must be a valid container image reference.");
  }
}

async function withPreparedDataDir<T>(
  image: string,
  callback: (dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await mkdtemp(HERMES_DATA_DIR_PREFIX);

  try {
    await chmod(dataDir, 0o777);
    return await callback(dataDir);
  } finally {
    await restorePreparedDataDirOwnership(image, dataDir);
    await removePreparedDataDir(dataDir);
  }
}

export async function removePreparedDataDir(dataDir: string) {
  assertManagedDataDir(dataDir);

  const cleanup = await runCommand("/bin/rm", ["-rf", "--", dataDir]);
  assertExitCode(cleanup, "Hermes prepared data directory cleanup");
}

export function buildPreparedDataDirOwnershipRestoreArgs(
  image: string,
  dataDir: string,
  uid: number,
  gid: number,
) {
  assertSafeImageReference(image);
  assertManagedDataDir(dataDir);

  if (!Number.isSafeInteger(uid) || uid < 0 || !Number.isSafeInteger(gid) || gid < 0) {
    throw new Error("Hermes data directory cleanup requires valid host UID and GID values.");
  }

  return [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "--user",
    "0:0",
    "--entrypoint",
    "/bin/chown",
    "-v",
    `${dataDir}:/opt/data`,
    image,
    "-R",
    "--no-dereference",
    `${uid}:${gid}`,
    "/opt/data",
  ];
}

async function restorePreparedDataDirOwnership(image: string, dataDir: string) {
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") {
    throw new Error("Hermes image smoke requires a POSIX host UID and GID for safe cleanup.");
  }

  const restore = await runDocker(
    buildPreparedDataDirOwnershipRestoreArgs(image, dataDir, process.getuid(), process.getgid()),
  );
  assertExitCode(restore, "Hermes prepared data directory ownership restore");
}

function assertManagedDataDir(dataDir: string) {
  const suffix = dataDir.slice(HERMES_DATA_DIR_PREFIX.length);

  if (!dataDir.startsWith(HERMES_DATA_DIR_PREFIX) || !HERMES_DATA_DIR_SUFFIX_PATTERN.test(suffix)) {
    throw new Error(`Refusing to remove unmanaged Hermes data directory: ${dataDir}`);
  }
}

function assertExitCode(result: CommandResult, label: string) {
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${result.exitCode ?? "unknown"}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function assertContains(output: string, expected: string, label: string) {
  if (!output.includes(expected)) {
    throw new Error(`${label} did not include expected text: ${expected}`);
  }
}

function runDocker(args: string[], options: RunCommandOptions = {}) {
  return runCommand("docker", args, options);
}

async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const child = spawn(command, args, {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;

  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

  const timeout =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, options.timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  if (timeout) {
    clearTimeout(timeout);
  }

  return {
    exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
    timedOut,
  };
}

async function main() {
  const summary = await smokeHermesAgentImage();
  console.log(JSON.stringify({ event: "hermes_agent_image_smoke_passed", ...summary }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
