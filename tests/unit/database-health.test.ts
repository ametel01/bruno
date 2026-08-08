import { describe, expect, it } from "vitest";
import { checkDatabaseHealth } from "@/src/server/db/health";

describe("database health", () => {
  it("returns an unreachable result when required env vars are malformed", async () => {
    const health = await checkDatabaseHealth({
      DATABASE_URL: "not-a-url",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    expect(health).toEqual({
      ok: false,
      database: "unreachable",
      message: "DATABASE_URL must be a valid URL.",
    });
  });

  it("returns an unreachable result when the database cannot be reached", async () => {
    const health = await checkDatabaseHealth({
      DATABASE_URL: "postgres://bruno:bruno@127.0.0.1:1/bruno",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    expect(health).toEqual({
      ok: false,
      database: "unreachable",
      message: "Database connection failed.",
    });
  });
});
