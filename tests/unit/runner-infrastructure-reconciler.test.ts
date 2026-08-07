import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agents,
  runnerInfrastructureOrphans,
  runnerReplacements,
  runners,
  users,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_MANAGED_RUNNER_TAG,
  DIGITALOCEAN_PROVIDER,
  type DigitalOceanResource,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { reconcileNextRunnerInfrastructure } from "@/src/server/runners/runner-infrastructure-reconciler";
import { digitalOceanRunnerFirewallName } from "@/src/server/runners/runner-provisioning";

const execFileAsync = promisify(execFile);
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://agentbay:agentbay@127.0.0.1:54329/bruno";
const USER_ID = "00000000-0000-4000-8000-000000008001";
const RUNNER_ID = "00000000-0000-4000-8000-000000008101";
const AGENT_ID = "00000000-0000-4000-8000-000000008201";
const SECOND_RUNNER_ID = "00000000-0000-4000-8000-000000008102";
const UUID = "88888888-8888-4888-8888-888888888888";
const OPERATION_TAG = `agentbay-deploy-${"8".repeat(32)}`;
const SECOND_OPERATION_TAG = `agentbay-deploy-${"9".repeat(32)}`;
const DIGEST = `sha256:${"8".repeat(64)}`;
const NOW = new Date("2026-08-04T12:00:00.000Z");
const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_NEXT_PUBLIC_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

describe("runner infrastructure reconciliation", () => {
  let databaseName: string;
  let databaseUrl: string;
  let connection: DatabaseConnection;

  beforeAll(async () => {
    ({ databaseName, databaseUrl } = await createDisposableDatabase());
    await runDbMigrate(databaseUrl);
    process.env.DATABASE_URL = databaseUrl;
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    connection = createDatabaseConnection(databaseUrl);
  });

  beforeEach(async () => {
    await connection.db.execute(sql`
      truncate table runner_infrastructure_orphans,
        runner_infrastructure_reconciliations, users restart identity cascade
    `);
    await connection.db.insert(users).values({ id: USER_ID, createdAt: NOW, updatedAt: NOW });
  });

  afterAll(async () => {
    await connection?.close();
    if (databaseName) await dropDisposableDatabase(databaseName);
    restoreEnvironment("DATABASE_URL", ORIGINAL_DATABASE_URL);
    restoreEnvironment("NEXT_PUBLIC_APP_URL", ORIGINAL_NEXT_PUBLIC_APP_URL);
  });

  it("recognizes exact inventory and starts replacement for exact but unhealthy assigned runners", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection);
    provider.resources.set("droplet-exact", resource("droplet-exact", OPERATION_TAG));

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "exact_match",
    });

    await connection.db.insert(agents).values(agentFixture());
    await connection.db
      .update(runners)
      .set({ status: "degraded", updatedAt: NOW })
      .where(eq(runners.id, RUNNER_ID));
    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "replacement_started",
    });
    const [replacement] = await connection.db.select().from(runnerReplacements);
    expect(replacement).toMatchObject({
      sourceRunnerId: RUNNER_ID,
      reason: "stale_heartbeat",
      state: "pending",
    });
  });

  it("never replaces an assigned runner while it is still waiting to register", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection, {
      status: "registering",
      provisioningStatus: "waiting_for_runner",
      provisioningCompletedAt: null,
      observedRunnerImageDigest: null,
      observedRunnerReleaseVersion: null,
      observedRunnerBootContractVersion: null,
      compatibilityState: "unknown",
      compatibilityVerifiedAt: null,
    });
    await connection.db.insert(agents).values(agentFixture({ status: "starting" }));
    provider.resources.set("droplet-exact", resource("droplet-exact", OPERATION_TAG));

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "exact_match",
    });
    expect(await connection.db.select().from(runnerReplacements)).toHaveLength(0);
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({
      status: "registering",
      provisioningStatus: "waiting_for_runner",
      compatibilityState: "unknown",
    });
  });

  it("never replaces an inventory-missing runner while provisioning is still in progress", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection, {
      status: "registering",
      provisioningStatus: "waiting_for_runner",
      provisioningCompletedAt: null,
      observedRunnerImageDigest: null,
      observedRunnerReleaseVersion: null,
      observedRunnerBootContractVersion: null,
      compatibilityState: "unknown",
      compatibilityVerifiedAt: null,
    });
    await connection.db.insert(agents).values(agentFixture({ status: "starting" }));

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "provisioning_in_progress",
    });
    expect(await connection.db.select().from(runnerReplacements)).toHaveLength(0);
  });

  it("revalidates replacement eligibility after locking the source runner", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection, { status: "degraded" });
    await connection.db.insert(agents).values(agentFixture());
    provider.resources.set("droplet-exact", resource("droplet-exact", OPERATION_TAG));

    const blocker = postgres(databaseUrl, { max: 1 });
    const observer = postgres(databaseUrl, { max: 1 });
    let releaseRunnerLock: () => void = () => undefined;
    let reportRunnerLocked: () => void = () => undefined;
    const runnerLockReleased = new Promise<void>((resolve) => {
      releaseRunnerLock = resolve;
    });
    const runnerLocked = new Promise<void>((resolve) => {
      reportRunnerLocked = resolve;
    });
    const blockerWork = blocker.begin(async (tx) => {
      await tx`select id from runners where id = ${RUNNER_ID} for update`;
      reportRunnerLocked();
      await runnerLockReleased;
      await tx`update runners set status = 'online', updated_at = ${NOW} where id = ${RUNNER_ID}`;
    });

    await runnerLocked;
    const reconciliation = reconcile(connection, provider);
    try {
      await waitForBlockedDatabaseSession(observer);
      releaseRunnerLock();
      await blockerWork;

      await expect(reconciliation).resolves.toEqual({
        processed: 1,
        outcome: "ambiguous_resource",
      });
      expect(await connection.db.select().from(runnerReplacements)).toHaveLength(0);
      const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
      expect(runner?.status).toBe("online");
    } finally {
      releaseRunnerLock();
      await Promise.allSettled([blockerWork, reconciliation]);
      await Promise.all([blocker.end(), observer.end()]);
    }
  });

  it("starts replacement for an assigned missing Droplet and tombstones an unassigned one", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection);
    await connection.db.insert(agents).values(agentFixture());

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "replacement_started",
    });
    expect((await connection.db.select().from(runnerReplacements))[0]).toMatchObject({
      sourceRunnerId: RUNNER_ID,
      reason: "provider_resource_missing",
    });

    await connection.db.execute(sql`
      truncate table runner_infrastructure_reconciliations, runner_replacements, agents cascade
    `);
    await connection.db
      .update(runners)
      .set({ status: "online", updatedAt: NOW })
      .where(eq(runners.id, RUNNER_ID));
    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "stale_runner_tombstoned",
    });
    const [runner] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(runner).toMatchObject({ status: "deleted", provisioningStatus: "deleted" });
    expect(runner?.deletedAt).not.toBeNull();
  });

  it("adopts one exact interrupted create and refuses duplicate operation resources", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection, { providerResourceId: null, status: "provisioning" });
    provider.resources.set("droplet-adopt", resource("droplet-adopt", OPERATION_TAG));

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "interrupted_runner_adopted",
    });
    const [adopted] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(adopted?.providerResourceId).toBe("droplet-adopt");

    await connection.db.execute(sql`truncate table runner_infrastructure_reconciliations`);
    await connection.db
      .update(runners)
      .set({ providerResourceId: null, updatedAt: NOW })
      .where(eq(runners.id, RUNNER_ID));
    provider.resources.set("droplet-duplicate", resource("droplet-duplicate", OPERATION_TAG));
    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "duplicate_resources",
    });
    const [unchanged] = await connection.db.select().from(runners).where(eq(runners.id, RUNNER_ID));
    expect(unchanged?.providerResourceId).toBeNull();
  });

  it("clears an assignment to a tombstoned runner without changing desired state", async () => {
    await seedRunner(connection, {
      status: "deleted",
      provisioningStatus: "deleted",
      deletedAt: NOW,
    });
    await connection.db.insert(agents).values(agentFixture({ desiredStatus: "running" }));

    await expect(reconcile(connection, new FakeDigitalOceanProvider())).resolves.toEqual({
      processed: 1,
      outcome: "stale_assignment_cleared",
    });
    const [agent] = await connection.db.select().from(agents).where(eq(agents.id, AGENT_ID));
    expect(agent).toMatchObject({ runnerId: null, desiredStatus: "running", status: "error" });
  });

  it("deletes only an exact owned orphan after two authoritative observations and grace", async () => {
    let now = NOW;
    const provider = new FakeDigitalOceanProvider({ now: () => now });
    const orphan = resource("orphan-owned", SECOND_OPERATION_TAG, "orphan-firewall");
    provider.resources.set(orphan.providerResourceId, orphan);
    provider.firewalls.set("orphan-firewall", {
      name: digitalOceanRunnerFirewallName(orphan.providerResourceId),
      providerResourceId: orphan.providerResourceId,
    });

    await expect(reconcile(connection, provider, () => now)).resolves.toEqual({
      processed: 1,
      outcome: "orphan_observed",
    });
    expect(provider.resources.get(orphan.providerResourceId)?.deletedAt).toBeNull();

    now = new Date(NOW.getTime() + 10 * 60 * 1_000);
    await expect(reconcile(connection, provider, () => now)).resolves.toEqual({
      processed: 1,
      outcome: "orphan_deleted",
    });
    const [evidence] = await connection.db.select().from(runnerInfrastructureOrphans);
    expect(evidence).toMatchObject({ observationCount: 2 });
    expect(evidence?.deletedAt).not.toBeNull();
    expect(provider.calls.map((call) => call.step)).toEqual(
      expect.arrayContaining(["deleteFirewall", "deleteDroplet"]),
    );
  });

  it("fails closed for ambiguous orphan ownership and never persists or deletes it", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    provider.resources.set("unowned", {
      ...resource("unowned", SECOND_OPERATION_TAG, "private-firewall"),
      name: "not-the-operation-tag",
    });

    await expect(reconcile(connection, provider)).resolves.toEqual({
      processed: 1,
      outcome: "ambiguous_resource",
    });
    expect(await connection.db.select().from(runnerInfrastructureOrphans)).toHaveLength(0);
    expect(provider.calls.some((call) => call.step.startsWith("delete"))).toBe(false);
  });

  it("leases concurrent invocations so only one performs inventory", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    const [left, right] = await Promise.all([
      reconcile(connection, provider),
      reconcile(connection, provider),
    ]);

    expect([left, right]).toEqual(
      expect.arrayContaining([
        { processed: 1, outcome: "exact_match" },
        { processed: 0, outcome: "idle" },
      ]),
    );
    expect(provider.calls.filter((call) => call.step === "discover")).toHaveLength(0);
  });

  it("never treats active ownership outside the DB batch as an orphan", async () => {
    const provider = new FakeDigitalOceanProvider({ now: () => NOW });
    await seedRunner(connection);
    await seedRunner(connection, {
      id: SECOND_RUNNER_ID,
      name: SECOND_OPERATION_TAG,
      providerResourceId: "droplet-second",
      providerFirewallId: "firewall-second",
      endpointUrl: "https://203.0.113.81:8787",
      provisioningOperationKey: SECOND_OPERATION_TAG,
      createdAt: new Date(NOW.getTime() + 1_000),
    });
    provider.resources.set("droplet-exact", resource("droplet-exact", OPERATION_TAG));
    provider.resources.set(
      "droplet-second",
      resource("droplet-second", SECOND_OPERATION_TAG, "firewall-second"),
    );

    await expect(
      reconcileNextRunnerInfrastructure({
        createConnection: () => connection,
        provider,
        readConfig: providerConfig,
        now: () => NOW,
        randomUUID: () => UUID,
        retryMs: 0,
        inventoryLimit: 1,
      }),
    ).resolves.toEqual({ processed: 1, outcome: "exact_match" });
    expect(await connection.db.select().from(runnerInfrastructureOrphans)).toHaveLength(0);
  });
});

async function reconcile(
  connection: DatabaseConnection,
  provider: FakeDigitalOceanProvider,
  now: () => Date = () => NOW,
) {
  return await reconcileNextRunnerInfrastructure({
    createConnection: () => connection,
    provider,
    readConfig: providerConfig,
    now,
    randomUUID: () => UUID,
    retryMs: 0,
  });
}

async function seedRunner(
  connection: DatabaseConnection,
  overrides: Partial<typeof runners.$inferInsert> = {},
): Promise<void> {
  await connection.db.insert(runners).values({
    id: RUNNER_ID,
    userId: USER_ID,
    name: OPERATION_TAG,
    kind: "digitalocean",
    endpointUrl: "https://203.0.113.80:8787",
    status: "online",
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: "droplet-exact",
    providerFirewallId: "firewall-exact",
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    provisioningStatus: "ready",
    provisioningOperationKey: OPERATION_TAG,
    provisioningStartedAt: NOW,
    provisioningCompletedAt: NOW,
    requiredRunnerImageDigest: DIGEST,
    observedRunnerImageDigest: DIGEST,
    observedRunnerReleaseVersion: "step8",
    observedRunnerBootContractVersion: "bruno.runner.boot.v1",
    compatibilityState: "compatible",
    compatibilityVerifiedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  });
}

function agentFixture(overrides: Partial<typeof agents.$inferInsert> = {}) {
  return {
    id: AGENT_ID,
    userId: USER_ID,
    runnerId: RUNNER_ID,
    name: "Infrastructure recovery agent",
    templateKey: "research_agent",
    status: "running" as const,
    desiredStatus: "running" as const,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(
  providerResourceId: string,
  operationTag: string,
  providerFirewallId: string | null = "firewall-exact",
): DigitalOceanResource {
  return {
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId,
    providerFirewallId,
    publicIpv4: "203.0.113.80",
    publicEndpointUrl: "https://203.0.113.80:8787",
    name: operationTag,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: [DIGITALOCEAN_MANAGED_RUNNER_TAG, operationTag],
    firewallApplied: providerFirewallId !== null,
    createdAt: NOW.toISOString(),
    deletedAt: null,
  };
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: `ghcr.io/ametel01/agentbay-runner:step8@${DIGEST}`,
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["agentbay", DIGITALOCEAN_MANAGED_RUNNER_TAG],
  };
}

async function createDisposableDatabase(): Promise<{
  databaseName: string;
  databaseUrl: string;
}> {
  const databaseName = `bruno_infrastructure_${process.pid}_${Date.now()}`.toLowerCase();
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }
  return { databaseName, databaseUrl: databaseUrlFor(databaseName) };
}

async function dropDisposableDatabase(databaseName: string): Promise<void> {
  const admin = postgres(adminDatabaseUrl(), { max: 1 });
  try {
    await admin.unsafe(`drop database if exists ${quoteIdentifier(databaseName)} with (force)`);
  } finally {
    await admin.end();
  }
}

async function runDbMigrate(databaseUrl: string): Promise<void> {
  await execFileAsync("bun", ["run", "db:migrate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    timeout: 30_000,
  });
}

function validatedBaseUrl(): URL {
  const parsed = new URL(BASE_DATABASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("Runner infrastructure tests require loopback PostgreSQL.");
  }
  return parsed;
}

function adminDatabaseUrl(): string {
  const url = validatedBaseUrl();
  url.pathname = "/postgres";
  return url.toString();
}

function databaseUrlFor(databaseName: string): string {
  const url = validatedBaseUrl();
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z0-9_]+$/.test(value)) throw new Error("Disposable database name is invalid.");
  return `"${value}"`;
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function waitForBlockedDatabaseSession(observer: ReturnType<typeof postgres>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = await observer<{ blockedCount: number }[]>`
      select count(*)::int as "blockedCount"
      from pg_stat_activity
      where datname = current_database()
        and cardinality(pg_blocking_pids(pid)) > 0
    `;
    if ((row?.blockedCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for replacement reconciliation to reach the runner lock.");
}
