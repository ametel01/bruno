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
  runnerEndpointUrl: string;
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
  const envLines = [
    `AGENTBAY_APP_URL=${quoteSystemdEnvironmentValue(config.appBaseUrl)}`,
    `AGENTBAY_RUNNER_REGISTRATION_TOKEN=${quoteSystemdEnvironmentValue(config.registrationToken)}`,
    `AGENTBAY_RUNNER_ENDPOINT_URL=${quoteSystemdEnvironmentValue(config.runnerEndpointUrl)}`,
    `AGENTBAY_RUNNER_NAME=${quoteSystemdEnvironmentValue(config.runnerName)}`,
    `AGENTBAY_RUNNER_HOST=${quoteSystemdEnvironmentValue(config.runnerHost)}`,
    `AGENTBAY_RUNNER_PORT=${config.runnerPort}`,
  ].join("\n");
  const userData = `#cloud-config
package_update: true
package_upgrade: false
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
  - apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  - systemctl enable --now docker
  - curl -fsSL https://bun.sh/install | bash
  - rm -rf ${shellQuote(config.installDir)}
  - git clone --depth=1 ${shellQuote(config.repositoryUrl)} ${shellQuote(config.installDir)}
  - ${shellQuote("/root/.bun/bin/bun")} install --cwd ${shellQuote(config.installDir)} --frozen-lockfile
  - install -m 0700 -d ${shellQuote(dirname(config.envFilePath))}
  - |
    cat > ${shellQuote(config.envFilePath)} <<'AGENTBAY_RUNNER_ENV'
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
      runnerEndpointUrl: config.runnerEndpointUrl,
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
    runnerEndpointUrl: normalizeUrl(input.runnerEndpointUrl, "runnerEndpointUrl"),
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

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();

  if (!normalized) {
    throw new Error(`${field} is required.`);
  }

  return normalized;
}

function quoteSystemdEnvironmentValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
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
