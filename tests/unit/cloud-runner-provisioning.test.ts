import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { appMetadata, runnerProvisioningEvents, runners, users } from "@/src/server/db/schema";
import {
  listCloudRunnerProvisioningSummariesForDevelopmentUser,
  toCloudRunnerProvisioningSummary,
} from "@/src/server/runners/cloud-runner-provisioning";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";

describe("cloud runner provisioning summaries", () => {
  it("renders only safe persisted provisioning fields", () => {
    const summary = toCloudRunnerProvisioningSummary(
      {
        id: "00000000-0000-4000-8000-000000000154",
        name: "Cloud Runner",
        kind: "digitalocean",
        status: "provisioning",
        provider: "digitalocean",
        providerResourceId: "do-droplet-154",
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "firewall_configuring",
        provisioningError: null,
        provisioningStartedAt: "2026-07-06T01:00:00.000Z",
        provisioningCompletedAt: null,
      },
      null,
    );

    expect(summary).toMatchObject({
      id: "00000000-0000-4000-8000-000000000154",
      name: "Cloud Runner",
      kind: "digitalocean",
      status: "provisioning",
      readinessStatus: "provisioning",
      provider: "digitalocean",
      providerResourceId: "do-droplet-154",
      region: "nyc3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      latestHeartbeatAt: null,
      provisioning: {
        status: "firewall_configuring",
        error: null,
        startedAt: "2026-07-06T01:00:00.000Z",
        completedAt: null,
      },
    });
    expect(summary.provisioning.phases).toContainEqual({
      name: "firewall_configuring",
      status: "current",
      startedAt: "2026-07-06T01:00:00.000Z",
      completedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain("registrationToken");
    expect(JSON.stringify(summary)).not.toContain("credentialHash");
    expect(JSON.stringify(summary)).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(JSON.stringify(summary)).not.toContain("dop_v1");
  });

  it("maps successful heartbeat status to online readiness", () => {
    const summary = toCloudRunnerProvisioningSummary(
      {
        id: "00000000-0000-4000-8000-000000000155",
        name: "Online Cloud Runner",
        kind: "digitalocean",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "do-droplet-155",
        region: "sfo3",
        sizeSlug: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningError: null,
        provisioningStartedAt: "2026-07-06T01:00:00.000Z",
        provisioningCompletedAt: "2026-07-06T01:03:00.000Z",
      },
      {
        status: "online",
        observedAt: "2026-07-06T01:04:00.000Z",
      },
    );

    expect(summary.readinessStatus).toBe("online");
    expect(summary.latestHeartbeatAt).toBe("2026-07-06T01:04:00.000Z");
    expect(summary.provisioning.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "waiting_for_runner", status: "completed" }),
        expect.objectContaining({ name: "ready", status: "completed" }),
        expect.objectContaining({ name: "failed", status: "pending" }),
        expect.objectContaining({ name: "cleaning_up", status: "pending" }),
        expect.objectContaining({ name: "deleted", status: "pending" }),
      ]),
    );
  });

  it("redacts secret-looking failure details and supplies an actionable fallback", () => {
    const summary = toCloudRunnerProvisioningSummary({
      id: "00000000-0000-4000-8000-000000000156",
      name: "TOKEN=stored-for-downstream",
      kind: "digitalocean",
      status: "provision_failed",
      provider: "digitalocean",
      providerResourceId: null,
      region: "nyc3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "failed",
      provisioningError: "token=stored-for-downstream",
      provisioningStartedAt: "2026-07-06T01:00:00.000Z",
      provisioningCompletedAt: "2026-07-06T01:02:00.000Z",
    });

    expect(summary.name).toBe("Sensitive details omitted.");
    expect(summary.readinessStatus).toBe("failed");
    expect(summary.provisioning.error).toBe("Sensitive details omitted.");
    expect(summary.provisioning.phases).toContainEqual({
      name: "failed",
      status: "failed",
      startedAt: "2026-07-06T01:00:00.000Z",
      completedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain("stored-for-downstream");
    expect(JSON.stringify(summary)).not.toContain("token=");
  });
});

describe.sequential("cloud runner provisioning stale bootstrap reconciliation", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("marks stale waiting_for_runner rows failed when summaries are read", async () => {
    const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

    if (!user) {
      throw new Error("User insert returned no rows.");
    }

    await connection.db.insert(appMetadata).values({
      key: DEVELOPMENT_USER_METADATA_KEY,
      value: user.id,
    });
    const [runner] = await connection.db
      .insert(runners)
      .values({
        userId: user.id,
        name: "Stale Cloud Runner",
        kind: "digitalocean",
        endpointUrl: "https://203-0-113-10.sslip.io",
        status: "registering",
        provider: "digitalocean",
        providerResourceId: "do-droplet-154",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "waiting_for_runner",
        provisioningStartedAt: new Date("2026-07-06T01:00:00.000Z"),
        createdAt: new Date("2026-07-06T01:00:00.000Z"),
        updatedAt: new Date("2026-07-06T01:05:00.000Z"),
      })
      .returning({ id: runners.id });

    const summaries = await listCloudRunnerProvisioningSummariesForDevelopmentUser({
      createConnection: () => connection,
      now: () => new Date("2026-07-06T02:30:00.000Z"),
    } as Parameters<typeof listCloudRunnerProvisioningSummariesForDevelopmentUser>[0] & {
      now: () => Date;
    });
    const [persistedRunner] = await connection.db
      .select({
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        provisioningError: runners.provisioningError,
      })
      .from(runners)
      .where(eq(runners.id, runner?.id ?? ""))
      .limit(1);
    const events = await connection.db.select().from(runnerProvisioningEvents);

    expect(summaries[0]).toMatchObject({
      readinessStatus: "failed",
      provisioning: {
        status: "failed",
        error:
          "Cloud runner bootstrap did not register before the timeout. Check Droplet cloud-init logs, confirm ports 80/443 are reachable, then delete the Droplet do-droplet-154 if it is not needed and create a new runner.",
      },
    });
    expect(persistedRunner).toEqual({
      status: "provision_failed",
      provisioningStatus: "failed",
      provisioningError:
        "Cloud runner bootstrap did not register before the timeout. Check Droplet cloud-init logs, confirm ports 80/443 are reachable, then delete the Droplet do-droplet-154 if it is not needed and create a new runner.",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        runnerId: runner?.id,
        phase: "failed",
        status: "failed",
        message:
          "Cloud runner bootstrap did not register before the timeout. Check Droplet cloud-init logs, confirm ports 80/443 are reachable, then delete the Droplet do-droplet-154 if it is not needed and create a new runner.",
      }),
    );
  });
});

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
