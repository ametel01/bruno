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
  DEFAULT_HERMES_DOCKER_CPUS,
  DEFAULT_HERMES_DOCKER_MEMORY,
  DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import {
  RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV,
  RUNNER_EXPECTED_IMAGE_DIGEST_ENV,
  RUNNER_EXPECTED_RELEASE_VERSION_ENV,
  RUNNER_RELEASE_DEVELOPMENT_MODE,
  RUNNER_RELEASE_IDENTITY_MODE_ENV,
} from "@/src/runner-service/release-identity";
import { DEFAULT_BRUNO_RUNNER_IMAGE } from "@/src/server/env";

const LEGACY_HOST_BOOTSTRAP_TOKENS = [
  "git" + " clone",
  "bun" + " install",
  "/root/.bun/bin/" + "bun",
  "https://github.com/ametel01/" + "bruno.git",
];
const RUNNER_RELEASE_VERSION = "0123456789abcdef";
const RUNNER_IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const IMMUTABLE_RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${RUNNER_RELEASE_VERSION}@${RUNNER_IMAGE_DIGEST}`;

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
    const registrationToken = "bruno_reg_1234567890123456789012345678901234567890123";
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken,
      commandBearerToken: "runner-command-token",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerName: "Cloud Runner 1",
      runnerImage: IMMUTABLE_RUNNER_IMAGE,
    });

    expect(content.userData).toContain("#cloud-config");
    expect(content.userData).toContain("  - bash");
    expect(content.userData).toContain("  - python3");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euo pipefail");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euxo pipefail");
    expect(content.userData).not.toContain("  - |\n    set -euo pipefail");
    expect(content.userData).not.toContain("  - |\n    set -euxo pipefail");
    expect(content.userData).toContain(
      "      sed 's/^    //' > /usr/local/bin/bruno-bootstrap-event <<'BRUNO_BOOTSTRAP_EVENT_SCRIPT'\n" +
        "          #!/usr/bin/env bash\n" +
        "          set -euo pipefail",
    );
    expect(content.userData).not.toContain("\n    set -euo pipefail\n\nBRUNO_APP_URL=");
    expect(content.userData).toContain("apt-get install -y docker-ce");
    expect(content.userData).toContain("systemctl enable --now docker");
    expect(content.userData).toContain("BRUNO_RUNNER_REGISTRATION_TOKEN=");
    expect(content.userData).toContain(registrationToken);
    expect(content.userData).toContain("BRUNO_RUNNER_ENDPOINT_URL=");
    expect(content.userData).toContain("sed 's/^    //' > /usr/local/bin/bruno-bootstrap-event");
    expect(content.userData).toContain(
      "sed 's/^    //' > '/etc/bruno/runner.env' <<BRUNO_RUNNER_ENV",
    );
    expect(content.userData).toContain("BRUNO_APP_URL=https://app.bruno.test");
    expect(content.userData).toContain("BRUNO_RUNNER_ENDPOINT_URL=https://runner.bruno.test");
    expect(content.userData).toContain("BRUNO_RUNNER_NAME=Cloud Runner 1");
    expect(content.userData).toContain("BRUNO_RUNNER_BEARER_TOKEN=runner-command-token");
    expect(content.userData).toContain(`BRUNO_RUNNER_IMAGE=${IMMUTABLE_RUNNER_IMAGE}`);
    expect(content.userData).toContain(
      `${RUNNER_EXPECTED_RELEASE_VERSION_ENV}=${RUNNER_RELEASE_VERSION}`,
    );
    expect(content.userData).toContain(
      `${RUNNER_EXPECTED_IMAGE_DIGEST_ENV}=${RUNNER_IMAGE_DIGEST}`,
    );
    expect(content.userData).toContain(
      `${RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV}=${RUNNER_BOOT_CONTRACT_VERSION}`,
    );
    expect(content.userData).toContain(`BRUNO_DOCKER_RUNNER_IMAGE=${DEFAULT_MANUAL_RUNNER_IMAGE}`);
    expect(content.userData).toContain(
      `BRUNO_HERMES_WORKLOAD_IMAGE=${DEFAULT_HERMES_WORKLOAD_IMAGE}`,
    );
    expect(content.userData).toContain(`BRUNO_HERMES_STATE_ROOT=${DEFAULT_HERMES_STATE_ROOT}`);
    expect(content.userData).toContain(
      `BRUNO_HERMES_PRIVATE_NETWORK=${DEFAULT_HERMES_PRIVATE_NETWORK}`,
    );
    expect(content.userData).toContain(
      `BRUNO_HERMES_READINESS_TIMEOUT_MS=${DEFAULT_HERMES_READINESS_TIMEOUT_MS}`,
    );
    expect(content.userData).toContain(`BRUNO_HERMES_DOCKER_CPUS=${DEFAULT_HERMES_DOCKER_CPUS}`);
    expect(content.userData).toContain(
      `BRUNO_HERMES_DOCKER_MEMORY=${DEFAULT_HERMES_DOCKER_MEMORY}`,
    );
    expect(content.userData).toContain(
      `BRUNO_HERMES_DOCKER_PIDS_LIMIT=${DEFAULT_HERMES_DOCKER_PIDS_LIMIT}`,
    );
    expect(content.userData).toContain(
      `BRUNO_RUNNER_MAX_AGENTS=${DEFAULT_HERMES_RUNNER_MAX_AGENTS}`,
    );
    expect(content.userData).toContain("BRUNO_RUNNER_BOOT_MODEL_CANARY_ENABLED=false");
    expect(content.userData).toContain(
      "          BRUNO_APP_URL=https://app.bruno.test\n" +
        "          BRUNO_RUNNER_REGISTRATION_TOKEN=",
    );
    expect(content.userData).toContain("BRUNO_RUNNER_ENV_FILE=/etc/bruno/runner.env");
    expect(content.userData).toContain("BRUNO_RUNNER_HOST=0.0.0.0");
    expect(content.userData).not.toContain("BRUNO_RUNNER_HOST=127.0.0.1");
    expect(content.userData).not.toContain('BRUNO_APP_URL="https://app.bruno.test"');
    expect(content.userData).not.toContain(`BRUNO_RUNNER_IMAGE="${IMMUTABLE_RUNNER_IMAGE}"`);
    expect(content.userData).not.toContain(". '/etc/bruno/runner.env'");
    expect(content.userData).toContain(`bruno_pull_image '${IMMUTABLE_RUNNER_IMAGE}'`);
    expect(content.userData).toContain(`bruno_pull_image '${DEFAULT_MANUAL_RUNNER_IMAGE}'`);
    expect(content.userData).toContain(`bruno_pull_image '${DEFAULT_HERMES_WORKLOAD_IMAGE}'`);
    expect(content.userData).toContain("for attempt in 1 2 3; do");
    expect(content.userData).toContain('sleep "$((attempt * 2))"');
    expect(content.userData).toContain("BRUNO_BOOTSTRAP_STEP=docker_pull");
    expect(content.userData).toContain("BRUNO_BOOTSTRAP_STEP=agent_image_pull");
    expect(content.userData).toContain("BRUNO_BOOTSTRAP_STEP=hermes_image_pull");
    expect(content.userData).toContain("BRUNO_BOOTSTRAP_STEP=runner_container_start");
    expect(content.userData).not.toContain("BRUNO_BOOTSTRAP_STEP=docker_container_start");
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping started "Installing cloud runner packages." package_install',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Cloud runner packages were installed." package_install',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Pulled cloud runner image." docker_pull',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Pulled default agent container image." agent_image_pull',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Pulled Hermes workload image." hermes_image_pull',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping started "Starting runner container." runner_container_start',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event bootstrapping completed "Runner container started." runner_container_start',
    );
    expect(content.userData).toContain(
      '/usr/local/bin/bruno-bootstrap-event waiting_for_runner started "Runner container started; waiting for registration and heartbeat." runner_registration',
    );
    expect(content.userData).toContain(`install -m 0710 -d '${DEFAULT_HERMES_STATE_ROOT}'`);
    expect(content.userData).toContain(
      `docker network inspect '${DEFAULT_HERMES_PRIVATE_NETWORK}' >/dev/null 2>&1 || docker network create '${DEFAULT_HERMES_PRIVATE_NETWORK}'`,
    );
    expect(content.userData).toContain("docker rm --force 'bruno-runner' || true");
    expect(content.userData).toContain(
      `docker run --detach --name 'bruno-runner' --restart always --network 'bruno-hermes' --env-file '/etc/bruno/runner.env' -v '/etc/bruno/runner.env:/etc/bruno/runner.env' -v '/var/lib/bruno/agents:/var/lib/bruno/agents' -v '/var/lib/bruno/boot-self-test:/var/lib/bruno/boot-self-test' -v '/var/run/docker.sock:/var/run/docker.sock' -p '127.0.0.1:3045:3045' '${IMMUTABLE_RUNNER_IMAGE}'`,
    );
    expect(content.userData).toContain("/runner/v1/bootstrap-events");
    for (const token of LEGACY_HOST_BOOTSTRAP_TOKENS) {
      expect(content.userData).not.toContain(token);
    }
    expect(content.safeSummary).toMatchObject({
      appBaseUrl: "https://app.bruno.test",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerName: "Cloud Runner 1",
      runnerImage: IMMUTABLE_RUNNER_IMAGE,
      runnerRelease: {
        version: RUNNER_RELEASE_VERSION,
        imageDigest: RUNNER_IMAGE_DIGEST,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
      hermesWorkloadImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      hermesStateRoot: DEFAULT_HERMES_STATE_ROOT,
      hermesPrivateNetwork: DEFAULT_HERMES_PRIVATE_NETWORK,
      hermesReadinessTimeoutMs: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
      hermesDocker: {
        cpus: DEFAULT_HERMES_DOCKER_CPUS,
        memory: DEFAULT_HERMES_DOCKER_MEMORY,
        pidsLimit: DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
      },
      runnerMaxAgents: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
      bootModelCanaryEnabled: false,
      registrationToken: BOOTSTRAP_REDACTION,
    });
    expect(JSON.stringify(content.safeSummary)).not.toContain(registrationToken);
    expect(JSON.stringify(content.safeSummary)).not.toContain("runner-command-token");
    expect(content.userData).not.toContain("dop_v1_super_secret");
    expect(content.userData).not.toContain("bruno_run_1234567890123456789012345678901234567890123");
  });

  it("defaults the selected runner image in safe bootstrap content", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerName: "Cloud Runner 1",
    });

    expect(content.safeSummary.runnerImage).toBe(DEFAULT_BRUNO_RUNNER_IMAGE);
    expect(content.safeSummary.hermesWorkloadImage).toBe(DEFAULT_HERMES_WORKLOAD_IMAGE);
    expect(content.safeSummary.hermesStateRoot).toBe(DEFAULT_HERMES_STATE_ROOT);
    expect(content.safeSummary.hermesPrivateNetwork).toBe(DEFAULT_HERMES_PRIVATE_NETWORK);
    expect(content.safeSummary.hermesReadinessTimeoutMs).toBe(DEFAULT_HERMES_READINESS_TIMEOUT_MS);
    expect(content.safeSummary.hermesDocker).toEqual({
      cpus: DEFAULT_HERMES_DOCKER_CPUS,
      memory: DEFAULT_HERMES_DOCKER_MEMORY,
      pidsLimit: DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
    });
    expect(content.safeSummary.runnerMaxAgents).toBe(DEFAULT_HERMES_RUNNER_MAX_AGENTS);
    expect(content.safeSummary.runnerRelease).toBeNull();
    expect(content.userData).toContain(`BRUNO_RUNNER_IMAGE=${DEFAULT_BRUNO_RUNNER_IMAGE}`);
    expect(content.userData).not.toContain(RUNNER_EXPECTED_IMAGE_DIGEST_ENV);
  });

  it("builds snapshot first-boot data without package installation or image pulls", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      commandBearerToken: "runner-command-token",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerImage: IMMUTABLE_RUNNER_IMAGE,
      bootMode: "snapshot",
    });

    expect(content.userData).toContain("#cloud-config");
    expect(content.userData).toContain("BRUNO_RUNNER_REGISTRATION_TOKEN=");
    expect(content.userData).toContain("BRUNO_RUNNER_BEARER_TOKEN=runner-command-token");
    expect(content.userData).toContain("snapshot_preloaded_images");
    expect(content.userData).toContain("docker run --detach");
    expect(content.userData).toContain("waiting_for_runner");
    expect(content.userData).not.toContain("package_update:");
    expect(content.userData).not.toContain("packages:");
    expect(content.userData).not.toContain("apt-get install");
    expect(content.userData).not.toContain("docker pull");
    expect(content.userData).not.toContain("bruno_pull_image");
    expect(content.userData).not.toContain("docker_apt_repository");
  });

  it("marks local tagged images with the explicit development identity seam", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerImage: "bruno-runner:local",
      releaseIdentityMode: RUNNER_RELEASE_DEVELOPMENT_MODE,
    });

    expect(content.safeSummary.runnerRelease).toBeNull();
    expect(content.userData).toContain(
      `${RUNNER_RELEASE_IDENTITY_MODE_ENV}=${RUNNER_RELEASE_DEVELOPMENT_MODE}`,
    );
  });

  it("uses custom safe Hermes deployment settings without exposing secrets", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerName: "Cloud Runner 1",
      hermesWorkloadImage: "ghcr.io/ametel01/bruno-hermes:sha-123",
      hermesStateRoot: "/var/lib/bruno/custom-agents",
      hermesPrivateNetwork: "bruno-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      hermesDockerCpus: "1",
      hermesDockerMemory: "1536m",
      hermesDockerPidsLimit: "256",
      runnerMaxAgents: 1,
    });

    expect(content.userData).toContain(
      "BRUNO_HERMES_WORKLOAD_IMAGE=ghcr.io/ametel01/bruno-hermes:sha-123",
    );
    expect(content.userData).toContain("BRUNO_HERMES_STATE_ROOT=/var/lib/bruno/custom-agents");
    expect(content.userData).toContain("BRUNO_HERMES_PRIVATE_NETWORK=bruno-custom-hermes");
    expect(content.userData).toContain("BRUNO_HERMES_READINESS_TIMEOUT_MS=240000");
    expect(content.userData).toContain("BRUNO_HERMES_DOCKER_CPUS=1");
    expect(content.userData).toContain("BRUNO_HERMES_DOCKER_MEMORY=1536m");
    expect(content.userData).toContain("BRUNO_HERMES_DOCKER_PIDS_LIMIT=256");
    expect(content.userData).toContain("BRUNO_RUNNER_MAX_AGENTS=1");
    expect(content.userData).toContain("bruno_pull_image 'ghcr.io/ametel01/bruno-hermes:sha-123'");
    expect(content.userData).toContain("docker network create 'bruno-custom-hermes'");
    expect(content.userData).toContain(
      "-v '/var/lib/bruno/custom-agents:/var/lib/bruno/custom-agents'",
    );
    expect(content.safeSummary).toMatchObject({
      hermesWorkloadImage: "ghcr.io/ametel01/bruno-hermes:sha-123",
      hermesStateRoot: "/var/lib/bruno/custom-agents",
      hermesPrivateNetwork: "bruno-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      hermesDocker: {
        cpus: "1",
        memory: "1536m",
        pidsLimit: "256",
      },
      runnerMaxAgents: 1,
    });
  });

  it("rejects Hermes runtime settings Docker cannot represent", () => {
    const base = {
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      runnerName: "Cloud Runner 1",
    };

    expect(() =>
      buildCloudRunnerBootstrapContent({
        ...base,
        hermesDockerCpus: "0.0000000001",
      }),
    ).toThrow("hermesDockerCpus must be a positive Docker CPU value representable");

    expect(() =>
      buildCloudRunnerBootstrapContent({
        ...base,
        hermesDockerPidsLimit: "4097",
      }),
    ).toThrow("hermesDockerPidsLimit must be a positive integer no greater than 4096");
  });

  it("rejects loopback runner endpoint URLs for cloud bootstrap registration", () => {
    expect(() =>
      buildCloudRunnerBootstrapContent({
        appBaseUrl: "https://app.bruno.test",
        registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
        runnerEndpointUrl: "http://127.0.0.1:3045",
        runnerName: "Cloud Runner 1",
      }),
    ).toThrow("runnerEndpointUrl must be a public HTTPS URL.");
  });

  it("configures an HTTPS reverse proxy for the public runner hostname", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
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
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      endpointDiscovery: { type: "digitalocean_metadata" },
      runnerName: "Cloud Runner 1",
    });
    const discoveredIpPlaceholder = ["$", "{BRUNO_PUBLIC_IPV4_DASHED}"].join("");

    expect(content.userData).toContain(
      '      BRUNO_PUBLIC_IPV4="$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"\n' +
        '      BRUNO_PUBLIC_IPV4_DASHED="$(printf \'%s\' "$BRUNO_PUBLIC_IPV4" | tr . -)"\n' +
        "      sed 's/^    //' > /etc/caddy/Caddyfile <<BRUNO_CADDYFILE",
    );
    expect(content.userData).toContain(`      https://${discoveredIpPlaceholder}.sslip.io {`);
    expect(content.userData).toContain(
      '      BRUNO_PUBLIC_IPV4="$(curl -fsS http://169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address)"\n' +
        '      BRUNO_PUBLIC_IPV4_DASHED="$(printf \'%s\' "$BRUNO_PUBLIC_IPV4" | tr . -)"\n' +
        "      sed 's/^    //' > '/etc/bruno/runner.env' <<BRUNO_RUNNER_ENV",
    );
    expect(content.userData).toContain(
      `          BRUNO_RUNNER_ENDPOINT_URL=https://${discoveredIpPlaceholder}.sslip.io`,
    );
    expect(content.userData).not.toContain("\nBRUNO_PUBLIC_IPV4_DASHED=");
  });

  it("adds bootstrap logging and swap setup when low-memory Droplet swap is enabled", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      runnerEndpointUrl: "https://203-0-113-10.sslip.io",
      runnerName: "Cloud Runner 1",
      enableSwap: true,
    });

    expect(content.userData).toContain("/var/log/bruno-bootstrap.log");
    expect(content.userData).toContain("set -euxo pipefail");
    expect(content.userData).toContain("    - bash\n    - -lc\n    - |\n      set -euxo pipefail");
    expect(content.userData).toContain("fallocate -l 1G /swapfile");
    expect(content.userData).toContain("mkswap /swapfile");
    expect(content.userData).toContain("swapon /swapfile");
    expect(content.userData).toContain("/swapfile none swap sw 0 0");
  });

  it("does not emit under-indented runcmd block content", () => {
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.bruno.test",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
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
      "BRUNO_DIGITALOCEAN_TOKEN=dop_v1_super_secret",
      "BRUNO_RUNNER_REGISTRATION_TOKEN=bruno_reg_1234567890123456789012345678901234567890123",
      "BRUNO_RUNNER_BEARER_TOKEN=runner-command-token",
      "BRUNO_RUNNER_CREDENTIAL=bruno_run_1234567890123456789012345678901234567890123",
    ].join("\n");

    const redacted = redactCloudRunnerBootstrapOutput(unsafeOutput);

    expect(redacted).toContain(BOOTSTRAP_REDACTION);
    expect(redacted).not.toContain("dop_v1_super_secret");
    expect(redacted).not.toContain("bruno_reg_1234567890123456789012345678901234567890123");
    expect(redacted).not.toContain("runner-command-token");
    expect(redacted).not.toContain("bruno_run_1234567890123456789012345678901234567890123");
  });

  it("records the bootstrap injected phase without persisting raw registration material", async () => {
    const runner = await seedCloudRunner(connection);
    const registrationToken = "bruno_reg_1234567890123456789012345678901234567890123";

    const content = await buildCloudRunnerBootstrapForRunner({
      runnerId: runner.id,
      appBaseUrl: "https://app.bruno.test",
      registrationToken,
      runnerEndpointUrl: "https://runner.bruno.test",
      runnerImage: IMMUTABLE_RUNNER_IMAGE,
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
          runnerImage: IMMUTABLE_RUNNER_IMAGE,
          runnerRelease: {
            version: RUNNER_RELEASE_VERSION,
            imageDigest: RUNNER_IMAGE_DIGEST,
            bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          },
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
