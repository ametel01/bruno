import "server-only";

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createAppLogger } from "@/src/server/logging/logger";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanCleanupInput,
  type DigitalOceanCreateSshKeyInput,
  type DigitalOceanDiscoverByTagInput,
  type DigitalOceanDiscovery,
  type DigitalOceanFirewallInput,
  type DigitalOceanManagedInventoryInput,
  type DigitalOceanProvider,
  type DigitalOceanProviderRequestContext,
  type DigitalOceanProviderResult,
  type DigitalOceanReadInput,
  type DigitalOceanResource,
  type DigitalOceanRunnerSpec,
  type DigitalOceanSshKey,
  type DigitalOceanTagInput,
} from "@/src/server/runners/digitalocean-provider";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";
import { findDigitalOceanRunnerResourceProfile } from "@/src/server/runners/runner-resource-profiles";

const localDockerProviderLogger = createAppLogger("local_docker.provider");

export const LOCAL_DOCKER_DROPLET_CONTAINER_NAME = "bruno-local-cloud-runner";
const DEFAULT_LOCAL_ENDPOINT_URL = "http://127.0.0.1:3045";
const DEFAULT_LOCAL_START_DELAY_MS = 1_000;
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 30_000;
const LOCAL_DROPLET_IMAGE = "ubuntu:24.04";
export const LOCAL_AGENT_SMOKE_DROPLET_IMAGE = "bruno-local-droplet:ubuntu-24.04";
export const LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH = "/tmp/bruno-local-agent-smoke/images.tar";
const LOCAL_DROPLET_PLATFORM = "linux/amd64";
const LOCAL_HERMES_WORKLOAD_IMAGE = "bruno-hermes:local";
const LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_CONTAINER_PATH = "/opt/bruno/images.tar";
const LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME = "bruno-runner";
const LOCAL_SIMULATED_PUBLIC_IPV4 = "127.0.0.1";
const LOCAL_HOST_BRIDGE_DIR = "/tmp/bruno-local-cloud";

const RUNNER_BOOTSTRAP_FAILURE_REASONS = new Set([
  "not_configured",
  "registration_failed",
  "registration_response_invalid",
  "release_identity_unavailable",
  "heartbeat_failed",
]);

export function localDockerRunnerBootstrapFailureCode(state: string, logs: string): string | null {
  const bootstrapFailure = /bruno runner bootstrap failed: ([a-z_]+)/.exec(logs)?.[1];
  if (bootstrapFailure && RUNNER_BOOTSTRAP_FAILURE_REASONS.has(bootstrapFailure)) {
    return `runner_${bootstrapFailure}`;
  }

  if (/\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo)\b/i.test(logs)) {
    return "runner_callback_dns";
  }
  if (/\b(?:ConnectionRefused|ECONNREFUSED|Failed to connect|Unable to connect)\b/i.test(logs)) {
    return "runner_callback_unreachable";
  }

  if (
    state === "running" &&
    /bruno runner bootstrap completed for runner [0-9a-f-]{36}\./.test(logs)
  ) {
    return "runner_running_after_registration";
  }
  if (state === "running") return "runner_running_without_registration";
  if (state === "restarting" || state === "exited" || state === "dead") {
    return `runner_container_${state}`;
  }
  return null;
}

type DockerRunner = (
  args: readonly string[],
  context?: DigitalOceanProviderRequestContext,
) => Promise<{ stdout: string; stderr: string }>;

export type LocalDockerDigitalOceanProviderOptions = {
  agentSmokeMode?: boolean;
  containerName?: string;
  docker?: DockerRunner;
  endpointUrl?: string;
  now?: () => Date;
  startDelayMs?: number;
};

export class LocalDockerDigitalOceanProvider implements DigitalOceanProvider {
  readonly #containerName: string;
  readonly #agentSmokeMode: boolean;
  readonly #docker: DockerRunner;
  readonly #endpointUrl: string;
  readonly #now: () => Date;
  readonly #resources = new Map<string, DigitalOceanResource>();
  readonly #startDelayMs: number;

  constructor(options: LocalDockerDigitalOceanProviderOptions = {}) {
    this.#agentSmokeMode = options.agentSmokeMode ?? false;
    this.#containerName = options.containerName ?? LOCAL_DOCKER_DROPLET_CONTAINER_NAME;
    this.#docker = options.docker ?? runDocker;
    this.#endpointUrl = options.endpointUrl ?? DEFAULT_LOCAL_ENDPOINT_URL;
    this.#now = options.now ?? (() => new Date());
    this.#startDelayMs = options.startDelayMs ?? DEFAULT_LOCAL_START_DELAY_MS;
  }

  async listSshKeys(
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    if (context?.signal.aborted) return localCancelledResource("ssh_key_lookup_failed");
    return { ok: true, value: [] };
  }

  async createSshKey(
    input: DigitalOceanCreateSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    if (context?.signal.aborted) return localCancelledResource("ssh_key_create_failed");
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
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    if (context?.signal.aborted) {
      return localCancelledResource("create_outcome_unknown");
    }

    const resource = {
      provider: DIGITALOCEAN_PROVIDER,
      providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID,
      providerFirewallId: null,
      providerFirewallName: null,
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

  async discoverResourcesByTag(
    input: DigitalOceanDiscoverByTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    if (context?.signal.aborted) {
      return localCancelledResource("discovery_failed");
    }
    const resources: DigitalOceanResource[] = [];

    for (const resource of this.#resources.values()) {
      if (resource.deletedAt === null && resource.tags.includes(input.tag)) {
        resources.push(cloneResource(resource));
      }
    }

    return {
      ok: true,
      value: {
        authoritative: true,
        resources,
      },
    };
  }

  async listManagedResources(
    input: DigitalOceanManagedInventoryInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    if (context?.signal.aborted) {
      return localCancelledResource("discovery_failed");
    }
    const resources: DigitalOceanResource[] = [];

    for (const resource of this.#resources.values()) {
      if (resource.deletedAt === null && resource.tags.includes(input.stableTag)) {
        resources.push(cloneResource(resource));
      }
    }

    return {
      ok: true,
      value: {
        authoritative: true,
        resources,
      },
    };
  }

  async readResource(
    input: DigitalOceanReadInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    if (context?.signal.aborted) return localCancelledResource("resource_not_found");
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
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    if (context?.signal.aborted) return localCancelledResource("tag_failed");
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    resource.tags = [...new Set([...resource.tags, ...input.tags])].sort();

    return { ok: true, value: cloneResource(resource) };
  }

  async applyFirewall(
    input: DigitalOceanFirewallInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    if (context?.signal.aborted) return localCancelledResource("firewall_failed");
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    resource.firewallApplied = true;
    resource.providerFirewallId ??= `local-docker-firewall-${randomUUID()}`;
    resource.providerFirewallName = input.firewallName;

    return { ok: true, value: cloneResource(resource) };
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return localMissingResource();
    }

    await this.#removeLocalContainers(context);
    resource.deletedAt = this.#now().toISOString();
    resource.firewallApplied = false;
    resource.providerFirewallId = null;
    resource.providerFirewallName = null;

    return { ok: true, value: cloneResource(resource) };
  }

  async diagnoseRunnerBootstrapFailure(): Promise<string | null> {
    let state: string;
    try {
      const inspected = await this.#docker([
        "inspect",
        "--format",
        "{{.State.Status}}",
        LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME,
      ]);
      state = inspected.stdout.trim();
    } catch {
      return null;
    }

    let logs = "";
    try {
      const captured = await this.#docker([
        "logs",
        "--tail",
        "80",
        LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME,
      ]);
      logs = `${captured.stdout}\n${captured.stderr}`;
    } catch {
      // Container state alone still provides a closed diagnostic.
    }

    const failureCode = localDockerRunnerBootstrapFailureCode(state, logs);
    if (failureCode && process.env.NODE_ENV !== "test") {
      localDockerProviderLogger.info("runner_bootstrap_diagnosed", { failureCode });
    }
    return failureCode;
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
        agentSmokeMode: this.#agentSmokeMode,
        localRunnerEndpointUrl: this.#endpointUrl,
      });
      const agentSmokeProfile = this.#agentSmokeMode
        ? findDigitalOceanRunnerResourceProfile(input.sizeSlug)
        : null;
      if (this.#agentSmokeMode && !agentSmokeProfile) {
        throw new Error(`Local agent smoke requires a supported size slug: ${input.sizeSlug}.`);
      }
      const dropletRuntimeArgs = this.#agentSmokeMode
        ? [
            "--cpus",
            String(agentSmokeProfile?.vcpus ?? 1),
            "--memory",
            `${agentSmokeProfile?.memoryMiB ?? 512}m`,
            "--privileged",
            "--cgroupns",
            "host",
            "--volume",
            "/var/lib/docker",
            "--publish",
            "127.0.0.1:3045:3045",
            "--volume",
            `${LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH}:${LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_CONTAINER_PATH}:ro`,
          ]
        : [
            "--cpus",
            "1",
            "--memory",
            "512m",
            "--volume",
            `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
            "--volume",
            `${LOCAL_HOST_BRIDGE_DIR}:${LOCAL_HOST_BRIDGE_DIR}`,
          ];
      await this.#docker([
        "run",
        "--detach",
        "--platform",
        LOCAL_DROPLET_PLATFORM,
        "--name",
        this.#containerName,
        ...dropletRuntimeArgs,
        "--add-host",
        "host.docker.internal:host-gateway",
        "--env",
        `BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64=${Buffer.from(script, "utf8").toString("base64")}`,
        "--env",
        `BRUNO_LOCAL_PUBLIC_IPV4=${LOCAL_SIMULATED_PUBLIC_IPV4}`,
        "--env",
        `BRUNO_LOCAL_RUNNER_ENDPOINT_URL=${this.#endpointUrl}`,
        "--env",
        `BRUNO_LOCAL_HOST_BRIDGE_DIR=${LOCAL_HOST_BRIDGE_DIR}`,
        "--env",
        `DOCKER_DEFAULT_PLATFORM=${LOCAL_DROPLET_PLATFORM}`,
        this.#agentSmokeMode ? LOCAL_AGENT_SMOKE_DROPLET_IMAGE : LOCAL_DROPLET_IMAGE,
        "bash",
        "-lc",
        [
          "set -euo pipefail",
          'printf "%s" "$BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64" | base64 -d > /tmp/bruno-local-cloud-init.sh',
          "chmod 0700 /tmp/bruno-local-cloud-init.sh",
          "/tmp/bruno-local-cloud-init.sh",
          ...(this.#agentSmokeMode ? ["exec tail --follow /dev/null"] : []),
        ].join("; "),
      ]);
      if (process.env.NODE_ENV !== "test") {
        localDockerProviderLogger.info("droplet_bootstrap_started", {
          lifecycle: "droplet_creation",
          containerName: this.#containerName,
          endpointUrl: this.#endpointUrl,
        });
      }
    } catch (error) {
      if (process.env.NODE_ENV !== "test") {
        localDockerProviderLogger.error("droplet_bootstrap_start_failed", error, {
          lifecycle: "droplet_creation",
          containerName: this.#containerName,
        });
      }
    }
  }

  async #removeLocalContainers(context?: DigitalOceanProviderRequestContext): Promise<void> {
    await Promise.all(
      [this.#containerName, LOCAL_PRODUCTION_RUNNER_CONTAINER_NAME].map(async (containerName) => {
        try {
          await this.#docker(
            [
              "rm",
              "--force",
              ...(this.#agentSmokeMode && containerName === this.#containerName
                ? ["--volumes"]
                : []),
              containerName,
            ],
            context,
          );
        } catch (error) {
          if (process.env.NODE_ENV !== "test") {
            localDockerProviderLogger.warn("stale_container_cleanup_skipped", {
              containerName,
              error,
            });
          }
        }
      }),
    );
  }
}

function buildLocalCloudInitScript(
  userData: string,
  options: { agentSmokeMode: boolean; localRunnerEndpointUrl: string },
): string {
  const commands = extractCloudInitRuncmdCommands(userData);
  const commandScripts = commands.flatMap((command, index) => {
    const skippedBootstrapStep = options.agentSmokeMode
      ? localAgentSmokeSkippedBootstrapStep(command)
      : null;
    const scripts = [
      `echo ${shellQuote(`== local cloud-init runcmd ${index + 1}/${commands.length} ==`)}`,
    ];

    if (command.includes("BRUNO_BOOTSTRAP_STEP=runner_container_start")) {
      scripts.push(buildLocalEndpointBridgeScript(options.agentSmokeMode));
    }

    if (isLocalSwapSetup(command)) {
      scripts.push(`echo ${shellQuote("Local cloud simulation skips host swap activation.")}`);
      scripts.push(
        '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Swap setup was skipped by the local cloud simulator." swap_setup',
      );
    } else if (skippedBootstrapStep) {
      scripts.push(
        `/usr/local/bin/bruno-bootstrap-event bootstrapping started ${shellQuote(
          localAgentSmokeSkippedBootstrapStartedMessage(skippedBootstrapStep),
        )} ${skippedBootstrapStep}`,
      );
      scripts.push(`echo ${shellQuote("Local agent smoke uses the prepared Droplet image.")}`);
      scripts.push(
        `/usr/local/bin/bruno-bootstrap-event bootstrapping completed ${shellQuote(
          localAgentSmokeSkippedBootstrapCompletedMessage(skippedBootstrapStep),
        )} ${skippedBootstrapStep}`,
      );
    } else {
      scripts.push(`bash -lc ${shellQuote(command)}`);
    }

    return scripts;
  });

  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    ...(options.agentSmokeMode
      ? []
      : ["apt-get update", "apt-get install -y bash ca-certificates curl gnupg python3"]),
    ...(options.agentSmokeMode
      ? [
          "install -m 0755 -d /var/lib/docker /var/run",
          "rm -f /var/run/docker.sock",
          "dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2 > /var/log/bruno-local-dockerd.log 2>&1 &",
          "for attempt in $(seq 1 90); do /usr/bin/docker info >/dev/null 2>&1 && break; sleep 1; done",
          "/usr/bin/docker info >/dev/null",
          `/usr/bin/docker load --input ${LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_CONTAINER_PATH} >/dev/null`,
          "getent ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }' > /run/bruno-host-gateway",
          "test -s /run/bruno-host-gateway",
        ]
      : []),
    "install -m 0755 -d /usr/local/bin",
    "cat > /usr/local/bin/curl <<'BRUNO_LOCAL_CURL'",
    "#!/usr/bin/env bash",
    'if [[ "$*" == *"169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address"* ]]; then',
    `  printf "%s\\n" "${"$"}{BRUNO_LOCAL_PUBLIC_IPV4:-127.0.0.1}"`,
    "  exit 0",
    "fi",
    'exec /usr/bin/curl "$@"',
    "BRUNO_LOCAL_CURL",
    "chmod 0755 /usr/local/bin/curl",
    ...buildLocalDockerShim(options.agentSmokeMode),
    "cat > /usr/local/bin/systemctl <<'BRUNO_LOCAL_SYSTEMCTL'",
    "#!/usr/bin/env bash",
    'if [[ "$*" == *"enable --now caddy"* ]] && command -v caddy >/dev/null 2>&1; then',
    "  caddy validate --config /etc/caddy/Caddyfile >/var/log/bruno-local-caddy-validate.log 2>&1 || true",
    "fi",
    "exit 0",
    "BRUNO_LOCAL_SYSTEMCTL",
    "chmod 0755 /usr/local/bin/systemctl",
    ...(options.agentSmokeMode
      ? [
          "cat > /usr/local/bin/caddy <<'BRUNO_LOCAL_CADDY'",
          "#!/usr/bin/env bash",
          "exit 0",
          "BRUNO_LOCAL_CADDY",
          "chmod 0755 /usr/local/bin/caddy",
          "install -m 0755 -d /etc/caddy",
        ]
      : []),
    `export BRUNO_LOCAL_RUNNER_ENDPOINT_URL=${shellQuote(options.localRunnerEndpointUrl)}`,
    ...commandScripts,
  ].join("\n");
}

function buildLocalDockerShim(agentSmokeMode: boolean): string[] {
  if (agentSmokeMode) {
    return [
      "cat > /usr/local/bin/docker <<'BRUNO_LOCAL_DOCKER'",
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `if [[ "${"$"}{1:-}" == "pull" && ( "${"$"}{2:-}" == "bruno-runner:local" || "${"$"}{2:-}" == "${LOCAL_HERMES_WORKLOAD_IMAGE}" || "${"$"}{2:-}" == "busybox:1.36" ) ]]; then`,
      '  /usr/bin/docker image inspect "$2" >/dev/null',
      "  exit 0",
      "fi",
      `if [[ "${"$"}{1:-}" == "run" ]]; then`,
      '  host_gateway="$(cat /run/bruno-host-gateway)"',
      `  translated=("run" "--add-host" "host.docker.internal:${"$"}host_gateway")`,
      "  shift",
      '  for arg in "$@"; do',
      '    if [[ "$arg" == "127.0.0.1:3045:3045" ]]; then',
      '      translated+=("0.0.0.0:3045:3045")',
      "    else",
      '      translated+=("$arg")',
      "    fi",
      "  done",
      `  exec /usr/bin/docker "${"$"}{translated[@]}"`,
      "fi",
      'exec /usr/bin/docker "$@"',
      "BRUNO_LOCAL_DOCKER",
      "chmod 0755 /usr/local/bin/docker",
    ];
  }

  return [
    "cat > /usr/local/bin/docker <<'BRUNO_LOCAL_DOCKER'",
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    `if [[ "${"$"}{1:-}" == "pull" && "${"$"}{2:-}" == "bruno-runner:local" ]]; then`,
    '  /usr/bin/docker image inspect "$2" >/dev/null',
    "  exit 0",
    "fi",
    `if [[ "${"$"}{1:-}" == "run" ]]; then`,
    `  bridge_dir="${"$"}{BRUNO_LOCAL_HOST_BRIDGE_DIR:-/tmp/bruno-local-cloud}"`,
    '  mkdir -p "$bridge_dir"',
    '  bridge_env="$bridge_dir/runner.env"',
    "  if [[ -f /etc/bruno/runner.env ]]; then",
    '    cp /etc/bruno/runner.env "$bridge_env"',
    '    sed -i "s#^BRUNO_HERMES_STATE_ROOT=.*#BRUNO_HERMES_STATE_ROOT=$bridge_dir/var/lib/bruno/agents#" "$bridge_env"',
    '    sed -i "s#^BRUNO_RUNNER_BOOT_SELF_TEST_ROOT=.*#BRUNO_RUNNER_BOOT_SELF_TEST_ROOT=$bridge_dir/var/lib/bruno/boot-self-test#" "$bridge_env"',
    "  fi",
    `  host_gateway="${"$"}(getent ahostsv4 host.docker.internal | awk 'NR == 1 { print ${"$"}1 }')"`,
    '  network_name=""',
    '  previous_arg=""',
    '  for arg in "$@"; do',
    '    if [[ "$previous_arg" == "--network" ]]; then',
    '      network_name="$arg"',
    "      break",
    "    fi",
    '    previous_arg="$arg"',
    "  done",
    `  if [[ -n "${"$"}network_name" ]] && ! /usr/bin/docker info --format '{{.OperatingSystem}}' | grep -qi 'Docker Desktop'; then`,
    `    network_gateway="${"$"}(/usr/bin/docker network inspect --format '{{(index .IPAM.Config 0).Gateway}}' "${"$"}network_name")"`,
    `    if [[ -n "${"$"}network_gateway" ]]; then`,
    '      host_gateway="$network_gateway"',
    "    fi",
    "  fi",
    '  test -n "$host_gateway"',
    "  translated=()",
    `  translated+=("run" "--add-host" "host.docker.internal:${"$"}host_gateway")`,
    "  shift",
    '  for arg in "$@"; do',
    '    case "$arg" in',
    "      /etc/bruno/runner.env)",
    '        translated+=("$bridge_env")',
    "        ;;",
    "      /etc/bruno/runner.env:/etc/bruno/runner.env)",
    '        translated+=("$bridge_env:/etc/bruno/runner.env")',
    "        ;;",
    "      /var/lib/bruno/*:/var/lib/bruno/*)",
    `        source_path="${"$"}{arg%%:*}"`,
    `        target_path="${"$"}{arg#*:}"`,
    '        translated_source="$bridge_dir$source_path"',
    '        translated_target="$bridge_dir$target_path"',
    '        mkdir -p "$translated_source"',
    '        translated+=("$translated_source:$translated_target")',
    "        ;;",
    "      *)",
    '        translated+=("$arg")',
    "        ;;",
    "    esac",
    "  done",
    `  exec /usr/bin/docker "${"$"}{translated[@]}"`,
    "fi",
    'exec /usr/bin/docker "$@"',
    "BRUNO_LOCAL_DOCKER",
    "chmod 0755 /usr/local/bin/docker",
  ];
}

function localAgentSmokeSkippedBootstrapStep(
  command: string,
): "docker_apt_repository" | "package_install" | null {
  if (command.includes("BRUNO_BOOTSTRAP_STEP=docker_apt_repository")) {
    return "docker_apt_repository";
  }

  if (command.includes("BRUNO_BOOTSTRAP_STEP=package_install")) {
    return "package_install";
  }

  return null;
}

function localAgentSmokeSkippedBootstrapStartedMessage(
  step: "docker_apt_repository" | "package_install",
): string {
  return step === "docker_apt_repository"
    ? "Configuring Docker apt repository."
    : "Installing cloud runner packages.";
}

function localAgentSmokeSkippedBootstrapCompletedMessage(
  step: "docker_apt_repository" | "package_install",
): string {
  return step === "docker_apt_repository"
    ? "Docker apt repository was already configured in the local smoke image."
    : "Cloud runner packages were already installed in the local smoke image.";
}

function isLocalSwapSetup(command: string): boolean {
  return command.includes("BRUNO_BOOTSTRAP_STEP=swap_setup");
}

function buildLocalEndpointBridgeScript(agentSmokeMode: boolean): string {
  return [
    "if [ ! -f /etc/bruno/runner.env ]; then",
    '  echo "Local cloud-init parity check failed: /etc/bruno/runner.env was not created." >&2',
    "  exit 90",
    "fi",
    "bruno_generated_endpoint=\"$(sed -n 's/^BRUNO_RUNNER_ENDPOINT_URL=//p' /etc/bruno/runner.env | tail -n 1)\"",
    'if [ -z "$bruno_generated_endpoint" ] || [ "$bruno_generated_endpoint" = "https://.sslip.io" ]; then',
    `  echo "Local cloud-init parity check failed: invalid generated endpoint: ${"$"}{bruno_generated_endpoint:-<missing>}" >&2`,
    "  exit 91",
    "fi",
    'echo "Local cloud-init generated production endpoint: $bruno_generated_endpoint"',
    `sed -i "s#^BRUNO_RUNNER_ENDPOINT_URL=.*#BRUNO_RUNNER_ENDPOINT_URL=${"$"}{BRUNO_LOCAL_RUNNER_ENDPOINT_URL}#" /etc/bruno/runner.env`,
    ...(agentSmokeMode
      ? [
          `sed -i "s#^BRUNO_HERMES_WORKLOAD_IMAGE=.*#BRUNO_HERMES_WORKLOAD_IMAGE=${LOCAL_HERMES_WORKLOAD_IMAGE}#" /etc/bruno/runner.env`,
          'printf "%s\\n" "BRUNO_LOCAL_AGENT_SMOKE_MODE=synthetic-external-boundaries" >> /etc/bruno/runner.env',
        ]
      : []),
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

function runDocker(
  args: readonly string[],
  context?: DigitalOceanProviderRequestContext,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      [...args],
      {
        encoding: "utf8",
        ...(context ? { signal: context.signal } : {}),
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

function localCancelledResource(
  reason:
    | "cleanup_failed"
    | "create_outcome_unknown"
    | "discovery_failed"
    | "firewall_failed"
    | "resource_not_found"
    | "ssh_key_create_failed"
    | "ssh_key_lookup_failed"
    | "tag_failed",
): DigitalOceanProviderResult<never> {
  return {
    ok: false,
    reason,
    message: "Local Docker provider action was cancelled before completion.",
  };
}

function cloneResource(resource: DigitalOceanResource): DigitalOceanResource {
  return {
    ...resource,
    tags: [...resource.tags],
  };
}
