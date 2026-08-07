import { spawn } from "node:child_process";
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
    [
      "different duplicate identities",
      [
        "--clerk-user-id",
        "user_private_first",
        "--clerk-user-id",
        "user_private_second",
        "--apply",
      ],
      "--clerk-user-id may only be provided once.",
      ["user_private_first", "user_private_second"],
    ],
    [
      "duplicate identity after the execution mode",
      [
        "--clerk-user-id",
        "user_private_first",
        "--apply",
        "--clerk-user-id",
        "user_private_second",
      ],
      "--clerk-user-id may only be provided once.",
      ["user_private_first", "user_private_second"],
    ],
    [
      "same duplicate identity",
      ["--clerk-user-id", "user_private_same", "--clerk-user-id", "user_private_same"],
      "--clerk-user-id may only be provided once.",
      ["user_private_same"],
    ],
    [
      "dry run followed by apply",
      ["--clerk-user-id", "user_private_mode", "--dry-run", "--apply"],
      "Execution mode may only be specified once.",
      ["user_private_mode"],
    ],
    [
      "apply followed by dry run",
      ["--apply", "--clerk-user-id", "user_private_mode", "--dry-run"],
      "Execution mode may only be specified once.",
      ["user_private_mode"],
    ],
    [
      "repeated apply",
      ["--clerk-user-id", "user_private_mode", "--apply", "--apply"],
      "Execution mode may only be specified once.",
      ["user_private_mode"],
    ],
    [
      "repeated dry run before the identity",
      ["--dry-run", "--dry-run", "--clerk-user-id", "user_private_mode"],
      "Execution mode may only be specified once.",
      ["user_private_mode"],
    ],
    [
      "inline identity value",
      ["--clerk-user-id=user_private_inline", "--apply"],
      "Unknown argument.",
      ["user_private_inline"],
    ],
    [
      "inline mode value",
      ["--clerk-user-id", "user_private_inline_mode", "--apply=true"],
      "Unknown argument.",
      ["user_private_inline_mode", "true"],
    ],
    [
      "inline typo value",
      ["--clerk-user-idd=user_private_typo", "--apply"],
      "Unknown argument.",
      ["user_private_typo"],
    ],
  ] as const)("rejects %s before claim invocation without echoing supplied values", async (_label, args, expectedMessage, sensitiveValues) => {
    const claim = createClaimMock();

    const error = await runLegacyUserClaimCli([...args], { claim }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(expectedMessage);
    expect(claim).not.toHaveBeenCalled();
    for (const sensitiveValue of sensitiveValues) {
      expect((error as Error).message).not.toContain(sensitiveValue);
    }
  });

  it.each([
    [
      "duplicate identity",
      ["--clerk-user-id", "user_real_first", "--clerk-user-id", "user_real_second", "--apply"],
      ["user_real_first", "user_real_second"],
    ],
    [
      "contradictory modes",
      ["--apply", "--clerk-user-id", "user_real_mode", "--dry-run"],
      ["user_real_mode"],
    ],
    ["inline identity typo", ["--clerk-user-id=user_real_inline", "--apply"], ["user_real_inline"]],
  ] as const)("fails the real CLI for %s before database access without echoing supplied values", async (_label, args, sensitiveValues) => {
    const { exitCode, stderr, stdout } = await runRealClaimCli([...args]);

    expect(exitCode).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).not.toContain("ECONNREFUSED");
    expect(stderr).not.toContain("127.0.0.1:1");
    for (const sensitiveValue of sensitiveValues) {
      expect(stderr).not.toContain(sensitiveValue);
    }
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

async function runRealClaimCli(args: string[]): Promise<{
  exitCode: number | null;
  stderr: string;
  stdout: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "bun",
      ["--conditions", "react-server", "scripts/claim-legacy-user.ts", ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: "postgres://agentbay:agentbay@127.0.0.1:1/bruno",
        },
      },
    );
    let stderr = "";
    let stdout = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
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
