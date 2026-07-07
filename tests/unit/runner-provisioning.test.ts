import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
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
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
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
          sshKeyIds: ["52830696"],
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
          firewallName: "agentbay-runners-droplet-1",
          sshSourceAddresses: ["0.0.0.0/0", "::/0"],
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
    ).toContain("AGENTBAY_RUNNER_BEARER_TOKEN=runner-command-token");
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain("AGENTBAY_RUNNER_IMAGE=ghcr.io/ametel01/agentbay-runner:sha-123");
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain(
      "AGENTBAY_RUNNER_ENDPOINT_URL=https://$" + "{AGENTBAY_PUBLIC_IPV4_DASHED}.sslip.io",
    );
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).not.toContain("AGENTBAY_RUNNER_ENDPOINT_URL=http://127.0.0.1:3045");
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain("docker pull 'ghcr.io/ametel01/agentbay-runner:sha-123'");
    expect(
      (provider.calls.find((call) => call.step === "create")?.input as { userData?: string })
        .userData,
    ).toContain(
      "docker run --detach --name 'agentbay-runner' --restart always --env-file '/etc/agentbay/runner.env' -p '127.0.0.1:3045:3045' 'ghcr.io/ametel01/agentbay-runner:sha-123'",
    );
    expect(
      result.runner.provisioning.phases.find((event) => event.phase === "pending")?.metadata,
    ).toMatchObject({
      provider: "digitalocean",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
    });
    expect(
      result.runner.provisioning.phases.find((event) => event.phase === "bootstrapping")?.metadata,
    ).toMatchObject({
      provider: "digitalocean",
      registrationToken: "injected",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
    });
    expect(
      result.runner.provisioning.phases.find(
        (event) => event.phase === "creating" && event.status === "started",
      )?.metadata,
    ).toMatchObject({
      runnerImage: "ghcr.io/ametel01/agentbay-runner:sha-123",
      sshKeyCount: 1,
    });
    expect(
      result.runner.provisioning.phases.find(
        (event) => event.phase === "firewall_configuring" && event.status === "completed",
      )?.metadata,
    ).toMatchObject({
      firewallApplied: true,
      firewallName: "agentbay-runners-droplet-1",
    });

    const persistedTokens = await connection.db.select().from(runnerRegistrationTokens);
    const [persistedRunner] = await connection.db
      .select({ endpointUrl: runners.endpointUrl })
      .from(runners)
      .limit(1);
    const persistedEvents = await connection.db.select().from(runnerProvisioningEvents);
    const serializedResult = JSON.stringify(result);
    const serializedPersistence = JSON.stringify([persistedTokens, persistedEvents]);

    expect(persistedTokens).toHaveLength(1);
    expect(persistedRunner?.endpointUrl).toBe("https://203-0-113-10.sslip.io");
    expect(persistedTokens[0]).toMatchObject({
      runnerId: result.runner.id,
      tokenHash: generatedRegistrationToken.hash,
      tokenPrefix: generatedRegistrationToken.prefix,
      status: "pending",
      expiresAt: new Date("2026-07-06T03:00:00.000Z"),
    });
    expect(serializedResult).not.toContain(generatedRegistrationToken.value);
    expect(serializedResult).not.toContain(generatedRegistrationToken.hash);
    expect(serializedResult).not.toContain("dop_v1_super_secret");
    expect(serializedPersistence).not.toContain(generatedRegistrationToken.value);
    expect(serializedPersistence).not.toContain("dop_v1_super_secret");
  });

  it("creates a managed DigitalOcean SSH key before creating a Droplet when the account has none", async () => {
    const provider = new FakeDigitalOceanProvider({ sshKeys: [] });

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "No SSH Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
        now: sequenceClock("2026-07-06T02:30:00.000Z"),
      },
    );

    expect(result).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        status: "registering",
        providerResourceId: "do-fake-1",
        provisioning: {
          status: "waiting_for_runner",
          error: null,
        },
      },
    });
    expect(provider.calls[0]).toMatchObject({
      step: "createSshKey",
      input: {
        name: "AgentBay managed runner key",
        publicKey: expect.stringMatching(/^ssh-ed25519 [A-Za-z0-9+/=]+ agentbay-managed-runner$/),
      },
    });
    expect(provider.calls[1]).toMatchObject({
      step: "create",
      input: {
        sshKeyIds: ["ssh-key-1"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
  });

  it("injects swap setup when provisioning the default low-memory DigitalOcean size", async () => {
    const provider = new FakeDigitalOceanProvider();

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Low Memory Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
          region: "sfo3",
          sizeSlug: "s-1vcpu-512mb-10gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "cloud-runner"],
        }),
        now: sequenceClock("2026-07-06T06:00:00.000Z"),
      },
    );
    const userData = (
      provider.calls.find((call) => call.step === "create")?.input as {
        userData?: string;
      }
    ).userData;

    expect(result).toMatchObject({ ok: true, duplicate: false });
    expect(userData).toContain("fallocate -l 1G /swapfile");
    expect(userData).toContain("mkswap /swapfile");
    expect(userData).toContain("swapon /swapfile");
    expect(userData).toContain("/var/log/agentbay-bootstrap.log");
  });

  it("polls DigitalOcean until a Droplet public IPv4 is available", async () => {
    const provider = new FakeDigitalOceanProvider({
      publicIpv4: null,
      idPrefix: "droplet",
    });
    const readResource = provider.readResource.bind(provider);
    let readCount = 0;
    provider.readResource = async (input) => {
      readCount += 1;

      if (readCount === 3) {
        const existing = provider.resources.get(input.providerResourceId);

        if (existing) {
          provider.resources.set(input.providerResourceId, {
            ...existing,
            publicIpv4: "203.0.113.77",
          });
        }
      }

      return readResource(input);
    };

    const result = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Polling Runner" },
      {
        createConnection: () => connection,
        provider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
          region: "sfo3",
          sizeSlug: "s-1vcpu-512mb-10gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay", "cloud-runner"],
        }),
        publicEndpointPollAttempts: 3,
        publicEndpointPollIntervalMs: 0,
        now: sequenceClock("2026-07-06T08:00:00.000Z"),
      },
    );

    const [persistedRunner] = await connection.db
      .select({ endpointUrl: runners.endpointUrl })
      .from(runners)
      .limit(1);

    expect(result).toMatchObject({
      ok: true,
      runner: {
        status: "registering",
        provisioning: { status: "waiting_for_runner" },
      },
    });
    expect(readCount).toBe(3);
    expect(persistedRunner?.endpointUrl).toBe("https://203-0-113-77.sslip.io");
  });

  it("does not reuse a stale waiting_for_runner row when creating a new cloud runner", async () => {
    const staleProvider = new FakeDigitalOceanProvider({
      idPrefix: "stale-droplet",
    });
    const freshProvider = new FakeDigitalOceanProvider({
      idPrefix: "fresh-droplet",
      publicIpv4: "203.0.113.11",
    });
    const config = {
      token: "dop_v1_super_secret",
      runnerBearerToken: "runner-command-token",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "cloud-runner"],
    };

    const first = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Stale Runner" },
      {
        createConnection: () => connection,
        provider: staleProvider,
        readConfig: () => config,
        now: sequenceClock("2026-07-06T01:00:00.000Z"),
      },
    );
    const second = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Fresh Runner" },
      {
        createConnection: () => connection,
        provider: freshProvider,
        readConfig: () => config,
        now: sequenceClock("2026-07-06T02:30:00.000Z"),
      },
    );

    expect(first).toMatchObject({
      ok: true,
      duplicate: false,
      runner: { providerResourceId: "stale-droplet-1" },
    });
    expect(second).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        name: "Fresh Runner",
        status: "registering",
        providerResourceId: "fresh-droplet-1",
        provisioning: { status: "waiting_for_runner" },
      },
    });
    expect(freshProvider.calls.map((call) => call.step)).toEqual(["create", "tag", "firewall"]);

    if (!first.ok) {
      throw new Error("Expected initial provisioning to succeed.");
    }

    const [staleRunner] = await connection.db
      .select({
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        provisioningError: runners.provisioningError,
      })
      .from(runners)
      .where(eq(runners.id, first.runner.id))
      .limit(1);

    expect(staleRunner).toMatchObject({
      status: "provision_failed",
      provisioningStatus: "failed",
      provisioningError: expect.stringContaining(
        "Cloud runner bootstrap did not register before the timeout.",
      ),
    });
  });

  it("does not reuse a waiting_for_runner row when the provider Droplet was manually deleted", async () => {
    const staleProvider = new FakeDigitalOceanProvider({
      idPrefix: "deleted-droplet",
    });
    const freshProvider = new FakeDigitalOceanProvider({
      idPrefix: "replacement-droplet",
      publicIpv4: "203.0.113.12",
    });
    const config = {
      token: "dop_v1_super_secret",
      runnerBearerToken: "runner-command-token",
      runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "cloud-runner"],
    };

    const first = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Deleted Runner" },
      {
        createConnection: () => connection,
        provider: staleProvider,
        readConfig: () => config,
        now: sequenceClock("2026-07-06T01:00:00.000Z"),
      },
    );
    const second = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Replacement Runner" },
      {
        createConnection: () => connection,
        provider: freshProvider,
        readConfig: () => config,
        now: sequenceClock("2026-07-06T01:10:00.000Z"),
      },
    );

    expect(first).toMatchObject({
      ok: true,
      duplicate: false,
      runner: { providerResourceId: "deleted-droplet-1" },
    });
    expect(second).toMatchObject({
      ok: true,
      duplicate: false,
      runner: {
        name: "Replacement Runner",
        providerResourceId: "replacement-droplet-1",
      },
    });

    if (!first.ok) {
      throw new Error("Expected initial provisioning to succeed.");
    }

    const [deletedRunner] = await connection.db
      .select({
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        provisioningError: runners.provisioningError,
      })
      .from(runners)
      .where(eq(runners.id, first.runner.id))
      .limit(1);

    expect(deletedRunner).toMatchObject({
      status: "provision_failed",
      provisioningStatus: "failed",
      provisioningError:
        "DigitalOcean Droplet deleted-droplet-1 is no longer available for runner registration. AgentBay marked the stale runner failed and will create a new runner.",
    });
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
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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

    const first = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "First Runner" },
      {
        createConnection: () => connection,
        provider: firstProvider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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
        provider: firstProvider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
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
    expect(firstProvider.calls.map((call) => call.step)).toEqual(["create", "tag", "firewall"]);
    await expect(countRows(connection, "runners")).resolves.toBe(1);
    await expect(countRows(connection, "runner_registration_tokens")).resolves.toBe(1);
  });

  it("reuses an existing in-progress runner before requiring provider config", async () => {
    const firstProvider = new FakeDigitalOceanProvider({ idPrefix: "first-droplet" });
    const secondProvider = new FakeDigitalOceanProvider({ idPrefix: "second-droplet" });

    const first = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "First Runner" },
      {
        createConnection: () => connection,
        provider: firstProvider,
        readConfig: () => ({
          token: "dop_v1_super_secret",
          runnerBearerToken: "runner-command-token",
          runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
          region: "sfo3",
          sizeSlug: "s-1vcpu-1gb",
          image: "ubuntu-24-04-x64",
          tags: ["agentbay"],
        }),
      },
    );
    const second = await createDigitalOceanRunnerForDevelopmentUser(
      { provider: "digitalocean", name: "Second Runner" },
      {
        createConnection: () => connection,
        provider: secondProvider,
        readConfig: () => null,
      },
    );

    expect(first).toMatchObject({ ok: true, duplicate: false });
    expect(second).toMatchObject({ ok: true, duplicate: true });

    if (!first.ok || !second.ok) {
      throw new Error("Expected duplicate create calls to return runner state.");
    }

    expect(second.runner.id).toBe(first.runner.id);
    expect(secondProvider.calls).toEqual([]);
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
