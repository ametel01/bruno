import "server-only";

import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import { markCloudRunnerBootstrapInjected } from "@/src/server/runners/runner-provisioning-events";

export const DEFAULT_CLOUD_RUNNER_REPOSITORY_URL = "https://github.com/ametel01/agentbay.git";
export const DEFAULT_CLOUD_RUNNER_INSTALL_DIR = "/opt/agentbay";
export const DEFAULT_CLOUD_RUNNER_ENV_FILE = "/etc/agentbay/runner.env";
export const DEFAULT_CLOUD_RUNNER_HOST = "127.0.0.1";
export const DEFAULT_CLOUD_RUNNER_PORT = 3045;
export const DEFAULT_CLOUD_RUNNER_NAME = "AgentBay Cloud Runner";
export const BOOTSTRAP_REDACTION = "[redacted]";

type CloudRunnerBootstrapInput = {
  appBaseUrl: string;
  registrationToken: string;
  runnerEndpointUrl?: string;
  endpointDiscovery?: {
    type: "digitalocean_metadata";
    hostnameSuffix?: string;
  };
  enableSwap?: boolean;
  runnerName?: string;
  repositoryUrl?: string;
  installDir?: string;
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
    repositoryUrl: string;
    installDir: string;
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
  const envLines = [
    `AGENTBAY_APP_URL=${quoteSystemdEnvironmentValue(config.appBaseUrl)}`,
    `AGENTBAY_RUNNER_REGISTRATION_TOKEN=${quoteSystemdEnvironmentValue(config.registrationToken)}`,
    `AGENTBAY_RUNNER_ENDPOINT_URL=${endpoint.envValue}`,
    `AGENTBAY_RUNNER_NAME=${quoteSystemdEnvironmentValue(config.runnerName)}`,
    `AGENTBAY_RUNNER_HOST=${quoteSystemdEnvironmentValue(config.runnerHost)}`,
    `AGENTBAY_RUNNER_PORT=${config.runnerPort}`,
  ].join("\n");
  const endpointDiscoveryCommands =
    endpoint.discoveryCommands.length > 0 ? `${endpoint.discoveryCommands.join("\n")}\n    ` : "";
  const userData = `#cloud-config
package_update: true
package_upgrade: false
output:
  all: '| tee -a /var/log/agentbay-bootstrap.log'
packages:
  - ca-certificates
  - curl
  - git
  - gnupg
runcmd:
  - install -m 0755 -d /etc/apt/keyrings
  - curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  - chmod a+r /etc/apt/keyrings/docker.gpg
  - sh -c 'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list'
  - apt-get update
  - |
    set -euxo pipefail
    touch /var/log/agentbay-bootstrap.log
    chmod 0600 /var/log/agentbay-bootstrap.log
${swapCommands}  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - apt-get install -y caddy
  - systemctl enable --now docker
  - curl -fsSL https://bun.sh/install | bash
  - rm -rf ${shellQuote(config.installDir)}
  - git clone --depth=1 ${shellQuote(config.repositoryUrl)} ${shellQuote(config.installDir)}
  - ${shellQuote("/root/.bun/bin/bun")} install --cwd ${shellQuote(config.installDir)} --frozen-lockfile
  - install -m 0700 -d ${shellQuote(dirname(config.envFilePath))}
  - |
    ${endpointDiscoveryCommands}cat > /etc/caddy/Caddyfile <<AGENTBAY_CADDYFILE
    ${endpoint.caddyHost} {
      reverse_proxy ${config.runnerHost}:${config.runnerPort}
    }
    AGENTBAY_CADDYFILE
  - systemctl enable --now caddy
  - |
    cat > ${shellQuote(config.envFilePath)} <<AGENTBAY_RUNNER_ENV
    ${indentHereDoc(envLines)}
    AGENTBAY_RUNNER_ENV
  - chmod 0600 ${shellQuote(config.envFilePath)}
  - |
    cat > /etc/systemd/system/agentbay-runner.service <<'AGENTBAY_RUNNER_SERVICE'
    [Unit]
    Description=AgentBay cloud runner service
    Requires=docker.service
    After=network-online.target docker.service

    [Service]
    Type=simple
    WorkingDirectory=${config.installDir}
    EnvironmentFile=${config.envFilePath}
    ExecStartPre=/root/.bun/bin/bun run runner:bootstrap
    ExecStart=/root/.bun/bin/bun run runner:service
    Restart=always
    RestartSec=5

    [Install]
    WantedBy=multi-user.target
    AGENTBAY_RUNNER_SERVICE
  - systemctl daemon-reload
  - systemctl enable --now agentbay-runner.service
`;

  return {
    userData,
    safeSummary: {
      appBaseUrl: config.appBaseUrl,
      runnerEndpointUrl: endpoint.safeSummary,
      runnerName: config.runnerName,
      repositoryUrl: config.repositoryUrl,
      installDir: config.installDir,
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
    .replace(/(AGENTBAY_RUNNER_CREDENTIAL=)[^\n]+/g, `$1${BOOTSTRAP_REDACTION}`);
}

function normalizeBootstrapInput(input: CloudRunnerBootstrapInput) {
  return {
    appBaseUrl: normalizeUrl(input.appBaseUrl, "appBaseUrl"),
    registrationToken: requireNonEmpty(input.registrationToken, "registrationToken"),
    runnerEndpointUrl: input.runnerEndpointUrl
      ? normalizePublicHttpsUrl(input.runnerEndpointUrl, "runnerEndpointUrl")
      : null,
    endpointDiscovery: input.endpointDiscovery ?? null,
    enableSwap: input.enableSwap ?? false,
    runnerName: input.runnerName?.trim() || DEFAULT_CLOUD_RUNNER_NAME,
    repositoryUrl: input.repositoryUrl?.trim() || DEFAULT_CLOUD_RUNNER_REPOSITORY_URL,
    installDir: input.installDir?.trim() || DEFAULT_CLOUD_RUNNER_INSTALL_DIR,
    envFilePath: input.envFilePath?.trim() || DEFAULT_CLOUD_RUNNER_ENV_FILE,
    runnerHost: input.runnerHost?.trim() || DEFAULT_CLOUD_RUNNER_HOST,
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

function buildSwapCommands(): string {
  return `  - |
    set -euxo pipefail
    if [ ! -f /swapfile ]; then
      fallocate -l 1G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=1024
      chmod 600 /swapfile
      mkswap /swapfile
    fi
    swapon /swapfile || true
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
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
      envValue: `"https://\${AGENTBAY_PUBLIC_IPV4_DASHED}.${hostnameSuffix}"`,
      caddyHost: `\${AGENTBAY_PUBLIC_IPV4_DASHED}.${hostnameSuffix}`,
      safeSummary: `https://<public-ip>.${hostnameSuffix}`,
    };
  }

  if (!config.runnerEndpointUrl) {
    throw new Error("runnerEndpointUrl is required.");
  }

  const endpointUrl = new URL(config.runnerEndpointUrl);

  return {
    caddyHost: escapeHereDocShellExpansion(endpointUrl.hostname),
    discoveryCommands: [],
    envValue: quoteSystemdEnvironmentValue(config.runnerEndpointUrl),
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

function quoteSystemdEnvironmentValue(value: string): string {
  return `"${escapeHereDocShellExpansion(value).replace(/"/g, '\\"')}"`;
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
