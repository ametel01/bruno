import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanProvider,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { LocalDockerDigitalOceanProvider } from "@/src/server/runners/local-docker-digitalocean-provider";
import {
  advanceAutomaticDigitalOceanRunnerProvisioning,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";

const USER_ID = "00000000-0000-4000-8000-00000000b701";
const RUNNER_ID = "00000000-0000-4000-8000-00000000b721";
const OPERATION_KEY = "agentbay-deploy-0000000000004000800000000000b731";
const NOW = new Date("2026-08-03T09:00:00.000Z");

describe("automatic DigitalOcean runner provisioning", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
    await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
    await seedProvisioningRunner(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("drains the normal fake provider path to waiting_for_runner in one bounded call", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "automatic" });
    const now = sequenceClock("2026-08-03T09:00:00.000Z");

    await expect(advance(connection, provider, 1, undefined, now)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    expect(provider.calls.map((call) => call.step)).toEqual(["discover", "create", "firewall"]);
    const createCall = provider.calls.find((call) => call.step === "create");
    expect(createCall?.input).toMatchObject({
      name: OPERATION_KEY,
      tags: expect.arrayContaining([OPERATION_KEY]),
    });
    expect(provider.calls.filter((call) => call.step === "tag")).toHaveLength(0);
    const [afterDrain] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, RUNNER_ID));
    expect(afterDrain).toMatchObject({
      provisioningOperationKey: OPERATION_KEY,
      provisioningStatus: "waiting_for_runner",
      status: "registering",
      providerResourceId: "automatic-1",
      providerFirewallId: "automatic-firewall-1",
      endpointUrl: "https://203-0-113-10.sslip.io",
    });

    const emitted = await connection.db
      .select({
        phase: runnerProvisioningEvents.phase,
        status: runnerProvisioningEvents.status,
        createdAt: runnerProvisioningEvents.createdAt,
      })
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, RUNNER_ID))
      .orderBy(runnerProvisioningEvents.createdAt);

    expect(emitted.map((event) => [event.phase, event.status])).toEqual([
      ["bootstrapping", "started"],
      ["creating", "started"],
      ["creating", "completed"],
      ["tagging", "started"],
      ["tagging", "completed"],
      ["firewall_configuring", "started"],
      ["firewall_configuring", "completed"],
      ["waiting_for_runner", "started"],
    ]);

    for (const phase of ["creating", "tagging", "firewall_configuring"] as const) {
      const startedAt = emitted.find(
        (event) => event.phase === phase && event.status === "started",
      )?.createdAt;
      const completedAt = emitted.find(
        (event) => event.phase === phase && event.status === "completed",
      )?.createdAt;

      expect(startedAt).toBeInstanceOf(Date);
      expect(completedAt).toBeInstanceOf(Date);
      expect((completedAt as Date).getTime()).toBeGreaterThan((startedAt as Date).getTime());
    }
  });

  it("drains the local Docker provider path to waiting_for_runner in one bounded call", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      endpointUrl: "http://127.0.0.1:3045",
      now: () => NOW,
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await expect(
      advance(connection, provider, 1, undefined, () => NOW, localDockerProviderConfig()),
    ).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "local-docker-droplet",
      providerFirewallId: expect.stringMatching(/^local-docker-firewall-/),
      provisioningStatus: "waiting_for_runner",
      status: "registering",
      endpointUrl: "http://127.0.0.1:3045",
    });
    const discovered = await provider.discoverResourcesByTag({ tag: OPERATION_KEY });
    expect(discovered).toMatchObject({
      ok: true,
      value: {
        authoritative: true,
        resources: [
          expect.objectContaining({
            providerResourceId: "local-docker-droplet",
            firewallApplied: true,
            providerFirewallName: "agentbay-runners-local-docker-droplet",
            tags: expect.arrayContaining([OPERATION_KEY, "agentbay", "agentbay-runner"]),
          }),
        ],
      },
    });
    expect(dockerCalls.filter((call) => call[0] === "run")).toHaveLength(1);
  });

  it("adopts one exact-tag resource after a crash without issuing a second create", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "adopted" });
    const created = await provider.createRunner({
      name: OPERATION_KEY,
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: [OPERATION_KEY],
    });
    expect(created.ok).toBe(true);
    provider.calls.length = 0;

    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    expect(provider.calls.map((call) => call.step)).toEqual(["discover", "tag", "firewall"]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "adopted-1",
      provisioningStatus: "waiting_for_runner",
      status: "registering",
    });
  });

  it("resumes after a create effect crash without replaying create", async () => {
    const provider = new CrashAfterEffectProvider(
      new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "crash-create" }),
      "create",
    );

    await expect(advance(connection, provider)).rejects.toThrow("crash after create");
    expect(provider.base.calls.map((call) => call.step)).toEqual(["discover", "create"]);

    provider.crashStep = null;
    provider.base.calls.length = 0;
    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    expect(provider.base.calls.filter((call) => call.step === "create")).toHaveLength(0);
    expect(provider.base.calls.map((call) => call.step)).toEqual(["discover", "firewall"]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "crash-create-1",
      providerFirewallId: "crash-create-firewall-1",
      provisioningStatus: "waiting_for_runner",
      status: "registering",
    });
  });

  it("resumes after a tag effect crash without replaying a completed tag", async () => {
    const provider = new CrashAfterEffectProvider(
      new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "crash-tag" }),
      "tag",
    );

    provider.base.createRunner = async (...args) => {
      const created = await FakeDigitalOceanProvider.prototype.createRunner.apply(
        provider.base,
        args,
      );
      if (created.ok) {
        const resource = provider.base.resources.get(created.value.providerResourceId);
        if (resource) resource.tags = [OPERATION_KEY];
      }
      return created;
    };

    await expect(advance(connection, provider)).rejects.toThrow("crash after tag");
    expect(provider.base.calls.map((call) => call.step)).toEqual(["discover", "create", "tag"]);

    provider.crashStep = null;
    provider.base.calls.length = 0;
    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    expect(provider.base.calls.filter((call) => call.step === "tag")).toHaveLength(0);
    expect(provider.base.calls.map((call) => call.step)).toEqual(["firewall"]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "crash-tag-1",
      providerFirewallId: "crash-tag-firewall-1",
      provisioningStatus: "waiting_for_runner",
      status: "registering",
    });
  });

  it("resumes after a firewall effect crash without replaying firewall creation", async () => {
    const provider = new CrashAfterEffectProvider(
      new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "crash-firewall" }),
      "firewall",
    );

    await expect(advance(connection, provider)).rejects.toThrow("crash after firewall");
    expect(provider.base.calls.map((call) => call.step)).toEqual([
      "discover",
      "create",
      "firewall",
    ]);

    provider.crashStep = null;
    provider.base.calls.length = 0;
    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    expect(provider.base.calls.filter((call) => call.step === "firewall")).toHaveLength(0);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "crash-firewall-1",
      providerFirewallId: "crash-firewall-firewall-1",
      provisioningStatus: "waiting_for_runner",
      status: "registering",
    });
  });

  it("cleans up the exact owned Droplet after a terminal runner boot failure", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "failed-boot" });
    const created = await provider.createRunner({
      name: OPERATION_KEY,
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "agentbay-runner", OPERATION_KEY],
    });
    if (!created.ok) throw new Error("Expected fake Droplet creation to succeed.");
    await provider.tagResource({
      providerResourceId: created.value.providerResourceId,
      tags: ["agentbay", "agentbay-runner", OPERATION_KEY],
    });
    const firewalled = await provider.applyFirewall({
      providerResourceId: created.value.providerResourceId,
      firewallName: digitalOceanRunnerFirewallName(created.value.providerResourceId),
    });
    if (!firewalled.ok || !firewalled.value.providerFirewallId) {
      throw new Error("Expected fake firewall creation to succeed.");
    }
    await connection.db
      .update(runners)
      .set({
        status: "provision_failed",
        provisioningStatus: "failed",
        providerResourceId: created.value.providerResourceId,
        providerFirewallId: firewalled.value.providerFirewallId,
      })
      .where(eq(runners.id, RUNNER_ID));
    provider.calls.length = 0;

    await expect(advance(connection, provider)).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    });

    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    const discovery = await provider.discoverResourcesByTag({ tag: OPERATION_KEY });
    expect(runner).toMatchObject({
      status: "deleted",
      provisioningStatus: "deleted",
      deletedAt: NOW,
    });
    expect(discovery).toMatchObject({ ok: true, value: { resources: [] } });
    expect(provider.calls.map((call) => call.step)).not.toContain("create");
  });

  it("replays one operation tag without duplicating the token or billable create", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "replayed" });

    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });
    await connection.db
      .update(runners)
      .set({ provisioningStatus: "pending", providerResourceId: null })
      .where(eq(runners.id, RUNNER_ID));

    await expect(advance(connection, provider)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "external_wait",
    });

    const tokens = await connection.db
      .select({ id: runnerRegistrationTokens.id })
      .from(runnerRegistrationTokens)
      .where(eq(runnerRegistrationTokens.runnerId, RUNNER_ID));
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(tokens).toHaveLength(1);
    expect(provider.calls.filter((call) => call.step === "create")).toHaveLength(1);
    expect(runner).toMatchObject({
      providerResourceId: "replayed-1",
      provisioningStatus: "waiting_for_runner",
    });
  });

  it("fails automatic snapshot provisioning before any Droplet create when evidence is invalid", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });

    await expect(
      advance(connection, provider, 1, undefined, () => NOW, invalidSnapshotAutomaticConfig()),
    ).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    });

    expect(provider.calls.map((call) => call.step)).not.toContain("create");
  });

  it("fails closed on duplicate exact-tag resources and records only safe cleanup ownership", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "duplicate" });
    for (let index = 0; index < 2; index += 1) {
      await provider.createRunner({
        name: `${OPERATION_KEY}-${index}`,
        region: "sfo3",
        sizeSlug: "s-1vcpu-2gb",
        image: "ubuntu-24-04-x64",
        tags: [OPERATION_KEY],
      });
    }
    provider.calls.length = 0;

    await expect(advance(connection, provider)).resolves.toEqual({
      ok: false,
      cleanupRequired: true,
      terminalCode: "runner_provisioning_outcome_unknown",
    });

    expect(provider.calls.map((call) => call.step)).toEqual(["discover"]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, RUNNER_ID));
    expect(runner).toMatchObject({ status: "provision_failed", provisioningStatus: "failed" });
    expect(JSON.stringify(events)).not.toContain(OPERATION_KEY);
    expect(JSON.stringify(events)).not.toContain("duplicate-1");
  });

  it("treats non-authoritative discovery as ambiguous and never creates at the attempt bound", async () => {
    const base = new FakeDigitalOceanProvider({ now: () => NOW });
    const provider: DigitalOceanProvider = {
      ...base,
      listSshKeys: () => base.listSshKeys(),
      createSshKey: (input) => base.createSshKey(input),
      createRunner: (...args) => base.createRunner(...args),
      readResource: (input) => base.readResource(input),
      tagResource: (input) => base.tagResource(input),
      applyFirewall: (input) => base.applyFirewall(input),
      cleanupResource: (input) => base.cleanupResource(input),
      discoverResourcesByTag: async () => ({
        ok: true,
        value: { authoritative: false, resources: [] },
      }),
    };

    await expect(advance(connection, provider, 64)).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_outcome_unknown",
    });
    expect(base.calls.some((call) => call.step === "create")).toBe(false);
  });

  it("never repeats create after an ambiguous create outcome and authoritative-zero discovery", async () => {
    const base = new FakeDigitalOceanProvider({ now: () => NOW });
    let createCalls = 0;
    const provider: DigitalOceanProvider = {
      listSshKeys: () => base.listSshKeys(),
      createSshKey: (input) => base.createSshKey(input),
      createRunner: async () => {
        createCalls += 1;
        return {
          ok: false,
          reason: "create_outcome_unknown",
          message: "safe ambiguous create outcome",
        };
      },
      discoverResourcesByTag: async () => ({
        ok: true,
        value: { authoritative: true, resources: [] },
      }),
      readResource: (input) => base.readResource(input),
      tagResource: (input) => base.tagResource(input),
      applyFirewall: (input) => base.applyFirewall(input),
      cleanupResource: (input) => base.cleanupResource(input),
    };

    await expect(advance(connection, provider, 1)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "observation_wait",
    });
    await expect(advance(connection, provider, 2)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "observation_wait",
    });
    await expect(advance(connection, provider, 64)).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_outcome_unknown",
    });
    expect(createCalls).toBe(1);
  });

  it("honors an already-aborted provider action without issuing a billable create", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    const controller = new AbortController();
    controller.abort();

    await expect(advance(connection, provider, 1, controller.signal)).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "immediate",
    });
    expect(provider.calls).toEqual([]);
  });

  it("rejects incompatible resources before discovery, SSH lookup, or create", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });

    await expect(
      advance(connection, provider, 1, undefined, () => NOW, {
        ...providerConfig(),
        sizeSlug: "s-1vcpu-512mb-10gb",
      }),
    ).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    });

    expect(provider.calls).toEqual([]);

    await resetTables(connection);
    await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
    await seedProvisioningRunner(connection);

    await expect(
      advance(connection, provider, 1, undefined, () => NOW, {
        ...providerConfig(),
        sizeSlug: "toString",
      }),
    ).resolves.toEqual({
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    });
    expect(provider.calls).toEqual([]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      status: "provision_failed",
      provisioningStatus: "failed",
      providerResourceId: null,
    });
  });

  it("honors abort before every fake provider transport phase", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    const controller = new AbortController();
    controller.abort();
    const context = { signal: controller.signal };

    await Promise.all([
      provider.listSshKeys(context),
      provider.createSshKey({ name: "key", publicKey: "ssh-ed25519 fake" }, context),
      provider.createRunner(
        {
          name: "runner",
          region: "sfo3",
          sizeSlug: "s-1vcpu-2gb",
          image: "ubuntu-24-04-x64",
          tags: [OPERATION_KEY],
        },
        context,
      ),
      provider.discoverResourcesByTag({ tag: OPERATION_KEY }, context),
      provider.readResource({ providerResourceId: "resource" }, context),
      provider.tagResource({ providerResourceId: "resource", tags: [OPERATION_KEY] }, context),
      provider.applyFirewall({ providerResourceId: "resource", firewallName: "firewall" }, context),
      provider.cleanupResource({ providerResourceId: "resource" }, context),
    ]);

    expect(provider.calls).toEqual([]);
  });
});

class CrashAfterEffectProvider implements DigitalOceanProvider {
  constructor(
    readonly base: FakeDigitalOceanProvider,
    public crashStep: "create" | "tag" | "firewall" | null,
  ) {}

  listSshKeys(...args: Parameters<DigitalOceanProvider["listSshKeys"]>) {
    return this.base.listSshKeys(...args);
  }

  createSshKey(...args: Parameters<DigitalOceanProvider["createSshKey"]>) {
    return this.base.createSshKey(...args);
  }

  discoverResourcesByTag(...args: Parameters<DigitalOceanProvider["discoverResourcesByTag"]>) {
    return this.base.discoverResourcesByTag(...args);
  }

  listManagedResources(
    ...args: Parameters<NonNullable<DigitalOceanProvider["listManagedResources"]>>
  ) {
    return this.base.listManagedResources(...args);
  }

  readResource(...args: Parameters<DigitalOceanProvider["readResource"]>) {
    return this.base.readResource(...args);
  }

  async createRunner(...args: Parameters<DigitalOceanProvider["createRunner"]>) {
    const result = await this.base.createRunner(...args);
    if (result.ok && this.crashStep === "create") throw new Error("crash after create");
    return result;
  }

  async tagResource(...args: Parameters<DigitalOceanProvider["tagResource"]>) {
    const result = await this.base.tagResource(...args);
    if (result.ok && this.crashStep === "tag") throw new Error("crash after tag");
    return result;
  }

  async applyFirewall(...args: Parameters<DigitalOceanProvider["applyFirewall"]>) {
    const result = await this.base.applyFirewall(...args);
    if (result.ok && this.crashStep === "firewall") throw new Error("crash after firewall");
    return result;
  }

  cleanupResource(...args: Parameters<DigitalOceanProvider["cleanupResource"]>) {
    return this.base.cleanupResource(...args);
  }
}

function advance(
  connection: DatabaseConnection,
  provider: DigitalOceanProvider,
  attemptCount = 1,
  signal = new AbortController().signal,
  now: () => Date = () => NOW,
  config: DigitalOceanProviderConfig = providerConfig(),
) {
  return advanceAutomaticDigitalOceanRunnerProvisioning({
    connection,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    operationKey: OPERATION_KEY,
    attemptCount,
    maxAttempts: 64,
    config,
    provider,
    context: { signal },
    now,
  });
}

function invalidSnapshotAutomaticConfig(): DigitalOceanProviderConfig {
  const runnerImage = `ghcr.io/ametel01/agentbay-runner:abc123@sha256:${"a".repeat(64)}`;
  const defaultAgentImage = `ghcr.io/ametel01/agentbay-default:abc123@sha256:${"b".repeat(64)}`;

  return {
    ...providerConfig(),
    runnerImage,
    snapshotMode: {
      mode: "snapshot",
      manifestBytes: "{}",
      signature: "bad-signature",
      publicKeyPem: "bad-public-key",
      expected: {
        region: "sfo3",
        sizeDiskGb: 25,
        baseImageSlug: "ubuntu-24-04-x64",
        architecture: "amd64",
        runnerImage,
        defaultAgentImage,
        hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
        sourceRepository: "ametel01/bruno",
        sourceRevision: "1".repeat(40),
        now: NOW,
      },
    },
  };
}

function sequenceClock(startIso: string): () => Date {
  let currentMs = new Date(startIso).getTime();
  return () => {
    const current = new Date(currentMs);
    currentMs += 1_000;
    return current;
  };
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: "agentbay-runner:test",
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "agentbay-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}

function localDockerProviderConfig(): DigitalOceanProviderConfig {
  return {
    ...providerConfig(),
    token: "local-docker",
    providerMode: "local_docker",
    runnerImage: "agentbay-runner:local",
    localRunnerEndpointUrl: "http://127.0.0.1:3045",
  };
}

async function seedProvisioningRunner(connection: DatabaseConnection): Promise<void> {
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: "Automatic Runner",
    kind: "digitalocean",
    status: "provisioning",
    provider: DIGITALOCEAN_PROVIDER,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    provisioningStatus: "pending",
    provisioningOperationKey: OPERATION_KEY,
    provisioningStartedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_registration_tokens, runners, users restart identity cascade`;
}
