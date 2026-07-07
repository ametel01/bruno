import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  recordRunnerBootstrapEvent,
  validateRunnerBootstrapEventPayload,
} from "@/src/server/runners/runner-bootstrap-events";
import { hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";

const REGISTRATION_TOKEN = "agb_reg_1234567890123456789012345678901234567890123";

describe.sequential("runner bootstrap event telemetry", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("records safe cloud-init bootstrap events against the provisioning runner", async () => {
    const runner = await seedCloudRunnerWithRegistrationToken(connection);

    const result = await recordRunnerBootstrapEvent(
      {
        registrationToken: REGISTRATION_TOKEN,
        phase: "bootstrapping",
        status: "completed",
        message: "Docker apt repository was configured.",
        metadata: {
          step: "docker_apt_repository",
          registrationToken: REGISTRATION_TOKEN,
          detail: `token ${REGISTRATION_TOKEN}`,
        },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-07T20:30:20.000Z"),
      },
    );

    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(result).toEqual({ ok: true, runnerId: runner.id });
    expect(events).toEqual([
      expect.objectContaining({
        runnerId: runner.id,
        phase: "bootstrapping",
        status: "completed",
        message: "Docker apt repository was configured.",
        metadata: expect.objectContaining({
          provider: "digitalocean",
          source: "cloud_init",
          step: "docker_apt_repository",
          detail: "token [redacted]",
        }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(REGISTRATION_TOKEN);
  });

  it("marks the runner failed when cloud-init reports a bootstrap failure", async () => {
    const runner = await seedCloudRunnerWithRegistrationToken(connection);

    const result = await recordRunnerBootstrapEvent(
      {
        registrationToken: REGISTRATION_TOKEN,
        phase: "bootstrapping",
        status: "failed",
        message: "Cloud runner bootstrap failed during docker_container_start.",
        metadata: {
          step: "docker_container_start",
          exitCode: 125,
        },
      },
      {
        createConnection: () => connection,
        now: () => new Date("2026-07-07T20:31:20.000Z"),
      },
    );

    const [persistedRunner] = await connection.db
      .select()
      .from(runners)
      .where(eq(runners.id, runner.id))
      .limit(1);
    const events = await connection.db
      .select()
      .from(runnerProvisioningEvents)
      .where(eq(runnerProvisioningEvents.runnerId, runner.id));

    expect(result).toEqual({ ok: true, runnerId: runner.id });
    expect(persistedRunner).toMatchObject({
      status: "provision_failed",
      provisioningStatus: "failed",
      provisioningError: "Cloud runner bootstrap failed during docker_container_start.",
    });
    expect(events).toEqual([
      expect.objectContaining({
        phase: "bootstrapping",
        status: "failed",
        metadata: expect.objectContaining({
          step: "docker_container_start",
          exitCode: 125,
        }),
      }),
    ]);
  });

  it("rejects malformed payloads before persistence", () => {
    const result = validateRunnerBootstrapEventPayload({
      registrationToken: "agb_run_wrong",
      phase: "creating",
      status: "done",
      message: "",
      metadata: "not-object",
    });

    expect(result).toEqual({
      ok: false,
      issues: [
        { field: "registrationToken", message: "Registration token is malformed." },
        { field: "phase", message: "Bootstrap event phase is invalid." },
        { field: "status", message: "Bootstrap event status is invalid." },
        { field: "message", message: "Bootstrap event message is required." },
        { field: "metadata", message: "Metadata must be an object when provided." },
      ],
    });
  });
});

async function seedCloudRunnerWithRegistrationToken(
  connection: DatabaseConnection,
): Promise<{ id: string }> {
  const now = new Date("2026-07-07T20:30:00.000Z");
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
      status: "registering",
      provider: "digitalocean",
      providerResourceId: "582965909",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "waiting_for_runner",
      provisioningStartedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Cloud runner insert returned no rows.");
  }

  await connection.db.insert(runnerRegistrationTokens).values({
    userId: user.id,
    runnerId: runner.id,
    tokenHash: hashRunnerSecret(REGISTRATION_TOKEN),
    tokenPrefix: REGISTRATION_TOKEN.slice(0, 16),
    status: "pending",
    expiresAt: new Date("2026-07-07T21:30:00.000Z"),
    createdAt: now,
    updatedAt: now,
  });

  return runner;
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table runner_provisioning_events, runner_credentials, runner_heartbeats, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
