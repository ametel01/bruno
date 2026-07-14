import "server-only";

import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_MANUAL_RUNNER_IMAGE,
} from "@/src/runner-service/constants";
import { DEFAULT_AGENTBAY_RUNNER_IMAGE } from "@/src/server/env";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import { markCloudRunnerBootstrapInjected } from "@/src/server/runners/runner-provisioning-events";

export const DEFAULT_CLOUD_RUNNER_ENV_FILE = "/etc/agentbay/runner.env";
export const DEFAULT_CLOUD_RUNNER_HOST = "127.0.0.1";
export const DEFAULT_CLOUD_RUNNER_CONTAINER_HOST = "0.0.0.0";
export const DEFAULT_CLOUD_RUNNER_PORT = 3045;
export const DEFAULT_CLOUD_RUNNER_CONTAINER_NAME = "agentbay-runner";
export const DEFAULT_CLOUD_RUNNER_NAME = "plingpling Cloud Runner";
export const DEFAULT_CLOUD_RUNNER_DOCKER_SOCKET = "/var/run/docker.sock";
export const BOOTSTRAP_REDACTION = "[redacted]";

type CloudRunnerBootstrapInput = {
  appBaseUrl: string;
  registrationToken: string;
  commandBearerToken?: string;
  runnerEndpointUrl?: string;
  endpointDiscovery?: {
    type: "digitalocean_metadata";
    hostnameSuffix?: string;
  };
  enableSwap?: boolean;
  runnerName?: string;
  runnerImage?: string;
  hermesWorkloadImage?: string;
  hermesStateRoot?: string;
  hermesPrivateNetwork?: string;
  hermesReadinessTimeoutMs?: number;
  runnerMaxAgents?: number;
  envFilePath?: string;
  runnerHost?: string;
  runnerPort?: number;
};

export type CloudRunnerBootstrapContent = {
  userData: string;
  safeSummary: {
    appBaseUrl: string;
    runnerEndpointUrl: string;
    runnerName: string;
    runnerImage: string;
    hermesWorkloadImage: string;
    hermesStateRoot: string;
    hermesPrivateNetwork: string;
    hermesReadinessTimeoutMs: number;
    runnerMaxAgents: number;
    envFilePath: string;
    registrationToken: typeof BOOTSTRAP_REDACTION;
  };
};

export async function buildCloudRunnerBootstrapForRunner(
  input: CloudRunnerBootstrapInput & {
    runnerId: string;
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  },
): Promise<CloudRunnerBootstrapContent> {
  const content = buildCloudRunnerBootstrapContent(input);
  const connection = input.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !input.createConnection;
  const now = input.now?.() ?? new Date();

  try {
    await connection.db.transaction((tx) =>
      markCloudRunnerBootstrapInjected(tx, {
        runnerId: input.runnerId,
        now,
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          appBaseUrl: content.safeSummary.appBaseUrl,
          runnerEndpointUrl: content.safeSummary.runnerEndpointUrl,
          runnerImage: content.safeSummary.runnerImage,
          hermesWorkloadImage: content.safeSummary.hermesWorkloadImage,
          hermesStateRoot: content.safeSummary.hermesStateRoot,
          hermesPrivateNetwork: content.safeSummary.hermesPrivateNetwork,
          hermesReadinessTimeoutMs: content.safeSummary.hermesReadinessTimeoutMs,
          runnerMaxAgents: content.safeSummary.runnerMaxAgents,
        },
      }),
    );
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }

  return content;
}

export function buildCloudRunnerBootstrapContent(
  input: CloudRunnerBootstrapInput,
): CloudRunnerBootstrapContent {
  const config = normalizeBootstrapInput(input);
  const endpoint = buildEndpointConfig(config);
  const swapCommands = config.enableSwap ? buildSwapCommands() : "";
  const bootstrapEventScript = buildBootstrapEventScript(config);
  const envLines = [
    `AGENTBAY_APP_URL=${escapeDockerEnvHereDocValue(config.appBaseUrl)}`,
    `AGENTBAY_RUNNER_REGISTRATION_TOKEN=${escapeDockerEnvHereDocValue(config.registrationToken)}`,
    `AGENTBAY_RUNNER_ENDPOINT_URL=${endpoint.envValue}`,
    `AGENTBAY_RUNNER_NAME=${escapeDockerEnvHereDocValue(config.runnerName)}`,
    `AGENTBAY_RUNNER_IMAGE=${escapeDockerEnvHereDocValue(config.runnerImage)}`,
    `AGENTBAY_DOCKER_RUNNER_IMAGE=${escapeDockerEnvHereDocValue(config.agentImage)}`,
    `AGENTBAY_HERMES_WORKLOAD_IMAGE=${escapeDockerEnvHereDocValue(config.hermesWorkloadImage)}`,
    `AGENTBAY_HERMES_STATE_ROOT=${escapeDockerEnvHereDocValue(config.hermesStateRoot)}`,
    `AGENTBAY_HERMES_PRIVATE_NETWORK=${escapeDockerEnvHereDocValue(config.hermesPrivateNetwork)}`,
    `AGENTBAY_HERMES_READINESS_TIMEOUT_MS=${config.hermesReadinessTimeoutMs}`,
    `AGENTBAY_RUNNER_ENV_FILE=${escapeDockerEnvHereDocValue(config.containerEnvFilePath)}`,
    `AGENTBAY_RUNNER_MAX_AGENTS=${config.runnerMaxAgents}`,
    ...(config.commandBearerToken
      ? [`AGENTBAY_RUNNER_BEARER_TOKEN=${escapeDockerEnvHereDocValue(config.commandBearerToken)}`]
      : []),
    `AGENTBAY_RUNNER_HOST=${escapeDockerEnvHereDocValue(config.runnerContainerHost)}`,
    `AGENTBAY_RUNNER_PORT=${config.runnerPort}`,
  ].join("\n");
  const endpointDiscoveryCommands =
    endpoint.discoveryCommands.length > 0
      ? `${endpoint.discoveryCommands.join("\n      ")}\n      `
      : "";
  const userData = `#cloud-config
package_update: true
package_upgrade: false
output:
  all: '| tee -a /var/log/agentbay-bootstrap.log'
packages:
  - bash
  - ca-certificates
  - curl
  - gnupg
  - python3
runcmd:
  -
    - bash
    - -lc
    - |
      set -euo pipefail
      touch /var/log/agentbay-bootstrap.log
      chmod 0600 /var/log/agentbay-bootstrap.log
      sed 's/^    //' > /usr/local/bin/agentbay-bootstrap-event <<'AGENTBAY_BOOTSTRAP_EVENT_SCRIPT'
      ${indentYamlBlock(indentHereDoc(bootstrapEventScript))}
      AGENTBAY_BOOTSTRAP_EVENT_SCRIPT
      chmod 0700 /usr/local/bin/agentbay-bootstrap-event
      /usr/local/bin/agentbay-bootstrap-event bootstrapping started "Cloud runner bootstrap started." bootstrap_started
  -
    - bash
    - -lc
    - |
      set -euxo pipefail
      AGENTBAY_BOOTSTRAP_STEP=docker_apt_repository
      trap 'agentbay_bootstrap_exit=$?; agentbay_bootstrap_detail="$(tail -n 80 /var/log/agentbay-bootstrap.log || true)"; /usr/local/bin/agentbay-bootstrap-event bootstrapping failed "Cloud runner bootstrap failed during \${AGENTBAY_BOOTSTRAP_STEP}." "\${AGENTBAY_BOOTSTRAP_STEP}" "$agentbay_bootstrap_exit" "$agentbay_bootstrap_detail"' ERR
      install -m 0755 -d /etc/apt/keyrings
      curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
      chmod a+r /etc/apt/keyrings/docker.gpg
      sh -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list'
      apt-get update
      /usr/local/bin/agentbay-bootstrap-event bootstrapping completed "Docker apt repository was configured." docker_apt_repository
${swapCommands}  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - apt-get install -y caddy
  - systemctl enable --now docker
  - install -m 0700 -d ${shellQuote(dirname(config.envFilePath))}
  -
    - bash
    - -lc
    - |
      ${endpointDiscoveryCommands}sed 's/^    //' > /etc/caddy/Caddyfile <<AGENTBAY_CADDYFILE
      ${endpoint.caddyHost} {
        reverse_proxy ${config.runnerHost}:${config.runnerPort}
      }
      AGENTBAY_CADDYFILE
      caddy validate --config /etc/caddy/Caddyfile
      systemctl enable --now caddy
      systemctl reload caddy || systemctl restart caddy
  -
    - bash
    - -lc
    - |
      /usr/local/bin/agentbay-bootstrap-event bootstrapping completed "Caddy reverse proxy was configured." caddy_configured
      ${endpointDiscoveryCommands}sed 's/^    //' > ${shellQuote(config.envFilePath)} <<AGENTBAY_RUNNER_ENV
      ${indentYamlBlock(indentHereDoc(envLines))}
      AGENTBAY_RUNNER_ENV
  - chmod 0600 ${shellQuote(config.envFilePath)}
  -
    - bash
    - -lc
    - |
      set -euxo pipefail
      AGENTBAY_BOOTSTRAP_STEP=hermes_state_root
      trap 'agentbay_bootstrap_exit=$?; agentbay_bootstrap_detail="$(tail -n 80 /var/log/agentbay-bootstrap.log || true)"; /usr/local/bin/agentbay-bootstrap-event bootstrapping failed "Cloud runner bootstrap failed during \${AGENTBAY_BOOTSTRAP_STEP}." "\${AGENTBAY_BOOTSTRAP_STEP}" "$agentbay_bootstrap_exit" "$agentbay_bootstrap_detail"' ERR
      install -m 0710 -d ${shellQuote(config.hermesStateRoot)}
      /usr/local/bin/agentbay-bootstrap-event bootstrapping completed "Hermes state root was prepared." hermes_state_root
  -
    - bash
    - -lc
    - |
      set -euxo pipefail
      AGENTBAY_BOOTSTRAP_STEP=hermes_private_network
      trap 'agentbay_bootstrap_exit=$?; agentbay_bootstrap_detail="$(tail -n 80 /var/log/agentbay-bootstrap.log || true; docker network inspect ${shellQuote(config.hermesPrivateNetwork)} 2>&1 || true)"; /usr/local/bin/agentbay-bootstrap-event bootstrapping failed "Cloud runner bootstrap failed during \${AGENTBAY_BOOTSTRAP_STEP}." "\${AGENTBAY_BOOTSTRAP_STEP}" "$agentbay_bootstrap_exit" "$agentbay_bootstrap_detail"' ERR
      docker network inspect ${shellQuote(config.hermesPrivateNetwork)} >/dev/null 2>&1 || docker network create ${shellQuote(config.hermesPrivateNetwork)}
      /usr/local/bin/agentbay-bootstrap-event bootstrapping completed "Hermes private network was prepared." hermes_private_network
  -
    - bash
    - -lc
    - |
      set -euxo pipefail
      AGENTBAY_BOOTSTRAP_STEP=docker_container_start
      trap 'agentbay_bootstrap_exit=$?; agentbay_bootstrap_detail="$(tail -n 80 /var/log/agentbay-bootstrap.log || true; docker logs --tail 80 ${shellQuote(DEFAULT_CLOUD_RUNNER_CONTAINER_NAME)} 2>&1 || true)"; /usr/local/bin/agentbay-bootstrap-event bootstrapping failed "Cloud runner bootstrap failed during \${AGENTBAY_BOOTSTRAP_STEP}." "\${AGENTBAY_BOOTSTRAP_STEP}" "$agentbay_bootstrap_exit" "$agentbay_bootstrap_detail"' ERR
      /usr/local/bin/agentbay-bootstrap-event bootstrapping started "Pulling cloud runner image." docker_pull
      docker pull ${shellQuote(config.runnerImage)}
      /usr/local/bin/agentbay-bootstrap-event bootstrapping started "Pulling default agent container image." agent_image_pull
      docker pull ${shellQuote(config.agentImage)}
      /usr/local/bin/agentbay-bootstrap-event bootstrapping started "Pulling Hermes workload image." hermes_image_pull
      docker pull ${shellQuote(config.hermesWorkloadImage)}
      docker rm --force ${shellQuote(DEFAULT_CLOUD_RUNNER_CONTAINER_NAME)} || true
      docker run --detach --name ${shellQuote(DEFAULT_CLOUD_RUNNER_CONTAINER_NAME)} --restart always --network ${shellQuote(config.hermesPrivateNetwork)} --env-file ${shellQuote(config.envFilePath)} -v ${shellQuote(`${config.envFilePath}:${config.containerEnvFilePath}`)} -v ${shellQuote(`${config.hermesStateRoot}:${config.hermesStateRoot}`)} -v ${shellQuote(`${DEFAULT_CLOUD_RUNNER_DOCKER_SOCKET}:${DEFAULT_CLOUD_RUNNER_DOCKER_SOCKET}`)} -p ${shellQuote(`${config.runnerHost}:${config.runnerPort}:${config.runnerPort}`)} ${shellQuote(config.runnerImage)}
      /usr/local/bin/agentbay-bootstrap-event waiting_for_runner started "Runner container started; waiting for registration and heartbeat." docker_container_started
`;

  return {
    userData,
    safeSummary: {
      appBaseUrl: config.appBaseUrl,
      runnerEndpointUrl: endpoint.safeSummary,
      runnerName: config.runnerName,
      runnerImage: config.runnerImage,
      hermesWorkloadImage: config.hermesWorkloadImage,
      hermesStateRoot: config.hermesStateRoot,
      hermesPrivateNetwork: config.hermesPrivateNetwork,
      hermesReadinessTimeoutMs: config.hermesReadinessTimeoutMs,
      runnerMaxAgents: config.runnerMaxAgents,
      envFilePath: config.envFilePath,
      registrationToken: BOOTSTRAP_REDACTION,
    },
  };
}

export function redactCloudRunnerBootstrapOutput(value: string): string {
  return value
    .replace(/dop_v1_[A-Za-z0-9_-]+/g, BOOTSTRAP_REDACTION)
    .replace(/agb_reg_[A-Za-z0-9_-]+/g, BOOTSTRAP_REDACTION)
    .replace(/agb_run_[A-Za-z0-9_-]+/g, BOOTSTRAP_REDACTION)
    .replace(/(AGENTBAY_DIGITALOCEAN_TOKEN=)[^\s'"]+/g, `$1${BOOTSTRAP_REDACTION}`)
    .replace(/(AGENTBAY_RUNNER_REGISTRATION_TOKEN=)[^\n]+/g, `$1${BOOTSTRAP_REDACTION}`)
    .replace(/(AGENTBAY_RUNNER_BEARER_TOKEN=)[^\n]+/g, `$1${BOOTSTRAP_REDACTION}`)
    .replace(/(AGENTBAY_RUNNER_CREDENTIAL=)[^\n]+/g, `$1${BOOTSTRAP_REDACTION}`);
}

function normalizeBootstrapInput(input: CloudRunnerBootstrapInput) {
  return {
    appBaseUrl: normalizeUrl(input.appBaseUrl, "appBaseUrl"),
    registrationToken: requireNonEmpty(input.registrationToken, "registrationToken"),
    commandBearerToken: input.commandBearerToken?.trim() || null,
    runnerEndpointUrl: input.runnerEndpointUrl
      ? normalizePublicHttpsUrl(input.runnerEndpointUrl, "runnerEndpointUrl")
      : null,
    endpointDiscovery: input.endpointDiscovery ?? null,
    enableSwap: input.enableSwap ?? false,
    runnerName: input.runnerName?.trim() || DEFAULT_CLOUD_RUNNER_NAME,
    runnerImage: input.runnerImage?.trim() || DEFAULT_AGENTBAY_RUNNER_IMAGE,
    agentImage: DEFAULT_MANUAL_RUNNER_IMAGE,
    hermesWorkloadImage: normalizeContainerImage(
      input.hermesWorkloadImage?.trim() || DEFAULT_HERMES_WORKLOAD_IMAGE,
      "hermesWorkloadImage",
    ),
    hermesStateRoot: normalizeRuntimePath(
      input.hermesStateRoot?.trim() || DEFAULT_HERMES_STATE_ROOT,
      "hermesStateRoot",
    ),
    hermesPrivateNetwork: normalizeDockerNetworkName(
      input.hermesPrivateNetwork?.trim() || DEFAULT_HERMES_PRIVATE_NETWORK,
      "hermesPrivateNetwork",
    ),
    hermesReadinessTimeoutMs: normalizePositiveInteger(
      input.hermesReadinessTimeoutMs ?? DEFAULT_HERMES_READINESS_TIMEOUT_MS,
      "hermesReadinessTimeoutMs",
    ),
    runnerMaxAgents: normalizePositiveInteger(
      input.runnerMaxAgents ?? DEFAULT_HERMES_RUNNER_MAX_AGENTS,
      "runnerMaxAgents",
    ),
    envFilePath: input.envFilePath?.trim() || DEFAULT_CLOUD_RUNNER_ENV_FILE,
    containerEnvFilePath: input.envFilePath?.trim() || DEFAULT_CLOUD_RUNNER_ENV_FILE,
    runnerHost: input.runnerHost?.trim() || DEFAULT_CLOUD_RUNNER_HOST,
    runnerContainerHost: DEFAULT_CLOUD_RUNNER_CONTAINER_HOST,
    runnerPort: input.runnerPort ?? DEFAULT_CLOUD_RUNNER_PORT,
  };
}

function normalizeUrl(value: string, field: string): string {
  const normalized = requireNonEmpty(value, field);

  try {
    return new URL(normalized).toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
}

function normalizeContainerImage(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(value)) {
    throw new Error(`${field} must be a valid container image reference.`);
  }

  return value;
}

function normalizeRuntimePath(value: string, field: string): string {
  if (!value.startsWith("/") || value.includes("..") || /[\s"'`$;&|<>\\]/.test(value)) {
    throw new Error(`${field} must be an absolute runtime path without unsafe characters.`);
  }

  return value.replace(/\/+$/, "") || "/";
}

function normalizeDockerNetworkName(value: string, field: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) {
    throw new Error(`${field} must be a valid Docker network name.`);
  }

  return value;
}

function normalizePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }

  return value;
}

function buildSwapCommands(): string {
  return `  -
    - bash
    - -lc
    - |
      set -euxo pipefail
      AGENTBAY_BOOTSTRAP_STEP=swap_setup
      trap 'agentbay_bootstrap_exit=$?; agentbay_bootstrap_detail="$(tail -n 80 /var/log/agentbay-bootstrap.log || true)"; /usr/local/bin/agentbay-bootstrap-event bootstrapping failed "Cloud runner bootstrap failed during \${AGENTBAY_BOOTSTRAP_STEP}." "\${AGENTBAY_BOOTSTRAP_STEP}" "$agentbay_bootstrap_exit" "$agentbay_bootstrap_detail"' ERR
      if [ ! -f /swapfile ]; then
        fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
        chmod 600 /swapfile
        mkswap /swapfile
      fi
      swapon /swapfile || true
      grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
      /usr/local/bin/agentbay-bootstrap-event bootstrapping completed "Swap was configured for the low-memory runner." swap_setup
`;
}

function buildBootstrapEventScript(config: ReturnType<typeof normalizeBootstrapInput>): string {
  return `#!/usr/bin/env bash
set -euo pipefail

AGENTBAY_APP_URL=${shellQuote(config.appBaseUrl)}
AGENTBAY_REGISTRATION_TOKEN=${shellQuote(config.registrationToken)}

phase="\${1:-bootstrapping}"
status="\${2:-started}"
message="\${3:-Cloud runner bootstrap event.}"
step="\${4:-unknown}"
exit_code="\${5:-}"
detail="\${6:-}"

python3 - "$AGENTBAY_APP_URL" "$AGENTBAY_REGISTRATION_TOKEN" "$phase" "$status" "$message" "$step" "$exit_code" "$detail" <<'AGENTBAY_BOOTSTRAP_EVENT_PY' || true
import json
import sys
import urllib.request

app_url, registration_token, phase, status, message, step, exit_code, detail = sys.argv[1:9]
metadata = {"step": step}

if exit_code:
    try:
        metadata["exitCode"] = int(exit_code)
    except ValueError:
        metadata["exitCode"] = exit_code
if detail:
    metadata["detail"] = detail

payload = json.dumps({
    "registrationToken": registration_token,
    "phase": phase,
    "status": status,
    "message": message,
    "metadata": metadata,
}).encode("utf-8")
request = urllib.request.Request(
    app_url.rstrip("/") + "/runner/v1/bootstrap-events",
    data=payload,
    headers={"content-type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=10) as response:
        response.read()
except Exception:
    pass
AGENTBAY_BOOTSTRAP_EVENT_PY
`;
}

function normalizePublicHttpsUrl(value: string, field: string): string {
  const normalized = normalizeUrl(value, field);
  const url = new URL(normalized);

  if (url.protocol !== "https:" || isLoopbackHostname(url.hostname)) {
    throw new Error(`${field} must be a public HTTPS URL.`);
  }

  return normalized;
}

function buildEndpointConfig(config: ReturnType<typeof normalizeBootstrapInput>): {
  caddyHost: string;
  discoveryCommands: string[];
  envValue: string;
  safeSummary: string;
} {
  if (config.endpointDiscovery?.type === "digitalocean_metadata") {
    const hostnameSuffix = normalizeHostnameSuffix(
      config.endpointDiscovery.hostnameSuffix ?? "sslip.io",
    );

    return {
      discoveryCommands: [
        'AGENTBAY_PUBLIC_IPV4="$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"',
        'AGENTBAY_PUBLIC_IPV4_DASHED="$(printf \'%s\' "$AGENTBAY_PUBLIC_IPV4" | tr . -)"',
      ],
      envValue: `https://\${AGENTBAY_PUBLIC_IPV4_DASHED}.${hostnameSuffix}`,
      caddyHost: `https://\${AGENTBAY_PUBLIC_IPV4_DASHED}.${hostnameSuffix}`,
      safeSummary: `https://<public-ip>.${hostnameSuffix}`,
    };
  }

  if (!config.runnerEndpointUrl) {
    throw new Error("runnerEndpointUrl is required.");
  }

  return {
    caddyHost: escapeHereDocShellExpansion(config.runnerEndpointUrl),
    discoveryCommands: [],
    envValue: escapeDockerEnvHereDocValue(config.runnerEndpointUrl),
    safeSummary: config.runnerEndpointUrl,
  };
}

function normalizeHostnameSuffix(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9.-]+$/.test(normalized) || normalized.startsWith(".") || normalized.endsWith(".")) {
    throw new Error("endpoint hostname suffix is invalid.");
  }

  return normalized;
}

function isLoopbackHostname(value: string): boolean {
  const hostname = value.toLowerCase();

  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function escapeDockerEnvHereDocValue(value: string): string {
  return escapeHereDocShellExpansion(value).replace(/\r?\n/g, "");
}

function escapeHereDocShellExpansion(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\$/g, "\\$").replace(/`/g, "\\`");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function dirname(value: string): string {
  const index = value.lastIndexOf("/");

  return index > 0 ? value.slice(0, index) : ".";
}

function indentHereDoc(value: string): string {
  return value
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function indentYamlBlock(value: string): string {
  return value.replace(/\n/g, "\n      ");
}
