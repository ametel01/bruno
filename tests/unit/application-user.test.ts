import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { users } from "@/src/server/db/schema";
import { requireApplicationUser } from "@/src/server/users/application-user";

describe("application user resolution", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetUsers(connection);
  });

  afterEach(async () => {
    await resetUsers(connection);
    await connection.close();
  });

  it.each([
    "development",
    "operator",
  ] as const)("reuses the shared user in %s mode without consulting Clerk", async (mode) => {
    const getClerkUserId = vi.fn(async () => "user_should_not_be_read");
    const first = await requireApplicationUser(mode, {
      createConnection: () => connection,
      getClerkUserId,
    });
    const second = await requireApplicationUser(mode, {
      createConnection: () => connection,
      getClerkUserId,
    });

    expect(first).toEqual(second);
    expect(first.ok).toBe(true);
    expect(getClerkUserId).not.toHaveBeenCalled();
    await expect(connection.db.select().from(users)).resolves.toHaveLength(1);
  });

  it("returns a typed 401 result before opening the database without a Clerk session", async () => {
    const createConnection = vi.fn(() => {
      throw new Error("database should not open");
    });

    await expect(
      requireApplicationUser("clerk", {
        createConnection,
        getClerkUserId: async () => null,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("resolves an existing Clerk identity without creating another user", async () => {
    const [existing] = await connection.db
      .insert(users)
      .values({ clerkUserId: "user_existing" })
      .returning({ id: users.id });

    const result = await requireApplicationUser("clerk", {
      createConnection: () => connection,
      getClerkUserId: async () => "user_existing",
    });

    expect(result).toEqual({ ok: true, userId: existing?.id });
    await expect(connection.db.select().from(users)).resolves.toHaveLength(1);
  });

  it("creates distinct internal UUIDs for distinct Clerk identities", async () => {
    const first = await requireApplicationUser("clerk", {
      createConnection: () => connection,
      getClerkUserId: async () => "user_first",
    });
    const second = await requireApplicationUser("clerk", {
      createConnection: () => connection,
      getClerkUserId: async () => "user_second",
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      throw new Error("Expected authenticated application users.");
    }
    expect(first.userId).not.toBe(second.userId);
    expect(await connection.db.select().from(users)).toHaveLength(2);
  });

  it("never auto-claims an unlinked legacy user on first Clerk sign-in", async () => {
    const legacyUserId = "00000000-0000-4000-8000-000000000239";
    await connection.db.insert(users).values({ id: legacyUserId });

    const result = await requireApplicationUser("clerk", {
      createConnection: () => connection,
      getClerkUserId: async () => "user_new_owner",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("Expected the first Clerk request to resolve an application user.");
    }
    expect(result.userId).not.toBe(legacyUserId);

    const persistedUsers = await connection.db.select().from(users);
    expect(persistedUsers).toHaveLength(2);
    expect(persistedUsers).toContainEqual(
      expect.objectContaining({ id: legacyUserId, clerkUserId: null }),
    );
    expect(persistedUsers).toContainEqual(
      expect.objectContaining({ id: result.userId, clerkUserId: "user_new_owner" }),
    );
  });

  it("coalesces concurrent first requests across separate database connections", async () => {
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();

    try {
      const [first, second] = await Promise.all([
        requireApplicationUser("clerk", {
          createConnection: () => firstConnection,
          getClerkUserId: async () => "user_concurrent",
        }),
        requireApplicationUser("clerk", {
          createConnection: () => secondConnection,
          getClerkUserId: async () => "user_concurrent",
        }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Expected authenticated application users.");
      }
      expect(first.userId).toBe(second.userId);
      await expect(
        connection.db.select().from(users).where(eq(users.clerkUserId, "user_concurrent")),
      ).resolves.toHaveLength(1);
    } finally {
      await Promise.all([firstConnection.close(), secondConnection.close()]);
    }
  });

  it("coalesces concurrent first development requests across separate connections", async () => {
    const firstConnection = createDatabaseConnection();
    const secondConnection = createDatabaseConnection();

    try {
      const [first, second] = await Promise.all([
        requireApplicationUser("development", { createConnection: () => firstConnection }),
        requireApplicationUser("development", { createConnection: () => secondConnection }),
      ]);

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Expected development application users.");
      }
      expect(first.userId).toBe(second.userId);
      await expect(connection.db.select().from(users)).resolves.toHaveLength(1);
    } finally {
      await Promise.all([firstConnection.close(), secondConnection.close()]);
    }
  });

  it("persists no Clerk profile or session PII", async () => {
    await requireApplicationUser("clerk", {
      createConnection: () => connection,
      getClerkUserId: async () => "user_opaque_only",
    });

    const [persisted] = await connection.db.select().from(users);
    expect(Object.keys(persisted ?? {})).toEqual(["id", "clerkUserId", "createdAt", "updatedAt"]);
    expect(persisted?.clerkUserId).toBe("user_opaque_only");
  });
});

async function resetUsers(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
