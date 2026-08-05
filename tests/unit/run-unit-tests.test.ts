import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  planUnitTestDatabase,
  runUnitTests,
  type UnitTestCommand,
  type UnitTestDatabasePlan,
} from "@/scripts/run-unit-tests";

const BASE_DATABASE_URL = "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling";

describe("isolated unit-test database runner", () => {
  it("derives a disposable loopback database without changing connection credentials", () => {
    expect(
      planUnitTestDatabase(BASE_DATABASE_URL, {
        pid: 4242,
        suffix: "a1b2c3d4e5f6",
      }),
    ).toEqual({
      adminDatabaseUrl: "postgres://agentbay:agentbay@127.0.0.1:54329/postgres",
      databaseName: "plingpling_test_4242_a1b2c3d4e5f6",
      databaseUrl: "postgres://agentbay:agentbay@127.0.0.1:54329/plingpling_test_4242_a1b2c3d4e5f6",
    });
  });

  it.each([
    "postgres://agentbay:agentbay@database.example/plingpling",
    "mysql://agentbay:agentbay@127.0.0.1:54329/plingpling",
  ])("refuses unsafe base database URL %s", (databaseUrl) => {
    expect(() =>
      planUnitTestDatabase(databaseUrl, {
        pid: 4242,
        suffix: "a1b2c3d4e5f6",
      }),
    ).toThrow("Unit tests require a loopback PostgreSQL DATABASE_URL.");
  });

  it("creates, migrates, tests, and drops one isolated database", async () => {
    const events: string[] = [];
    const commands: Array<{ appUrl: string; command: UnitTestCommand; databaseUrl: string }> = [];

    const result = await runUnitTests(
      {
        DATABASE_URL: BASE_DATABASE_URL,
        NEXT_PUBLIC_APP_URL: "https://development-tunnel.example",
      },
      {
        cwd: "/repo",
        pid: 4242,
        suffix: () => "a1b2c3d4e5f6",
        createDatabase: async (plan) => {
          events.push(`create:${plan.databaseName}`);
        },
        dropDatabase: async (plan) => {
          events.push(`drop:${plan.databaseName}`);
        },
        runCommand: async (command, env) => {
          commands.push({
            appUrl: env.NEXT_PUBLIC_APP_URL ?? "",
            command,
            databaseUrl: env.DATABASE_URL ?? "",
          });
          return 0;
        },
        writeInfo: (message) => events.push(`info:${message}`),
      },
      ["tests/unit/example.test.ts"],
    );

    const isolatedUrl = `${BASE_DATABASE_URL}_test_4242_a1b2c3d4e5f6`;
    expect(result).toBe(0);
    expect(commands).toEqual([
      {
        appUrl: "http://localhost:3000",
        command: { command: "bun", args: ["run", "db:migrate"] },
        databaseUrl: isolatedUrl,
      },
      {
        appUrl: "http://localhost:3000",
        command: {
          command: "/repo/node_modules/.bin/vitest",
          args: ["run", "--no-file-parallelism", "tests/unit/example.test.ts"],
        },
        databaseUrl: isolatedUrl,
      },
    ]);
    expect(events).toEqual([
      "create:plingpling_test_4242_a1b2c3d4e5f6",
      "info:Created isolated unit-test database plingpling_test_4242_a1b2c3d4e5f6.",
      "drop:plingpling_test_4242_a1b2c3d4e5f6",
      "info:Removed isolated unit-test database plingpling_test_4242_a1b2c3d4e5f6.",
    ]);
  });

  it("always drops the isolated database and preserves a failing test exit code", async () => {
    const dropDatabase = vi.fn(async (_plan: UnitTestDatabasePlan) => undefined);
    const runCommand = vi
      .fn<(command: UnitTestCommand, env: Record<string, string | undefined>) => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(7);

    await expect(
      runUnitTests(
        { DATABASE_URL: BASE_DATABASE_URL },
        {
          cwd: "/repo",
          pid: 4242,
          suffix: () => "a1b2c3d4e5f6",
          createDatabase: async () => undefined,
          dropDatabase,
          runCommand,
          writeInfo: () => undefined,
        },
      ),
    ).resolves.toBe(7);
    expect(dropDatabase).toHaveBeenCalledOnce();
  });

  it("keeps the package command and developer documentation on the isolated runner", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const readme = await readFile("README.md", "utf8");

    expect(packageJson.scripts.test).toBe("bun scripts/run-unit-tests.ts");
    expect(readme).toContain("temporary PostgreSQL database");
  });
});
