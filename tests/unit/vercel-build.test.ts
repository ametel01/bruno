import { describe, expect, it, vi } from "vitest";
import {
  planVercelBuildCommands,
  runVercelBuild,
  type VercelBuildCommand,
} from "@/scripts/vercel-build";

describe("Vercel build workflow", () => {
  it("migrates the production database before building", async () => {
    const commands: VercelBuildCommand[] = [];
    const runCommand = vi.fn(async (command: VercelBuildCommand) => {
      commands.push(command);
    });

    await runVercelBuild(
      {
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      },
      runCommand,
    );

    expect(commands).toEqual([
      { command: "bun", args: ["run", "db:migrate"] },
      { command: "bun", args: ["run", "build"] },
    ]);
  });

  it("fails closed when a production build has no database URL", () => {
    expect(() => planVercelBuildCommands({ VERCEL_ENV: "production" })).toThrow(
      "DATABASE_URL is required for production Vercel migrations.",
    );
  });

  it("does not migrate preview builds without a preview database", () => {
    expect(planVercelBuildCommands({ VERCEL_ENV: "preview" })).toEqual([
      { command: "bun", args: ["run", "build"] },
    ]);
  });
});
