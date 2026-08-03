import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerProvisioningEvents, runners, users } from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanProvider,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { advanceAutomaticDigitalOceanRunnerProvisioning } from "@/src/server/runners/runner-provisioning";

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

  it("persists the operation key before create and advances exactly one provider phase per call", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "automatic" });

    await expect(advance(connection, provider)).resolves.toEqual({ ok: true, state: "pending" });

    expect(provider.calls.map((call) => call.step)).toEqual(["discover", "create"]);
    const createCall = provider.calls.find((call) => call.step === "create");
    expect(createCall?.input).toMatchObject({
      name: OPERATION_KEY,
      tags: expect.arrayContaining([OPERATION_KEY]),
    });
    const [afterCreate] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, RUNNER_ID));
    expect(afterCreate).toMatchObject({
      provisioningOperationKey: OPERATION_KEY,
      provisioningStatus: "tagging",
      providerResourceId: "automatic-1",
    });

    provider.calls.length = 0;
    await expect(advance(connection, provider)).resolves.toEqual({ ok: true, state: "pending" });
    expect(provider.calls.map((call) => call.step)).toEqual(["tag"]);
    const [afterTag] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(afterTag?.provisioningStatus).toBe("firewall_configuring");

    provider.calls.length = 0;
    await expect(advance(connection, provider)).resolves.toEqual({ ok: true, state: "pending" });
    expect(provider.calls.map((call) => call.step)).toEqual(["firewall"]);
    const [afterFirewall] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, RUNNER_ID));
    expect(afterFirewall).toMatchObject({
      provisioningStatus: "waiting_for_runner",
      status: "registering",
    });
  });

  it("adopts one exact-tag resource after a crash without issuing a second create", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "adopted" });
    const created = await provider.createRunner({
      name: OPERATION_KEY,
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: [OPERATION_KEY],
    });
    expect(created.ok).toBe(true);
    provider.calls.length = 0;

    await expect(advance(connection, provider)).resolves.toEqual({ ok: true, state: "pending" });

    expect(provider.calls.map((call) => call.step)).toEqual(["discover"]);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      providerResourceId: "adopted-1",
      provisioningStatus: "tagging",
    });
  });

  it("fails closed on duplicate exact-tag resources and records only safe cleanup ownership", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW, idPrefix: "duplicate" });
    for (let index = 0; index < 2; index += 1) {
      await provider.createRunner({
        name: `${OPERATION_KEY}-${index}`,
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
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
    });
    await expect(advance(connection, provider, 2)).resolves.toEqual({
      ok: true,
      state: "pending",
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
    });
    expect(provider.calls).toEqual([]);
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
          sizeSlug: "s-1vcpu-1gb",
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

function advance(
  connection: DatabaseConnection,
  provider: DigitalOceanProvider,
  attemptCount = 1,
  signal = new AbortController().signal,
) {
  return advanceAutomaticDigitalOceanRunnerProvisioning({
    connection,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    operationKey: OPERATION_KEY,
    attemptCount,
    maxAttempts: 64,
    config: providerConfig(),
    provider,
    context: { signal },
    now: () => NOW,
  });
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: "agentbay-runner:test",
    region: "sfo3",
    sizeSlug: "s-1vcpu-1gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", "agentbay-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
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
    sizeSlug: "s-1vcpu-1gb",
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
