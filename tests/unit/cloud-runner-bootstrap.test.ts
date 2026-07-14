import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerProvisioningEvents, runners, users } from "@/src/server/db/schema";
import {
  BOOTSTRAP_REDACTION,
  buildCloudRunnerBootstrapContent,
  buildCloudRunnerBootstrapForRunner,
  redactCloudRunnerBootstrapOutput,
} from "@/src/server/runners/cloud-runner-bootstrap";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_MANUAL_RUNNER_IMAGE,
} from "@/src/runner-service/constants";
import { DEFAULT_AGENTBAY_RUNNER_IMAGE } from "@/src/server/env";

const LEGACY_HOST_BOOTSTRAP_TOKENS = [
  "git" + " clone",
  "bun" + " install",
  "/root/.bun/bin/" + "bun",
  "https://github.com/ametel01/" + "agentbay.git",
];

describe.sequential("cloud runner bootstrap content", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("builds cloud-init that installs Docker and starts the runner container from the selected image", () => {
    const registrationToken = "agb_reg_1234567890123456789012345678901234567890123";
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken,
      commandBearerToken: "runner-command-token",
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
    });

    expect(content.userData).toContain("#cloud-config");
    expect(content.userData).toContain("  - bash");
    expect(content.userData).toContain("  - python3");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euo pipefail");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euxo pipefail");
    expect(content.userData).not.toContain("  - |\n    set -euo pipefail");
    expect(content.userData).not.toContain("  - |\n    set -euxo pipefail");
    expect(content.userData).toContain(
      "      sed 's/^    //' > /usr/local/bin/agentbay-bootstrap-event <<'AGENTBAY_BOOTSTRAP_EVENT_SCRIPT'\n" +
        "          #!/usr/bin/env bash\n" +
        "          set -euo pipefail",
    );
    expect(content.userData).not.toContain("\n    set -euo pipefail\n\nAGENTBAY_APP_URL=");
    expect(content.userData).toContain("apt-get install -y docker-ce");
    expect(content.userData).toContain("systemctl enable --now docker");
    expect(content.userData).toContain("AGENTBAY_RUNNER_REGISTRATION_TOKEN=");
    expect(content.userData).toContain(registrationToken);
    expect(content.userData).toContain("AGENTBAY_RUNNER_ENDPOINT_URL=");
    expect(content.userData).toContain("sed 's/^    //' > /usr/local/bin/agentbay-bootstrap-event");
    expect(content.userData).toContain(
      "sed 's/^    //' > '/etc/agentbay/runner.env' <<AGENTBAY_RUNNER_ENV",
    );
    expect(content.userData).toContain("AGENTBAY_APP_URL=https://app.agentbay.test");
    expect(content.userData).toContain("AGENTBAY_RUNNER_ENDPOINT_URL=https://runner.agentbay.test");
    expect(content.userData).toContain("AGENTBAY_RUNNER_NAME=Cloud Runner 1");
    expect(content.userData).toContain("AGENTBAY_RUNNER_BEARER_TOKEN=runner-command-token");
    expect(content.userData).toContain(
      "AGENTBAY_RUNNER_IMAGE=ghcr.io/ametel01/agentbay-runner:sha-123",
    );
    expect(content.userData).toContain(
      `AGENTBAY_DOCKER_RUNNER_IMAGE=${DEFAULT_MANUAL_RUNNER_IMAGE}`,
    );
    expect(content.userData).toContain(
      `AGENTBAY_HERMES_WORKLOAD_IMAGE=${DEFAULT_HERMES_WORKLOAD_IMAGE}`,
    );
    expect(content.userData).toContain(`AGENTBAY_HERMES_STATE_ROOT=${DEFAULT_HERMES_STATE_ROOT}`);
    expect(content.userData).toContain(
      `AGENTBAY_HERMES_PRIVATE_NETWORK=${DEFAULT_HERMES_PRIVATE_NETWORK}`,
    );
    expect(content.userData).toContain(
      `AGENTBAY_HERMES_READINESS_TIMEOUT_MS=${DEFAULT_HERMES_READINESS_TIMEOUT_MS}`,
    );
    expect(content.userData).toContain(
      `AGENTBAY_RUNNER_MAX_AGENTS=${DEFAULT_HERMES_RUNNER_MAX_AGENTS}`,
    );
    expect(content.userData).toContain(
      "          AGENTBAY_APP_URL=https://app.agentbay.test\n" +
        "          AGENTBAY_RUNNER_REGISTRATION_TOKEN=",
    );
    expect(content.userData).toContain("AGENTBAY_RUNNER_ENV_FILE=/etc/agentbay/runner.env");
    expect(content.userData).toContain("AGENTBAY_RUNNER_HOST=0.0.0.0");
    expect(content.userData).not.toContain("AGENTBAY_RUNNER_HOST=127.0.0.1");
    expect(content.userData).not.toContain('AGENTBAY_APP_URL="https://app.agentbay.test"');
    expect(content.userData).not.toContain(
      'AGENTBAY_RUNNER_IMAGE="ghcr.io/ametel01/agentbay-runner:sha-123"',
    );
    expect(content.userData).not.toContain(". '/etc/agentbay/runner.env'");
    expect(content.userData).toContain("docker pull 'ghcr.io/ametel01/agentbay-runner:sha-123'");
    expect(content.userData).toContain(`docker pull '${DEFAULT_MANUAL_RUNNER_IMAGE}'`);
    expect(content.userData).toContain(`docker pull '${DEFAULT_HERMES_WORKLOAD_IMAGE}'`);
    expect(content.userData).toContain(`install -m 0710 -d '${DEFAULT_HERMES_STATE_ROOT}'`);
    expect(content.userData).toContain(
      `docker network inspect '${DEFAULT_HERMES_PRIVATE_NETWORK}' >/dev/null 2>&1 || docker network create '${DEFAULT_HERMES_PRIVATE_NETWORK}'`,
    );
    expect(content.userData).toContain("docker rm --force 'agentbay-runner' || true");
    expect(content.userData).toContain(
      "docker run --detach --name 'agentbay-runner' --restart always --network 'agentbay-hermes' --env-file '/etc/agentbay/runner.env' -v '/etc/agentbay/runner.env:/etc/agentbay/runner.env' -v '/var/lib/agentbay/agents:/var/lib/agentbay/agents' -v '/var/run/docker.sock:/var/run/docker.sock' -p '127.0.0.1:3045:3045' 'ghcr.io/ametel01/agentbay-runner:sha-123'",
    );
    expect(content.userData).toContain("/runner/v1/bootstrap-events");
    for (const token of LEGACY_HOST_BOOTSTRAP_TOKENS) {
      expect(content.userData).not.toContain(token);
    }
    expect(content.safeSummary).toMatchObject({
      appBaseUrl: "https://app.agentbay.test",
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
      hermesWorkloadImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      hermesStateRoot: DEFAULT_HERMES_STATE_ROOT,
      hermesPrivateNetwork: DEFAULT_HERMES_PRIVATE_NETWORK,
      hermesReadinessTimeoutMs: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
      runnerMaxAgents: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
      registrationToken: BOOTSTRAP_REDACTION,
    });
    expect(JSON.stringify(content.safeSummary)).not.toContain(registrationToken);
    expect(JSON.stringify(content.safeSummary)).not.toContain("runner-command-token");
    expect(content.userData).not.toContain("dop_v1_super_secret");
    expect(content.userData).not.toContain("agb_run_1234567890123456789012345678901234567890123");
  });

  it("defaults the selected runner image in safe bootstrap content", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
    });

    expect(content.safeSummary.runnerImage).toBe(DEFAULT_AGENTBAY_RUNNER_IMAGE);
    expect(content.safeSummary.hermesWorkloadImage).toBe(DEFAULT_HERMES_WORKLOAD_IMAGE);
    expect(content.safeSummary.hermesStateRoot).toBe(DEFAULT_HERMES_STATE_ROOT);
    expect(content.safeSummary.hermesPrivateNetwork).toBe(DEFAULT_HERMES_PRIVATE_NETWORK);
    expect(content.safeSummary.hermesReadinessTimeoutMs).toBe(DEFAULT_HERMES_READINESS_TIMEOUT_MS);
    expect(content.safeSummary.runnerMaxAgents).toBe(DEFAULT_HERMES_RUNNER_MAX_AGENTS);
    expect(content.userData).toContain(`AGENTBAY_RUNNER_IMAGE=${DEFAULT_AGENTBAY_RUNNER_IMAGE}`);
  });

  it("uses custom safe Hermes deployment settings without exposing secrets", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
      hermesWorkloadImage: "ghcr.io/ametel01/agentbay-hermes:sha-123",
      hermesStateRoot: "/var/lib/agentbay/custom-agents",
      hermesPrivateNetwork: "agentbay-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      runnerMaxAgents: 1,
    });

    expect(content.userData).toContain(
      "AGENTBAY_HERMES_WORKLOAD_IMAGE=ghcr.io/ametel01/agentbay-hermes:sha-123",
    );
    expect(content.userData).toContain(
      "AGENTBAY_HERMES_STATE_ROOT=/var/lib/agentbay/custom-agents",
    );
    expect(content.userData).toContain("AGENTBAY_HERMES_PRIVATE_NETWORK=agentbay-custom-hermes");
    expect(content.userData).toContain("AGENTBAY_HERMES_READINESS_TIMEOUT_MS=240000");
    expect(content.userData).toContain("AGENTBAY_RUNNER_MAX_AGENTS=1");
    expect(content.userData).toContain("docker pull 'ghcr.io/ametel01/agentbay-hermes:sha-123'");
    expect(content.userData).toContain("docker network create 'agentbay-custom-hermes'");
    expect(content.userData).toContain(
      "-v '/var/lib/agentbay/custom-agents:/var/lib/agentbay/custom-agents'",
    );
    expect(content.safeSummary).toMatchObject({
      hermesWorkloadImage: "ghcr.io/ametel01/agentbay-hermes:sha-123",
      hermesStateRoot: "/var/lib/agentbay/custom-agents",
      hermesPrivateNetwork: "agentbay-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      runnerMaxAgents: 1,
    });
  });

  it("rejects loopback runner endpoint URLs for cloud bootstrap registration", () => {
    expect(() =>
      buildCloudRunnerBootstrapContent({
        appBaseUrl: "https://app.agentbay.test",
        registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
        runnerEndpointUrl: "http://127.0.0.1:3045",
        runnerName: "Cloud Runner 1",
      }),
    ).toThrow("runnerEndpointUrl must be a public HTTPS URL.");
  });

  it("configures an HTTPS reverse proxy for the public runner hostname", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://203-0-113-10.sslip.io",
      runnerName: "Cloud Runner 1",
    });

    expect(content.userData).toContain("apt-get install -y caddy");
    expect(content.userData).toContain("https://203-0-113-10.sslip.io");
    expect(content.userData).toContain("reverse_proxy 127.0.0.1:3045");
    expect(content.userData).toContain("caddy validate --config /etc/caddy/Caddyfile");
    expect(content.userData).toContain("systemctl reload caddy || systemctl restart caddy");
    expect(content.userData).toContain("-p '127.0.0.1:3045:3045'");
    expect(content.safeSummary.runnerEndpointUrl).toBe("https://203-0-113-10.sslip.io");
  });

  it("keeps metadata endpoint discovery commands inside each YAML block scalar that uses them", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      endpointDiscovery: { type: "digitalocean_metadata" },
      runnerName: "Cloud Runner 1",
    });
    const discoveredIpPlaceholder = ["$", "{AGENTBAY_PUBLIC_IPV4_DASHED}"].join("");

    expect(content.userData).toContain(
      '      AGENTBAY_PUBLIC_IPV4="$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"\n' +
        '      AGENTBAY_PUBLIC_IPV4_DASHED="$(printf \'%s\' "$AGENTBAY_PUBLIC_IPV4" | tr . -)"\n' +
        "      sed 's/^    //' > /etc/caddy/Caddyfile <<AGENTBAY_CADDYFILE",
    );
    expect(content.userData).toContain(`      https://${discoveredIpPlaceholder}.sslip.io {`);
    expect(content.userData).toContain(
      '      AGENTBAY_PUBLIC_IPV4="$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"\n' +
        '      AGENTBAY_PUBLIC_IPV4_DASHED="$(printf \'%s\' "$AGENTBAY_PUBLIC_IPV4" | tr . -)"\n' +
        "      sed 's/^    //' > '/etc/agentbay/runner.env' <<AGENTBAY_RUNNER_ENV",
    );
    expect(content.userData).toContain(
      `          AGENTBAY_RUNNER_ENDPOINT_URL=https://${discoveredIpPlaceholder}.sslip.io`,
    );
    expect(content.userData).not.toContain("\nAGENTBAY_PUBLIC_IPV4_DASHED=");
  });

  it("adds bootstrap logging and swap setup when low-memory Droplet swap is enabled", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://203-0-113-10.sslip.io",
      runnerName: "Cloud Runner 1",
      enableSwap: true,
    });

    expect(content.userData).toContain("/var/log/agentbay-bootstrap.log");
    expect(content.userData).toContain("set -euxo pipefail");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euxo pipefail");
    expect(content.userData).toContain("fallocate -l 1G /swapfile");
    expect(content.userData).toContain("mkswap /swapfile");
    expect(content.userData).toContain("swapon /swapfile");
    expect(content.userData).toContain("/swapfile none swap sw 0 0");
  });

  it("does not emit under-indented runcmd block content", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      endpointDiscovery: { type: "digitalocean_metadata" },
      runnerName: "Cloud Runner 1",
      enableSwap: true,
    });

    const lines = content.userData.split("\n");
    const runcmdLines = lines.slice(lines.indexOf("runcmd:"));

    for (const line of runcmdLines) {
      if (!line.trim()) {
        continue;
      }

      const allowed =
        line === "runcmd:" ||
        line.startsWith("  -") ||
        line.startsWith("    -") ||
        line.startsWith("      ");

      expect(allowed, `unexpected runcmd indentation: ${line}`).toBe(true);
    }
  });

  it("redacts provider tokens, one-time registration tokens, and runner credentials from safe output", () => {
    const unsafeOutput = [
      "AGENTBAY_DIGITALOCEAN_TOKEN=dop_v1_super_secret",
      "AGENTBAY_RUNNER_REGISTRATION_TOKEN=agb_reg_1234567890123456789012345678901234567890123",
      "AGENTBAY_RUNNER_BEARER_TOKEN=runner-command-token",
      "AGENTBAY_RUNNER_CREDENTIAL=agb_run_1234567890123456789012345678901234567890123",
    ].join("\n");

    const redacted = redactCloudRunnerBootstrapOutput(unsafeOutput);

    expect(redacted).toContain(BOOTSTRAP_REDACTION);
    expect(redacted).not.toContain("dop_v1_super_secret");
    expect(redacted).not.toContain("agb_reg_1234567890123456789012345678901234567890123");
    expect(redacted).not.toContain("runner-command-token");
    expect(redacted).not.toContain("agb_run_1234567890123456789012345678901234567890123");
  });

  it("records the bootstrap injected phase without persisting raw registration material", async () => {
    const runner = await seedCloudRunner(connection);
    const registrationToken = "agb_reg_1234567890123456789012345678901234567890123";

    const content = await buildCloudRunnerBootstrapForRunner({
      runnerId: runner.id,
      appBaseUrl: "https://app.agentbay.test",
      registrationToken,
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
      createConnection: () => connection,
      now: () => new Date("2026-07-06T02:00:30.000Z"),
    });

    const [persistedRunner] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const events = await connection.db.select().from(runnerProvisioningEvents);

    expect(content.userData).toContain(registrationToken);
    expect(persistedRunner).toMatchObject({
      status: "provisioning",
      provisioningStatus: "bootstrapping",
    });
    expect(events).toEqual([
      expect.objectContaining({
        runnerId: runner.id,
        phase: "bootstrapping",
        status: "started",
        message: "Cloud runner bootstrap content was injected.",
        metadata: expect.objectContaining({
          provider: "digitalocean",
          registrationToken: "injected",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
        }),
      }),
    ]);
    expect(JSON.stringify([persistedRunner, events])).not.toContain(registrationToken);
  });
});

async function seedCloudRunner(connection: DatabaseConnection): Promise<{ id: string }> {
  const now = new Date("2026-07-06T02:00:00.000Z");
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("Test user insert returned no rows.");
  }

  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: user.id,
      name: "Cloud Runner",
      kind: "digitalocean",
      status: "provisioning",
      provider: "digitalocean",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "pending",
      provisioningStartedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Cloud runner insert returned no rows.");
  }

  return runner;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_credentials, runner_heartbeats, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
