import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { users } from "@/src/server/db/schema";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: mocks.auth,
}));

import { requireClerkApplicationUser } from "@/src/server/users/clerk-application-user";

describe("Clerk application user adapter", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetUsers(connection);
    mocks.auth.mockReset();
  });

  afterEach(async () => {
    await resetUsers(connection);
    await connection.close();
  });

  it("awaits Clerk auth and returns the resolver's typed unauthenticated result", async () => {
    mocks.auth.mockResolvedValueOnce({ userId: null });
    const createConnection = vi.fn(() => {
      throw new Error("database should not open");
    });

    await expect(requireClerkApplicationUser({ createConnection })).resolves.toEqual({
      ok: false,
      status: 401,
      code: "unauthenticated",
    });
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(createConnection).not.toHaveBeenCalled();
  });

  it("passes only the Clerk user ID through the lazy internal-user resolver", async () => {
    mocks.auth.mockResolvedValueOnce({ userId: "user_adapter" });

    const result = await requireClerkApplicationUser({ createConnection: () => connection });
    const [persistedUser] = await connection.db.select().from(users);

    expect(result).toEqual({ ok: true, userId: persistedUser?.id });
    expect(mocks.auth).toHaveBeenCalledOnce();
    expect(persistedUser).toMatchObject({ clerkUserId: "user_adapter" });
    expect(Object.keys(persistedUser ?? {})).toEqual([
      "id",
      "clerkUserId",
      "createdAt",
      "updatedAt",
    ]);
  });
});

async function resetUsers(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_usage_periods, backups, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runner_provisioning_events, runner_heartbeats, runner_credentials, runner_registration_tokens, runners, app_metadata, users restart identity cascade`;
}
