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
const DEFAULT_LOCAL_RUNNER_PORT = "3045";
const DOCKER_SOCKET = "/var/run/docker.sock";
const DOCKER_TIMEOUT_MS = 30_000;

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

    await this.#removeContainer();
    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }

  #scheduleRunnerStart(input: DigitalOceanRunnerSpec): void {
    const bootstrapEnv = parseBootstrapEnv(input.userData ?? "");

    setTimeout(() => {
      void this.#startRunnerContainer(input, bootstrapEnv);
    }, this.#startDelayMs);
  }

  async #startRunnerContainer(
    input: DigitalOceanRunnerSpec,
    bootstrapEnv: Record<string, string>,
  ): Promise<void> {
    try {
      await this.#removeContainer();
      await this.#docker([
        "run",
        "--detach",
        "--name",
        this.#containerName,
        "--restart",
        "unless-stopped",
        "--cpus",
        "1",
        "--memory",
        "512m",
        "-p",
        `${endpointHostPort(this.#endpointUrl)}:${DEFAULT_LOCAL_RUNNER_PORT}`,
        "-v",
        `${DOCKER_SOCKET}:${DOCKER_SOCKET}`,
        "--env",
        `AGENTBAY_APP_URL=${requiredBootstrapValue(bootstrapEnv, "AGENTBAY_APP_URL")}`,
        "--env",
        `AGENTBAY_RUNNER_REGISTRATION_TOKEN=${requiredBootstrapValue(
          bootstrapEnv,
          "AGENTBAY_RUNNER_REGISTRATION_TOKEN",
        )}`,
        "--env",
        `AGENTBAY_RUNNER_ENDPOINT_URL=${this.#endpointUrl}`,
        "--env",
        `AGENTBAY_RUNNER_NAME=${input.name}`,
        "--env",
        `AGENTBAY_RUNNER_IMAGE=${requiredBootstrapValue(bootstrapEnv, "AGENTBAY_RUNNER_IMAGE")}`,
        "--env",
        "AGENTBAY_RUNNER_ENV_FILE=/tmp/agentbay-runner.env",
        "--env",
        `AGENTBAY_RUNNER_BEARER_TOKEN=${requiredBootstrapValue(
          bootstrapEnv,
          "AGENTBAY_RUNNER_BEARER_TOKEN",
        )}`,
        "--env",
        "AGENTBAY_RUNNER_HOST=0.0.0.0",
        "--env",
        `AGENTBAY_RUNNER_PORT=${DEFAULT_LOCAL_RUNNER_PORT}`,
        "--env",
        "AGENTBAY_RUNNER_HEARTBEAT_INTERVAL_MS=1000",
        requiredBootstrapValue(bootstrapEnv, "AGENTBAY_RUNNER_IMAGE"),
      ]);
      console.info("[agentbay] local_docker_provider", {
        event: "runner_container_started",
        containerName: this.#containerName,
        endpointUrl: this.#endpointUrl,
      });
    } catch (error) {
      console.error("[agentbay] local_docker_provider", {
        event: "runner_container_start_failed",
        containerName: this.#containerName,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async #removeContainer(): Promise<void> {
    try {
      await this.#docker(["rm", "--force", this.#containerName]);
    } catch {
      // Missing local containers should not block a fresh local provisioning run.
    }
  }
}

function parseBootstrapEnv(userData: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of [
    "AGENTBAY_APP_URL",
    "AGENTBAY_RUNNER_REGISTRATION_TOKEN",
    "AGENTBAY_RUNNER_IMAGE",
    "AGENTBAY_RUNNER_BEARER_TOKEN",
  ]) {
    const value = readAssignment(userData, key);

    if (value) {
      env[key] = value;
    }
  }

  return env;
}

function readAssignment(content: string, key: string): string | null {
  const match = new RegExp(`^\\s*${key}=([^\\n]+)$`, "m").exec(content);
  const rawValue = match?.[1]?.trim();

  if (!rawValue) {
    return null;
  }

  if (
    (rawValue.startsWith("'") && rawValue.endsWith("'")) ||
    (rawValue.startsWith('"') && rawValue.endsWith('"'))
  ) {
    return rawValue.slice(1, -1);
  }

  return rawValue;
}

function requiredBootstrapValue(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();

  if (!value) {
    throw new Error(`Local Docker provider could not resolve ${key} from cloud runner user-data.`);
  }

  return value;
}

function endpointHostPort(endpointUrl: string): string {
  const parsed = new URL(endpointUrl);
  const port = parsed.port || DEFAULT_LOCAL_RUNNER_PORT;
  const bindHost = parsed.hostname === "host.docker.internal" ? "0.0.0.0" : parsed.hostname;

  return `${bindHost}:${port}`;
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
