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

  it("builds cloud-init that installs Docker and starts the runner bootstrap/service unit", () => {
    const registrationToken = "agb_reg_1234567890123456789012345678901234567890123";
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "https://app.agentbay.test",
      registrationToken,
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
    });

    expect(content.userData).toContain("#cloud-config");
    expect(content.userData).toContain("apt-get install -y docker-ce");
    expect(content.userData).toContain("systemctl enable --now docker");
    expect(content.userData).toContain("AGENTBAY_RUNNER_REGISTRATION_TOKEN=");
    expect(content.userData).toContain(registrationToken);
    expect(content.userData).toContain("AGENTBAY_RUNNER_ENDPOINT_URL=");
    expect(content.userData).toContain("ExecStartPre=/root/.bun/bin/bun run runner:bootstrap");
    expect(content.userData).toContain("ExecStart=/root/.bun/bin/bun run runner:service");
    expect(content.safeSummary).toMatchObject({
      appBaseUrl: "https://app.agentbay.test",
      runnerEndpointUrl: "https://runner.agentbay.test",
      runnerName: "Cloud Runner 1",
      registrationToken: BOOTSTRAP_REDACTION,
    });
    expect(JSON.stringify(content.safeSummary)).not.toContain(registrationToken);
    expect(content.userData).not.toContain("dop_v1_super_secret");
    expect(content.userData).not.toContain("agb_run_1234567890123456789012345678901234567890123");
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
    expect(content.userData).toContain("203-0-113-10.sslip.io");
    expect(content.userData).toContain("reverse_proxy 127.0.0.1:3045");
    expect(content.safeSummary.runnerEndpointUrl).toBe("https://203-0-113-10.sslip.io");
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
    expect(content.userData).toContain("fallocate -l 1G /swapfile");
    expect(content.userData).toContain("mkswap /swapfile");
    expect(content.userData).toContain("swapon /swapfile");
    expect(content.userData).toContain("/swapfile none swap sw 0 0");
  });

  it("redacts provider tokens, one-time registration tokens, and runner credentials from safe output", () => {
    const unsafeOutput = [
      "AGENTBAY_DIGITALOCEAN_TOKEN=dop_v1_super_secret",
      "AGENTBAY_RUNNER_REGISTRATION_TOKEN=agb_reg_1234567890123456789012345678901234567890123",
      "AGENTBAY_RUNNER_CREDENTIAL=agb_run_1234567890123456789012345678901234567890123",
    ].join("\n");

    const redacted = redactCloudRunnerBootstrapOutput(unsafeOutput);

    expect(redacted).toContain(BOOTSTRAP_REDACTION);
    expect(redacted).not.toContain("dop_v1_super_secret");
    expect(redacted).not.toContain("agb_reg_1234567890123456789012345678901234567890123");
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
