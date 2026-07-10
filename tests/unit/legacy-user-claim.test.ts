import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseLegacyUserClaimArgs, runLegacyUserClaimCli } from "@/scripts/claim-legacy-user";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, runners, users } from "@/src/server/db/schema";
import { requireApplicationUser } from "@/src/server/users/application-user";
import { claimLegacyUser } from "@/src/server/users/legacy-user-claim";

describe("legacy user claim", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetUsers(connection);
  });

  afterEach(async () => {
    await resetUsers(connection);
    await connection.close();
  });

  it("defaults to a count-only dry run and leaves the legacy UUID untouched", async () => {
    const legacyUserId = await seedLegacyOwnership(connection);

    const result = await claimLegacyUser(
      { clerkUserId: "user_legacy" },
      { createConnection: () => connection },
    );
    const [persisted] = await connection.db.select().from(users).where(eq(users.id, legacyUserId));

    expect(result).toMatchObject({
      ok: true,
      status: "preview",
      dryRun: true,
      counts: {
        users: 1,
        runners: 1,
        agents: 1,
      },
    });
    expect(persisted).toMatchObject({ id: legacyUserId, clerkUserId: null });
    expect(JSON.stringify(result)).not.toContain(legacyUserId);
    expect(JSON.stringify(result)).not.toContain("user_legacy");
  });

  it("claims exactly one legacy user and is idempotent", async () => {
    const legacyUserId = await seedLegacyOwnership(connection);

    const claimed = await claimLegacyUser(
      { clerkUserId: "user_owner", apply: true },
      { createConnection: () => connection },
    );
    const repeated = await claimLegacyUser(
      { clerkUserId: "user_owner", apply: true },
      { createConnection: () => connection },
    );
    const [persisted] = await connection.db.select().from(users).where(eq(users.id, legacyUserId));

    expect(claimed).toMatchObject({ ok: true, status: "claimed", dryRun: false });
    expect(repeated).toEqual({ ...claimed, status: "already_claimed" });
    expect(persisted).toMatchObject({ id: legacyUserId, clerkUserId: "user_owner" });
    await expect(connection.db.select().from(users)).resolves.toHaveLength(1);
  });

  it("refuses ambiguous legacy ownership without changing either UUID", async () => {
    await connection.db.insert(users).values([{}, {}]);

    const result = await claimLegacyUser(
      { clerkUserId: "user_ambiguous", apply: true },
      { createConnection: () => connection },
    );

    expect(result).toEqual({
      ok: false,
      status: "ambiguous",
      dryRun: false,
      candidateCount: 2,
    });
    expect(
      (await connection.db.select().from(users)).every((user) => user.clerkUserId === null),
    ).toBe(true);
  });

  it("refuses a Clerk identity already mapped away from legacy ownership", async () => {
    await connection.db.insert(users).values([
      {},
      {
        clerkUserId: "user_conflict",
      },
    ]);

    const result = await claimLegacyUser(
      { clerkUserId: "user_conflict", apply: true },
      { createConnection: () => connection },
    );

    expect(result).toEqual({
      ok: false,
      status: "conflict",
      dryRun: false,
      candidateCount: 1,
    });
  });

  it("serializes a claim with a same-identity resolver race without moving ownership", async () => {
    const legacyUserId = await seedLegacyOwnership(connection);
    const claimConnection = createDatabaseConnection();
    const resolverConnection = createDatabaseConnection();

    try {
      const [claimResult, resolverResult] = await Promise.all([
        claimLegacyUser(
          { clerkUserId: "user_race", apply: true },
          { createConnection: () => claimConnection },
        ),
        requireApplicationUser("clerk", {
          createConnection: () => resolverConnection,
          getClerkUserId: async () => "user_race",
        }),
      ]);
      const mappedUsers = await connection.db
        .select()
        .from(users)
        .where(eq(users.clerkUserId, "user_race"));
      const [ownedAgent] = await connection.db.select().from(agents);

      expect(mappedUsers).toHaveLength(1);
      expect(ownedAgent?.userId).toBe(legacyUserId);
      expect(resolverResult.ok).toBe(true);
      if (!resolverResult.ok) {
        throw new Error("Expected authenticated application user.");
      }

      if (claimResult.ok) {
        expect(claimResult.status).toBe("claimed");
        expect(resolverResult.userId).toBe(legacyUserId);
      } else {
        expect(claimResult.status).toBe("conflict");
        expect(mappedUsers[0]?.id).toBe(resolverResult.userId);
      }
    } finally {
      await Promise.all([claimConnection.close(), resolverConnection.close()]);
    }
  });
});

describe("legacy user claim CLI", () => {
  it("requires an explicit Clerk user ID", () => {
    expect(() => parseLegacyUserClaimArgs([])).toThrow("--clerk-user-id is required.");
    expect(() => parseLegacyUserClaimArgs(["--clerk-user-id"])).toThrow(
      "--clerk-user-id requires a value.",
    );
  });

  it.each([
    ["missing before apply", ["--clerk-user-id", "--apply"]],
    ["missing before repeated apply", ["--clerk-user-id", "--apply", "--apply"]],
    ["unknown long option", ["--clerk-user-id", "--unknown"]],
    ["short option", ["--clerk-user-id", "-x"]],
  ])("rejects an option-like Clerk user ID: %s", (_label, args) => {
    expect(() => parseLegacyUserClaimArgs(args)).toThrow(
      "--clerk-user-id requires a non-option value.",
    );
  });

  it.each([
    ["dry run by default", ["--clerk-user-id", "user_cli_dry"], "user_cli_dry", false],
    ["explicit dry run", ["--clerk-user-id", "user_cli_dry", "--dry-run"], "user_cli_dry", false],
    ["apply", ["--clerk-user-id", "user_cli_apply", "--apply"], "user_cli_apply", true],
  ] as const)("parses a valid explicit ID in %s mode", (_label, args, clerkUserId, apply) => {
    expect(parseLegacyUserClaimArgs([...args])).toEqual({ clerkUserId, apply });
  });

  it.each([
    ["missing before apply", ["--clerk-user-id", "--apply"]],
    ["missing before repeated apply", ["--clerk-user-id", "--apply", "--apply"]],
    ["unknown long option", ["--clerk-user-id", "--unknown"]],
    ["short option", ["--clerk-user-id", "-x"]],
  ])("rejects %s before invoking the claim dependency", async (_label, args) => {
    const claim = createClaimMock();

    await expect(runLegacyUserClaimCli(args, { claim })).rejects.toThrow(
      "--clerk-user-id requires a non-option value.",
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it("rejects a missing Clerk user ID value before invoking the claim dependency", async () => {
    const claim = createClaimMock();

    await expect(runLegacyUserClaimCli(["--clerk-user-id"], { claim })).rejects.toThrow(
      "--clerk-user-id requires a value.",
    );
    expect(claim).not.toHaveBeenCalled();
  });

  it.each([
    ["dry run", ["--clerk-user-id", "user_private_dry"], "user_private_dry", false],
    ["apply", ["--clerk-user-id", "user_private_apply", "--apply"], "user_private_apply", true],
  ] as const)("invokes the claim for a valid explicit ID in %s mode without echoing it", async (_label, args, clerkUserId, apply) => {
    const write = vi.fn();
    const claim = createClaimMock();

    await runLegacyUserClaimCli([...args], { claim, write });

    expect(claim).toHaveBeenCalledWith({ clerkUserId, apply });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]?.[0]).not.toContain(clerkUserId);
  });
});

function createClaimMock() {
  return vi.fn(async () => ({
    ok: false as const,
    status: "no_legacy_user" as const,
    dryRun: true,
    candidateCount: 0,
  }));
}

async function seedLegacyOwnership(connection: DatabaseConnection): Promise<string> {
  const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });

  if (!user) {
    throw new Error("Legacy user insert returned no rows.");
  }

  const [runner] = await connection.db
    .insert(runners)
    .values({
      userId: user.id,
      name: "Legacy Runner",
      endpointUrl: "https://legacy-runner.example.com",
    })
    .returning({ id: runners.id });

  if (!runner) {
    throw new Error("Legacy runner insert returned no rows.");
  }

  await connection.db.insert(agents).values({
    userId: user.id,
    runnerId: runner.id,
    name: "Legacy Agent",
    templateKey: "research_agent",
  });

  return user.id;
}

async function resetUsers(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
