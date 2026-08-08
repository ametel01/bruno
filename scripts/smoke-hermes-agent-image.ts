import { spawn } from "node:child_process";
import { mkdtemp, rm, chmod } from "node:fs/promises";
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

const SAFE_IMAGE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
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
  assertContains(versionProbe.stdout, HERMES_VERSION_FRAGMENT, "Hermes version probe");
  assertContains(versionProbe.stdout, "hermes:x:10000:10000", "Hermes passwd probe");
  assertContains(versionProbe.stdout, "10000:10000 700 /opt/data", "Hermes data ownership probe");

  await withPreparedDataDir(async (dataDir) => {
    const writeProbe = await runDocker([
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--user",
      HERMES_RUNTIME_UID_GID,
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

  const gatewayProbe = await withPreparedDataDir((dataDir) =>
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

  return {
    image,
    upstreamImage: HERMES_UPSTREAM_IMAGE,
    upstreamIndexDigest: HERMES_UPSTREAM_INDEX_DIGEST,
    amd64ManifestDigest: HERMES_AMD64_MANIFEST_DIGEST,
    version: HERMES_VERSION_FRAGMENT,
    runtimeUser: HERMES_RUNTIME_UID_GID,
    gatewayStarted: true,
  };
}

function assertSafeImageReference(image: string) {
  if (!SAFE_IMAGE_REFERENCE_PATTERN.test(image)) {
    throw new Error("BRUNO_HERMES_IMAGE must be a valid container image reference.");
  }
}

async function withPreparedDataDir<T>(callback: (dataDir: string) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "bruno-hermes-data-"));

  try {
    await chmod(dataDir, 0o777);
    return await callback(dataDir);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
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
