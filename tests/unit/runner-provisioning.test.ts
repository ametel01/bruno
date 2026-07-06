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
      ["creating", "started"],
      ["creating", "completed"],
      ["tagging", "started"],
      ["tagging", "completed"],
      ["firewall_configuring", "started"],
      ["firewall_configuring", "completed"],
      ["waiting_for_runner", "started"],
    ]);
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
      ["creating", "started"],
      ["failed", "failed"],
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
