import "server-only";

import { execFile } from "node:child_process";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanCleanupInput,
  type DigitalOceanCreateSshKeyInput,
  type DigitalOceanFirewallInput,
  type DigitalOceanProvider,
  type DigitalOceanProviderResult,
  type DigitalOceanReadInput,
  type DigitalOceanResource,
  type DigitalOceanRunnerSpec,
  type DigitalOceanSshKey,
  type DigitalOceanTagInput,
} from "@/src/server/runners/digitalocean-provider";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";

const DEFAULT_LOCAL_CONTAINER_NAME = "agentbay-local-cloud-runner";
const DEFAULT_LOCAL_ENDPOINT_URL = "http://127.0.0.1:3045";
const DEFAULT_LOCAL_START_DELAY_MS = 1_000;
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 30_000;
const LOCAL_DROPLET_IMAGE = "ubuntu:24.04";
const LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME = "agentbay-runner";
const LOCAL_SIMULATED_PUBLIC_IPV4 = "127.0.0.1";

type DockerRunner = (args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export type LocalDockerDigitalOceanProviderOptions = {
  containerName?: string;
  docker?: DockerRunner;
  endpointUrl?: string;
  now?: () => Date;
  startDelayMs?: number;
};

export class LocalDockerDigitalOceanProvider implements DigitalOceanProvider {
  readonly #containerName: string;
  readonly #docker: DockerRunner;
  readonly #endpointUrl: string;
  readonly #now: () => Date;
  readonly #resources = new Map<string, DigitalOceanResource>();
  readonly #startDelayMs: number;

  constructor(options: LocalDockerDigitalOceanProviderOptions = {}) {
    this.#containerName = options.containerName ?? DEFAULT_LOCAL_CONTAINER_NAME;
    this.#docker = options.docker ?? runDocker;
    this.#endpointUrl = options.endpointUrl ?? DEFAULT_LOCAL_ENDPOINT_URL;
    this.#now = options.now ?? (() => new Date());
    this.#startDelayMs = options.startDelayMs ?? DEFAULT_LOCAL_START_DELAY_MS;
  }

  async listSshKeys(): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    return { ok: true, value: [] };
  }

  async createSshKey(
    input: DigitalOceanCreateSshKeyInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    return {
      ok: true,
      value: {
        id: "local-docker-ssh-key",
        name: input.name,
        fingerprint: null,
      },
    };
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = {
      provider: DIGITALOCEAN_PROVIDER,
      providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID,
      publicIpv4: null,
      publicEndpointUrl: this.#endpointUrl,
      name: input.name,
      region: input.region,
      sizeSlug: input.sizeSlug,
      image: input.image,
      tags: [...new Set(input.tags)].sort(),
      firewallApplied: false,
      createdAt: this.#now().toISOString(),
      deletedAt: null,
    } satisfies DigitalOceanResource;

    this.#resources.set(resource.providerResourceId, resource);

    if (input.userData) {
      this.#scheduleRunnerStart(input);
    }

    return { ok: true, value: cloneResource(resource) };
  }

  async readResource(
    input: DigitalOceanReadInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    return resource
      ? { ok: true, value: cloneResource(resource) }
      : {
          ok: false,
          reason: "resource_not_found",
          message: "Local Docker runner resource was not found.",
        };
  }

  async tagResource(
    input: DigitalOceanTagInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    resource.tags = [...new Set([...resource.tags, ...input.tags])].sort();

    return { ok: true, value: cloneResource(resource) };
  }

  async applyFirewall(
    input: DigitalOceanFirewallInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    resource.firewallApplied = true;

    return { ok: true, value: cloneResource(resource) };
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    await this.#removeLocalContainers();
    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }

  #scheduleRunnerStart(input: DigitalOceanRunnerSpec): void {
    setTimeout(() => {
      void this.#startDropletBootstrap(input);
    }, this.#startDelayMs);
  }

  async #startDropletBootstrap(input: DigitalOceanRunnerSpec): Promise<void> {
    try {
      await this.#removeLocalContainers();
      const script = buildLocalCloudInitScript(input.userData ?? "", {
        localRunnerEndpointUrl: this.#endpointUrl,
      });
      await this.#docker([
        "run",
        "--detach",
        "--name",
        this.#containerName,
        "--cpus",
        "1",
        "--memory",
        "512m",
        "-v",
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `AGENTBAY_LOCAL_CLOUD_INIT_SCRIPT_B64=${Buffer.from(script, "utf8").toString("base64")}`,
        "--env",
        `AGENTBAY_LOCAL_PUBLIC_IPV4=${LOCAL_SIMULATED_PUBLIC_IPV4}`,
        "--env",
        `AGENTBAY_LOCAL_RUNNER_ENDPOINT_URL=${this.#endpointUrl}`,
        LOCAL_DROPLET_IMAGE,
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          'printf "%s" "$AGENTBAY_LOCAL_CLOUD_INIT_SCRIPT_B64" | base64 -d > /tmp/agentbay-local-cloud-init.sh',
          "chmod 0700 /tmp/agentbay-local-cloud-init.sh",
          "/tmp/agentbay-local-cloud-init.sh",
        ].join("; "),
      ]);
      console.info("[agentbay] local_docker_provider", {
        event: "droplet_bootstrap_started",
        containerName: this.#containerName,
        endpointUrl: this.#endpointUrl,
      });
    } catch (error) {
      console.error("[agentbay] local_docker_provider", {
        event: "droplet_bootstrap_start_failed",
        containerName: this.#containerName,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #removeLocalContainers(): Promise<void> {
    for (const containerName of [this.#containerName, LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME]) {
      try {
        await this.#docker(["rm", "--force", containerName]);
      } catch {
        // Missing local containers should not block a fresh local provisioning run.
      }
    }
  }
}

function buildLocalCloudInitScript(
  userData: string,
  options: { localRunnerEndpointUrl: string },
): string {
  const commands = extractCloudInitRuncmdCommands(userData);
  const commandScripts = commands.flatMap((command, index) => {
    const scripts = [
      `echo ${shellQuote(`== local cloud-init runcmd ${index + 1}/${commands.length} ==`)}`,
    ];

    if (command.includes("AGENTBAY_BOOTSTRAP_STEP=docker_container_start")) {
      scripts.push(buildLocalEndpointBridgeScript());
    }

    scripts.push(`bash -lc ${shellQuote(command)}`);

    return scripts;
  });

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    "apt-get update",
    "apt-get install -y bash ca-certificates curl gnupg python3",
    "install -m 0755 -d /usr/local/bin",
    "cat > /usr/local/bin/curl <<'AGENTBAY_LOCAL_CURL'",
    "#!/usr/bin/env bash",
    'if [[ "$*" == *"169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address"* ]]; then',
    `  printf "%s\\n" "${"$"}{AGENTBAY_LOCAL_PUBLIC_IPV4:-127.0.0.1}"`,
    "  exit 0",
    "fi",
    'exec /usr/bin/curl "$@"',
    "AGENTBAY_LOCAL_CURL",
    "chmod 0755 /usr/local/bin/curl",
    "cat > /usr/local/bin/docker <<'AGENTBAY_LOCAL_DOCKER'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `if [[ "${"$"}{1:-}" == "pull" && "${"$"}{2:-}" == "agentbay-runner:local" ]]; then`,
    '  /usr/bin/docker image inspect "$2" >/dev/null',
    "  exit 0",
    "fi",
    'exec /usr/bin/docker "$@"',
    "AGENTBAY_LOCAL_DOCKER",
    "chmod 0755 /usr/local/bin/docker",
    "cat > /usr/local/bin/systemctl <<'AGENTBAY_LOCAL_SYSTEMCTL'",
    "#!/usr/bin/env bash",
    'if [[ "$*" == *"enable --now caddy"* ]] && command -v caddy >/dev/null 2>&1; then',
    "  caddy validate --config /etc/caddy/Caddyfile >/var/log/agentbay-local-caddy-validate.log 2>&1 || true",
    "fi",
    "exit 0",
    "AGENTBAY_LOCAL_SYSTEMCTL",
    "chmod 0755 /usr/local/bin/systemctl",
    `export AGENTBAY_LOCAL_RUNNER_ENDPOINT_URL=${shellQuote(options.localRunnerEndpointUrl)}`,
    ...commandScripts,
  ].join("\n");
}

function buildLocalEndpointBridgeScript(): string {
  return [
    "if [ ! -f /etc/agentbay/runner.env ]; then",
    '  echo "Local cloud-init parity check failed: /etc/agentbay/runner.env was not created." >&2',
    "  exit 90",
    "fi",
    "agentbay_generated_endpoint=\"$(sed -n 's/^AGENTBAY_RUNNER_ENDPOINT_URL=//p' /etc/agentbay/runner.env | tail -n 1)\"",
    'if [ -z "$agentbay_generated_endpoint" ] || [ "$agentbay_generated_endpoint" = "https://.sslip.io" ]; then',
    `  echo "Local cloud-init parity check failed: invalid generated endpoint: ${"$"}{agentbay_generated_endpoint:-<missing>}" >&2`,
    "  exit 91",
    "fi",
    'echo "Local cloud-init generated production endpoint: $agentbay_generated_endpoint"',
    `sed -i "s#^AGENTBAY_RUNNER_ENDPOINT_URL=.*#AGENTBAY_RUNNER_ENDPOINT_URL=${"$"}{AGENTBAY_LOCAL_RUNNER_ENDPOINT_URL}#" /etc/agentbay/runner.env`,
  ].join("\n");
}

function extractCloudInitRuncmdCommands(userData: string): string[] {
  const lines = userData.split(/\r?\n/);
  const runcmdIndex = lines.indexOf("runcmd:");

  if (runcmdIndex === -1) {
    throw new Error("Local Docker provider could not find runcmd in cloud runner user-data.");
  }

  const commands: string[] = [];
  let index = runcmdIndex + 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    if (line.startsWith("  - ")) {
      commands.push(line.slice(4));
      index += 1;
      continue;
    }

    if (line !== "  -") {
      index += 1;
      continue;
    }

    const pipeIndex = findNextPipeBlockLine(lines, index + 1);

    if (pipeIndex === -1) {
      index += 1;
      continue;
    }

    const blockLines: string[] = [];
    index = pipeIndex + 1;

    while (index < lines.length) {
      const blockLine = lines[index] ?? "";

      if (blockLine.startsWith("  -")) {
        break;
      }

      blockLines.push(blockLine.startsWith("      ") ? blockLine.slice(6) : blockLine.trimEnd());
      index += 1;
    }

    commands.push(blockLines.join("\n").trimEnd());
  }

  if (commands.length === 0) {
    throw new Error("Local Docker provider could not extract cloud runner user-data commands.");
  }

  return commands;
}

function findNextPipeBlockLine(lines: string[], startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line === "    - |") {
      return index;
    }

    if (line.startsWith("  -")) {
      return -1;
    }
  }

  return -1;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function runDocker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        timeout: DOCKER_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

function localMissingResource(): DigitalOceanProviderResult<DigitalOceanResource> {
  return {
    ok: false,
    reason: "resource_not_found",
    message: "Local Docker runner resource was not found.",
  };
}

function cloneResource(resource: DigitalOceanResource): DigitalOceanResource {
  return {
    ...resource,
    tags: [...resource.tags],
  };
}
