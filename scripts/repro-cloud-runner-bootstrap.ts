import { chmodSync, existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildCloudRunnerBootstrapContent } from "@/src/server/runners/cloud-runner-bootstrap";

const REPRO_IMAGE = "bruno-cloud-init-repro:ubuntu-24.04";

type Target = {
  label: string;
  path: string;
};

const options = parseArgs(process.argv.slice(2));
const targets: Target[] = [];
const tempRoot = mkdtempSync(join(tmpdir(), "bruno-cloud-runner-repro-"));

for (const userDataPath of options.userDataPaths) {
  targets.push({
    label: basename(userDataPath),
    path: realpathSync(userDataPath),
  });
}

if (options.generateCurrent || targets.length === 0) {
  const generatedPath = resolve(options.outPath ?? join(tempRoot, "current-user-data.yaml"));
  const content = buildCloudRunnerBootstrapContent({
    appBaseUrl: process.env.BRUNO_REPRO_APP_URL ?? "https://bruno-tau.vercel.app",
    registrationToken:
      process.env.BRUNO_REPRO_REGISTRATION_TOKEN ??
      "bruno_reg_LOCAL_REPRO_123456789012345678901234567890",
    ...(process.env.BRUNO_REPRO_BEARER_TOKEN
      ? { commandBearerToken: process.env.BRUNO_REPRO_BEARER_TOKEN }
      : { commandBearerToken: "local-runner-command-token" }),
    ...(process.env.BRUNO_REPRO_RUNNER_IMAGE
      ? { runnerImage: process.env.BRUNO_REPRO_RUNNER_IMAGE }
      : {}),
    ...(process.env.BRUNO_REPRO_ENDPOINT_URL
      ? { runnerEndpointUrl: process.env.BRUNO_REPRO_ENDPOINT_URL }
      : { endpointDiscovery: { type: "digitalocean_metadata" as const } }),
    enableSwap: process.env.BRUNO_REPRO_ENABLE_SWAP !== "false",
    runnerName: process.env.BRUNO_REPRO_RUNNER_NAME ?? "Bruno Cloud Runner",
  });

  writeFileSync(generatedPath, content.userData, { mode: 0o600 });
  targets.push({ label: "current generated user-data", path: generatedPath });
  console.log(`generated current user-data: ${generatedPath}`);
}

const validatorPath = join(tempRoot, "validate-runcmd.py");
writeFileSync(validatorPath, validatorScript(), { mode: 0o700 });
chmodSync(validatorPath, 0o700);

buildReproImage();

let failures = 0;
for (const target of targets) {
  console.log(`\n== validating ${target.label} ==`);
  const passed = validateUserData(target.path, validatorPath);
  failures += passed ? 0 : 1;
}

if (failures > 0) {
  process.exitCode = 1;
  console.error(`\n${failures} cloud runner repro validation target(s) failed.`);
}

function parseArgs(args: string[]) {
  const userDataPaths: string[] = [];
  let generateCurrent = false;
  let outPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--current") {
      generateCurrent = true;
      continue;
    }

    if (arg === "--user-data") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--user-data requires a path.");
      }
      userDataPaths.push(assertReadablePath(next));
      index += 1;
      continue;
    }

    if (arg === "--out") {
      const next = args[index + 1];
      if (!next) {
        throw new Error("--out requires a path.");
      }
      outPath = next;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { userDataPaths, generateCurrent, outPath };
}

function assertReadablePath(path: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`File does not exist: ${resolved}`);
  }
  return resolved;
}

function buildReproImage() {
  if (process.env.BRUNO_REPRO_REBUILD_IMAGE !== "true") {
    const inspect = spawnSync("docker", ["image", "inspect", REPRO_IMAGE], {
      encoding: "utf8",
      stdio: "ignore",
    });

    if (inspect.status === 0) {
      return;
    }
  }

  const dockerfile = `FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \\
  && apt-get install -y --no-install-recommends bash ca-certificates cloud-init curl gnupg python3 \\
  && rm -rf /var/lib/apt/lists/*
`;

  const result = spawnSync(
    "docker",
    ["build", "--platform", "linux/amd64", "-t", REPRO_IMAGE, "-"],
    {
      input: dockerfile,
      encoding: "utf8",
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  if (result.status !== 0) {
    throw new Error(`Failed to build ${REPRO_IMAGE}.`);
  }
}

function validateUserData(userDataPath: string, validatorPath: string): boolean {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--memory",
      "512m",
      "--cpus",
      "1",
      "-v",
      `${userDataPath}:/tmp/user-data.yaml:ro`,
      "-v",
      `${validatorPath}:/tmp/validate-runcmd.py:ro`,
      REPRO_IMAGE,
      "bash",
      "-lc",
      "set -euo pipefail; cloud-init schema --config-file /tmp/user-data.yaml; python3 /tmp/validate-runcmd.py /tmp/user-data.yaml",
    ],
    { encoding: "utf8", stdio: "inherit" },
  );

  if (result.status !== 0) {
    console.error(`cloud runner repro failed for ${userDataPath}`);
    return false;
  }

  return true;
}

function validatorScript(): string {
  return `#!/usr/bin/env python3
import subprocess
import sys
import yaml

with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = yaml.safe_load(handle)

runcmd = data.get("runcmd")
if not isinstance(runcmd, list):
    raise SystemExit("runcmd is missing or is not a list")

checked = 0
for index, item in enumerate(runcmd):
    script = None
    if isinstance(item, list):
        if len(item) >= 3 and item[0] == "bash" and "-lc" in item:
            script = item[-1]
    elif isinstance(item, str):
        if "pipefail" in item:
            raise SystemExit(
                f"runcmd[{index}] is a shell string containing pipefail; cloud-init runs string commands with /bin/sh"
            )
        script = item

    if not isinstance(script, str) or not script.strip():
        continue

    result = subprocess.run(["bash", "-n"], input=script, text=True, capture_output=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"bash syntax check failed for runcmd[{index}]")
    checked += 1

print(f"runcmd bash syntax OK ({checked} script blocks checked)")
`;
}

function printHelp() {
  console.log(`Usage:
  bun run repro:cloud-runner
  bun run repro:cloud-runner -- --current --out /tmp/current-user-data.yaml
  bun run repro:cloud-runner -- --user-data /path/to/metadata_v1_user-data

Environment for --current:
  BRUNO_REPRO_APP_URL
  BRUNO_REPRO_REGISTRATION_TOKEN
  BRUNO_REPRO_BEARER_TOKEN
  BRUNO_REPRO_RUNNER_IMAGE
  BRUNO_REPRO_ENDPOINT_URL
  BRUNO_REPRO_ENABLE_SWAP=false
  BRUNO_REPRO_RUNNER_NAME
`);
}
