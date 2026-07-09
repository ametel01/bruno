import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clipUsageIntervalToWindow,
  getCostEstimatesForDevelopmentUser,
  unionUsageIntervalDurationMs,
} from "@/src/server/costs/cost-estimates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentUsagePeriods, agents, appMetadata, runners, users } from "@/src/server/db/schema";
import { DEVELOPMENT_USER_METADATA_KEY } from "@/src/server/users/development-user";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const NOW = new Date("2026-07-10T12:00:00.000Z");

describe("cost estimate interval math", () => {
  it("clips open, partial, and future-ended intervals to a trailing window", () => {
    const window = {
      startsAt: new Date("2026-07-09T12:00:00.000Z"),
      endsAt: NOW,
    };

    expect(
      clipUsageIntervalToWindow(
        {
          startedAt: new Date("2026-07-09T06:00:00.000Z"),
          stoppedAt: new Date("2026-07-09T18:00:00.000Z"),
        },
        window,
      ),
    ).toEqual({
      startsAt: new Date("2026-07-09T12:00:00.000Z"),
      endsAt: new Date("2026-07-09T18:00:00.000Z"),
    });
    expect(
      clipUsageIntervalToWindow(
        {
          startedAt: new Date("2026-07-10T06:00:00.000Z"),
          stoppedAt: null,
        },
        window,
      ),
    ).toEqual({
      startsAt: new Date("2026-07-10T06:00:00.000Z"),
      endsAt: NOW,
    });
    expect(
      clipUsageIntervalToWindow(
        {
          startedAt: new Date("2026-07-10T10:00:00.000Z"),
          stoppedAt: new Date("2026-07-11T10:00:00.000Z"),
        },
        window,
      ),
    ).toEqual({
      startsAt: new Date("2026-07-10T10:00:00.000Z"),
      endsAt: NOW,
    });
  });

  it("unions overlaps and ignores inverted or out-of-window periods", () => {
    const window = {
      startsAt: new Date("2026-07-09T12:00:00.000Z"),
      endsAt: NOW,
    };

    expect(
      unionUsageIntervalDurationMs(
        [
          {
            startedAt: new Date("2026-07-10T06:00:00.000Z"),
            stoppedAt: new Date("2026-07-10T10:00:00.000Z"),
          },
          {
            startedAt: new Date("2026-07-10T08:00:00.000Z"),
            stoppedAt: null,
          },
          {
            startedAt: new Date("2026-07-10T11:00:00.000Z"),
            stoppedAt: new Date("2026-07-10T09:00:00.000Z"),
          },
          {
            startedAt: new Date("2026-07-08T00:00:00.000Z"),
            stoppedAt: new Date("2026-07-08T01:00:00.000Z"),
          },
        ],
        window,
      ),
    ).toBe(6 * HOUR_MS);
  });
});

describe.sequential("development-user cost estimates", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("returns deterministic daily and monthly estimates from unioned runner uptime", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runnerId = await seedDigitalOceanRunner(connection, userId, {
      name: "Shared Runner",
      sizeSlug: "s-1vcpu-1gb",
    });
    const openAgentId = await seedAgent(connection, userId, runnerId, {
      name: "Open Agent",
      status: "running",
    });
    const stoppedAgentId = await seedAgent(connection, userId, runnerId, {
      name: "Stopped Agent",
      status: "stopped",
    });

    await seedUsagePeriod(connection, openAgentId, runnerId, {
      startedAt: new Date(NOW.getTime() - 36 * HOUR_MS),
      stoppedAt: null,
    });
    await seedUsagePeriod(connection, stoppedAgentId, runnerId, {
      startedAt: new Date(NOW.getTime() - 12 * HOUR_MS),
      stoppedAt: new Date(NOW.getTime() - 6 * HOUR_MS),
    });

    const result = await getCostEstimatesForDevelopmentUser({
      createConnection: () => connection,
      now: () => NOW,
    });

    expect(result.generatedAt).toBe("2026-07-10T12:00:00.000Z");
    expect(result.daily).toMatchObject({
      key: "daily",
      startsAt: "2026-07-09T12:00:00.000Z",
      endsAt: "2026-07-10T12:00:00.000Z",
      durationMs: DAY_MS,
      runnerCount: 1,
      runningAgentCount: 1,
      windowActiveAgentCount: 2,
      runnerMonthlyCost: availableCents(600),
      estimatedInfrastructureCost: availableCents(20),
      estimatedInfrastructureCostPerAgent: availableCents(10),
    });
    expect(result.daily.runners[0]).toMatchObject({
      runnerId,
      runnerName: "Shared Runner",
      uptimeMs: DAY_MS,
      runningAgentCount: 1,
      windowActiveAgentCount: 2,
      runnerMonthlyCost: availableCents(600),
      estimatedInfrastructureCost: availableCents(20),
      estimatedInfrastructureCostPerAgent: availableCents(10),
    });
    expect(result.monthly).toMatchObject({
      startsAt: "2026-06-10T12:00:00.000Z",
      endsAt: "2026-07-10T12:00:00.000Z",
      durationMs: MONTH_MS,
      runningAgentCount: 1,
      windowActiveAgentCount: 2,
      estimatedInfrastructureCost: availableCents(30),
      estimatedInfrastructureCostPerAgent: availableCents(15),
    });
    expect(result.monthly.runners[0]).toMatchObject({
      uptimeMs: 36 * HOUR_MS,
      estimatedInfrastructureCost: availableCents(30),
    });
  });

  it("includes stopped historical usage for deleted runners and rounds only DTO values", async () => {
    const userId = await seedDevelopmentUser(connection);
    const runnerId = await seedDigitalOceanRunner(connection, userId, {
      name: "Historical Runner",
      sizeSlug: "s-1vcpu-512mb-10gb",
    });
    const firstAgentId = await seedAgent(connection, userId, runnerId, {
      name: "Historical Agent One",
      status: "stopped",
    });
    const secondAgentId = await seedAgent(connection, userId, runnerId, {
      name: "Historical Agent Two",
      status: "stopped",
    });
    const startedAt = new Date(NOW.getTime() - 2 * HOUR_MS);
    const stoppedAt = new Date(NOW.getTime() - HOUR_MS);

    await seedUsagePeriod(connection, firstAgentId, runnerId, { startedAt, stoppedAt });
    await seedUsagePeriod(connection, secondAgentId, runnerId, { startedAt, stoppedAt });
    await connection.db
      .update(runners)
      .set({ deletedAt: new Date(NOW.getTime() - 30 * 60 * 1_000) })
      .where(eq(runners.id, runnerId));

    const result = await getCostEstimatesForDevelopmentUser({
      createConnection: () => connection,
      now: () => NOW,
    });

    expect(result.daily.runners).toHaveLength(1);
    expect(result.daily.runners[0]).toMatchObject({
      runnerId,
      uptimeMs: HOUR_MS,
      runningAgentCount: 0,
      windowActiveAgentCount: 2,
      estimatedInfrastructureCost: availableCents(1),
      estimatedInfrastructureCostPerAgent: availableCents(0),
    });
  });

  it("returns explicit unavailable estimates for manual and unsupported runners", async () => {
    const userId = await seedDevelopmentUser(connection);
    const knownRunnerId = await seedDigitalOceanRunner(connection, userId, {
      name: "Known Idle Runner",
      sizeSlug: "s-1vcpu-1gb",
    });
    const unknownRunnerId = await seedDigitalOceanRunner(connection, userId, {
      name: "Unknown Runner",
      sizeSlug: "s-4vcpu-8gb",
    });
    const manualRunnerId = await seedManualRunner(connection, userId);

    const result = await getCostEstimatesForDevelopmentUser({
      createConnection: () => connection,
      now: () => NOW,
    });
    const knownRunner = result.daily.runners.find((runner) => runner.runnerId === knownRunnerId);
    const unknownRunner = result.daily.runners.find(
      (runner) => runner.runnerId === unknownRunnerId,
    );
    const manualRunner = result.daily.runners.find((runner) => runner.runnerId === manualRunnerId);

    expect(knownRunner).toMatchObject({
      uptimeMs: 0,
      windowActiveAgentCount: 0,
      estimatedInfrastructureCost: availableCents(0),
      estimatedInfrastructureCostPerAgent: {
        available: false,
        reason: "no_active_agents",
        label: "Estimate unavailable",
      },
    });
    expect(unknownRunner).toMatchObject({
      runnerMonthlyCost: {
        available: false,
        reason: "unsupported_size",
        label: "Estimate unavailable",
      },
    });
    expect(manualRunner).toMatchObject({
      runnerMonthlyCost: {
        available: false,
        reason: "manual_runner",
        label: "Estimate unavailable",
      },
    });
    expect(result.daily).toMatchObject({
      runningAgentCount: 0,
      windowActiveAgentCount: 0,
      runnerMonthlyCost: {
        available: false,
        reason: "incomplete_runner_prices",
      },
      estimatedInfrastructureCost: {
        available: false,
        reason: "incomplete_runner_prices",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /endpoint|providerResource|credential|password|token|dop_v1/i,
    );
  });

  it("scopes runners, current counts, and usage periods to the development user", async () => {
    const userId = await seedDevelopmentUser(connection);
    const [foreignUser] = await connection.db.insert(users).values({}).returning({ id: users.id });

    if (!foreignUser) {
      throw new Error("Foreign user insert returned no rows.");
    }

    const userRunnerId = await seedDigitalOceanRunner(connection, userId, {
      name: "User Runner",
      sizeSlug: "s-1vcpu-1gb",
    });
    const foreignRunnerId = await seedDigitalOceanRunner(connection, foreignUser.id, {
      name: "Foreign Runner",
      sizeSlug: "s-2vcpu-2gb",
    });
    const userAgentId = await seedAgent(connection, userId, userRunnerId, {
      name: "User Agent",
      status: "running",
    });
    const foreignAgentOnUserRunnerId = await seedAgent(connection, foreignUser.id, userRunnerId, {
      name: "Foreign Agent On User Runner",
      status: "running",
    });
    const userAgentOnForeignRunnerId = await seedAgent(connection, userId, foreignRunnerId, {
      name: "User Agent On Foreign Runner",
      status: "running",
    });

    await seedUsagePeriod(connection, userAgentId, userRunnerId, {
      startedAt: new Date(NOW.getTime() - HOUR_MS),
      stoppedAt: null,
    });
    await seedUsagePeriod(connection, foreignAgentOnUserRunnerId, userRunnerId, {
      startedAt: new Date(NOW.getTime() - DAY_MS),
      stoppedAt: null,
    });
    await seedUsagePeriod(connection, userAgentOnForeignRunnerId, foreignRunnerId, {
      startedAt: new Date(NOW.getTime() - DAY_MS),
      stoppedAt: null,
    });

    const result = await getCostEstimatesForDevelopmentUser({
      createConnection: () => connection,
      now: () => NOW,
    });

    expect(result.daily.runners).toHaveLength(1);
    expect(result.daily.runners[0]).toMatchObject({
      runnerId: userRunnerId,
      uptimeMs: HOUR_MS,
      runningAgentCount: 1,
      windowActiveAgentCount: 1,
    });
    expect(result.daily.runningAgentCount).toBe(1);
    expect(result.daily.windowActiveAgentCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain(foreignRunnerId);
    expect(JSON.stringify(result)).not.toContain(foreignAgentOnUserRunnerId);
  });
});

function availableCents(cents: number): { available: true; cents: number; currency: "USD" } {
  return {
    available: true,
    cents,
    currency: "USD",
  };
}

async function seedDevelopmentUser(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("Development user insert returned no rows.");
  }

  await connection.db.insert(appMetadata).values({
    key: DEVELOPMENT_USER_METADATA_KEY,
    value: user.id,
  });

  return user.id;
}

async function seedDigitalOceanRunner(
  connection: DatabaseConnection,
  userId: string,
  input: { name: string; sizeSlug: string },
): Promise<string> {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId,
      name: input.name,
      kind: "digitalocean",
      provider: "digitalocean",
      providerResourceId: `resource-${input.name.toLowerCase().replaceAll(" ", "-")}`,
      region: "sgp1",
      sizeSlug: input.sizeSlug,
      image: "ubuntu-24-04-x64",
      provisioningStatus: "ready",
      status: "online",
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("DigitalOcean runner insert returned no rows.");
  }

  return runner.id;
}

async function seedManualRunner(connection: DatabaseConnection, userId: string): Promise<string> {
  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId,
      name: "Manual Runner",
      kind: "manual_vps",
      endpointUrl: "https://manual-runner.example.com",
      status: "online",
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Manual runner insert returned no rows.");
  }

  return runner.id;
}

async function seedAgent(
  connection: DatabaseConnection,
  userId: string,
  runnerId: string,
  input: { name: string; status: "running" | "stopped" },
): Promise<string> {
  const [agent] = await connection.db
    .insert(agents)
    .values({
      userId,
      runnerId,
      name: input.name,
      templateKey: "research_agent",
      status: input.status,
    })
    .returning({ id: agents.id });

  if (!agent) {
    throw new Error("Agent insert returned no rows.");
  }

  return agent.id;
}

async function seedUsagePeriod(
  connection: DatabaseConnection,
  agentId: string,
  runnerId: string,
  input: { startedAt: Date; stoppedAt: Date | null },
): Promise<void> {
  await connection.db.insert(agentUsagePeriods).values({
    agentId,
    runnerId,
    startedAt: input.startedAt,
    stoppedAt: input.stoppedAt,
    createdAt: input.startedAt,
    updatedAt: input.stoppedAt ?? input.startedAt,
  });
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_usage_periods, agents, runners, app_metadata, users restart identity cascade`;
}
