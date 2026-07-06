import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerProvisioningEvents, runnerRegistrationTokens } from "@/src/server/db/schema";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import { createRunnerRegistrationToken } from "@/src/server/runners/runner-auth-secrets";
import { createDigitalOceanRunnerForDevelopmentUser } from "@/src/server/runners/runner-provisioning";

describe.sequential("runner provisioning service", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("creates a DigitalOcean runner, records every provisioning phase, and stores only hashed registration token material", async () => {
    const provider = new FakeDigitalOceanProvider({
      now: () => new Date("2026-07-06T02:00:10.000Z"),
      idPrefix: "droplet",
    });
    const generatedRegistrationToken = createRunnerRegistrationToken();

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Cloud Runner 1" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "nyc3",
          sizeSlug: "s-2vcpu-2gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "cloud-runner"],
        }),
        createRegistrationToken: () => generatedRegistrationToken,
        now: sequenceClock("2026-07-06T02:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        name: "Cloud Runner 1",
        kind: "digitalocean",
        status: "registering",
        provider: "digitalocean",
        providerResourceId: "droplet-1",
        region: "nyc3",
        sizeSlug: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
        provisioning: {
          status: "waiting_for_runner",
          error: null,
          completedAt: null,
        },
      },
    });

    if (!result.ok) {
      throw new Error("Expected provisioning to succeed.");
    }

    expect(provider.calls).toEqual([
      {
        step: "create",
        input: {
          name: "Cloud Runner 1",
          region: "nyc3",
          sizeSlug: "s-2vcpu-2gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "cloud-runner"],
          firewallName: "agentbay-runners",
          userData: expect.stringContaining("AGENTBAY_RUNNER_REGISTRATION_TOKEN="),
        },
      },
      {
        step: "tag",
        input: {
          providerResourceId: "droplet-1",
          tags: ["agentbay", "cloud-runner"],
        },
      },
      {
        step: "firewall",
        input: {
          providerResourceId: "droplet-1",
          firewallName: "agentbay-runners",
        },
      },
    ]);

    expect(result.runner.provisioning.phases.map((event) => [event.phase, event.status])).toEqual([
      ["pending", "started"],
      ["bootstrapping", "started"],
      ["creating", "started"],
      ["creating", "completed"],
      ["tagging", "started"],
      ["tagging", "completed"],
      ["firewall_configuring", "started"],
      ["firewall_configuring", "completed"],
      ["waiting_for_runner", "started"],
    ]);
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain(generatedRegistrationToken.value);
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain("ExecStartPre=/root/.bun/bin/bun run runner:bootstrap");
    expect(
      result.runner.provisioning.phases.find((event) => event.phase === "bootstrapping")?.metadata,
    ).toMatchObject({
      provider: "digitalocean",
      registrationToken: "injected",
    });
    expect(
      result.runner.provisioning.phases.find(
        (event) => event.phase === "firewall_configuring" && event.status === "completed",
      )?.metadata,
    ).toMatchObject({
      firewallApplied: true,
      firewallName: "agentbay-runners",
    });

    const persistedTokens = await connection.db.select().from(runnerRegistrationTokens);
    const persistedEvents = await connection.db.select().from(runnerProvisioningEvents);
    const serializedResult = JSON.stringify(result);
    const serializedPersistence = JSON.stringify([persistedTokens, persistedEvents]);

    expect(persistedTokens).toHaveLength(1);
    expect(persistedTokens[0]).toMatchObject({
      runnerId: result.runner.id,
      tokenHash: generatedRegistrationToken.hash,
      tokenPrefix: generatedRegistrationToken.prefix,
      status: "pending",
    });
    expect(serializedResult).not.toContain(generatedRegistrationToken.value);
    expect(serializedResult).not.toContain(generatedRegistrationToken.hash);
    expect(serializedResult).not.toContain("dop_v1_super_secret");
    expect(serializedPersistence).not.toContain(generatedRegistrationToken.value);
    expect(serializedPersistence).not.toContain("dop_v1_super_secret");
  });

  it("persists a safe actionable failed state when the provider create step fails", async () => {
    const provider = new FakeDigitalOceanProvider({
      fail: { create: "dop_v1_real_secret leaked by provider" },
    });

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Failure Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
        now: sequenceClock("2026-07-06T03:00:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        status: "provision_failed",
        providerResourceId: null,
        provisioning: {
          status: "failed",
          error:
            "DigitalOcean Droplet could not be created. Check provider quota, image, region, and token permissions.",
          completedAt: expect.any(String),
        },
      },
    });

    if (!result.ok) {
      throw new Error("Expected provider failure to return safe runner state.");
    }

    expect(result.runner.provisioning.phases.map((event) => [event.phase, event.status])).toEqual([
      ["pending", "started"],
      ["bootstrapping", "started"],
      ["creating", "started"],
      ["failed", "failed"],
    ]);
    expect(JSON.stringify(result)).not.toContain("dop_v1_real_secret");
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("cleans up an owned Droplet when provisioning fails after creation", async () => {
    const provider = new FakeDigitalOceanProvider({
      fail: { tag: "tag denied dop_v1_real_secret" },
      idPrefix: "owned-droplet",
    });

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Cleanup Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "agentbay-runner"],
        }),
        now: sequenceClock("2026-07-06T03:30:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        status: "deleted",
        providerResourceId: "owned-droplet-1",
        provisioning: {
          status: "deleted",
          error: null,
          completedAt: expect.any(String),
        },
      },
    });

    if (!result.ok) {
      throw new Error("Expected cleanup result to return safe runner state.");
    }

    expect(provider.calls.map((call) => call.step)).toEqual(["create", "tag", "cleanup"]);
    expect(result.runner.provisioning.phases.map((event) => [event.phase, event.status])).toEqual([
      ["pending", "started"],
      ["bootstrapping", "started"],
      ["creating", "started"],
      ["creating", "completed"],
      ["tagging", "started"],
      ["failed", "failed"],
      ["cleaning_up", "started"],
      ["deleted", "completed"],
    ]);
    expect(JSON.stringify(result)).not.toContain("dop_v1_real_secret");
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("returns manual cleanup instructions when owned Droplet cleanup cannot be confirmed", async () => {
    const provider = new FakeDigitalOceanProvider({
      fail: {
        firewall: "firewall denied dop_v1_real_secret",
        cleanup: "delete denied dop_v1_real_secret",
      },
      idPrefix: "manual-cleanup",
    });

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Manual Cleanup Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "agentbay-runner"],
        }),
        now: sequenceClock("2026-07-06T03:45:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        status: "provision_failed",
        providerResourceId: "manual-cleanup-1",
        provisioning: {
          status: "failed",
          error:
            "Automatic cleanup could not confirm deletion for DigitalOcean Droplet manual-cleanup-1. In DigitalOcean, delete only that Droplet after confirming it has the AgentBay runner tags, then create a new runner.",
          completedAt: expect.any(String),
        },
      },
    });

    if (!result.ok) {
      throw new Error("Expected manual cleanup result to return safe runner state.");
    }

    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "tag",
      "firewall",
      "cleanup",
    ]);
    expect(result.runner.provisioning.phases.map((event) => [event.phase, event.status])).toEqual([
      ["pending", "started"],
      ["bootstrapping", "started"],
      ["creating", "started"],
      ["creating", "completed"],
      ["tagging", "started"],
      ["tagging", "completed"],
      ["firewall_configuring", "started"],
      ["failed", "failed"],
      ["cleaning_up", "started"],
      ["cleaning_up", "failed"],
    ]);
    expect(JSON.stringify(result)).not.toContain("dop_v1_real_secret");
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("rejects invalid create input before touching the provider", async () => {
    const provider = new FakeDigitalOceanProvider();

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "aws", name: "x".repeat(81) },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
      },
    );

    expect(result).toEqual({
      ok: false,
      reason: "validation_failed",
      issues: [
        { field: "provider", message: "Provider must be digitalocean." },
        { field: "name", message: "Runner name must be 80 characters or fewer." },
      ],
    });
    expect(provider.calls).toEqual([]);
  });

  it("returns an existing in-progress runner for duplicate submit without creating another Droplet or token", async () => {
    const firstProvider = new FakeDigitalOceanProvider({ idPrefix: "first-droplet" });
    const secondProvider = new FakeDigitalOceanProvider({ idPrefix: "second-droplet" });

    const first = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "First Runner" },
      {
        createConnection: () => connection,
        provider: firstProvider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
        now: sequenceClock("2026-07-06T04:00:00.000Z"),
      },
    );
    const second = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Second Runner" },
      {
        createConnection: () => connection,
        provider: secondProvider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
        now: sequenceClock("2026-07-06T04:05:00.000Z"),
      },
    );

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });

    if (!first.ok || !second.ok) {
      throw new Error("Expected duplicate create calls to return runner state.");
    }

    expect(second.runner.id).toBe(first.runner.id);
    expect(second.runner.name).toBe("First Runner");
    expect(secondProvider.calls).toEqual([]);
    await expect(countRows(connection, "runners")).resolves.toBe(1);
    await expect(countRows(connection, "runner_registration_tokens")).resolves.toBe(1);
  });
});

function sequenceClock(startIso: string): () => Date {
  let tick = Date.parse(startIso);

  return () => {
    const value = new Date(tick);
    tick += 1000;
    return value;
  };
}

async function countRows(connection: DatabaseConnection, tableName: string): Promise<number> {
  const [result] = await connection.client<{ count: string }[]>`
    select count(*)::text as count from ${connection.client(tableName)}
  `;

  return Number(result?.count ?? 0);
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_credentials, runner_heartbeats, runner_registration_tokens, agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
