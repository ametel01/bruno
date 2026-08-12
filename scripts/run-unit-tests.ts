import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import postgres from "postgres";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";

const DEFAULT_DATABASE_URL = "postgres://bruno:bruno@127.0.0.1:54329/bruno";
const DEFAULT_APP_URL = "http://localhost:3000";
const DEFAULT_TEST_DOCKER_RUNNER_IMAGE = "busybox:1.36";
const DATABASE_URL_ERROR = "Unit tests require a loopback PostgreSQL DATABASE_URL.";

export type UnitTestCommand = {
  command: string;
  args: string[];
};

export type UnitTestDatabasePlan = {
  adminDatabaseUrl: string;
  databaseName: string;
  databaseUrl: string;
};

type Environment = Record<string, string | undefined>;
type RunCommand = (command: UnitTestCommand, env: Environment) => Promise<number>;
type DatabaseAction = (plan: UnitTestDatabasePlan) => Promise<void>;

type UnitTestDependencies = {
  createDatabase?: DatabaseAction;
  cwd?: string;
  dropDatabase?: DatabaseAction;
  pid?: number;
  platform?: NodeJS.Platform;
  runCommand?: RunCommand;
  suffix?: () => string;
  writeError?: (message: string) => void;
  writeInfo?: (message: string) => void;
};

export function planUnitTestDatabase(
  baseDatabaseUrl: string,
  identity: { pid: number; suffix: string },
): UnitTestDatabasePlan {
  let parsed: URL;

  try {
    parsed = new URL(baseDatabaseUrl);
  } catch {
    throw new Error(DATABASE_URL_ERROR);
  }

  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) ||
    !Number.isSafeInteger(identity.pid) ||
    identity.pid <= 0 ||
    !/^[a-f0-9]{12}$/.test(identity.suffix)
  ) {
    throw new Error(DATABASE_URL_ERROR);
  }

  const databaseName = `bruno_test_${identity.pid}_${identity.suffix}`;
  const adminUrl = new URL(parsed);
  const databaseUrl = new URL(parsed);
  adminUrl.pathname = "/postgres";
  databaseUrl.pathname = `/${databaseName}`;

  return {
    adminDatabaseUrl: adminUrl.toString(),
    databaseName,
    databaseUrl: databaseUrl.toString(),
  };
}

export async function runUnitTests(
  env: Environment = process.env,
  dependencies: UnitTestDependencies = {},
  vitestArgs: string[] = [],
): Promise<number> {
  const writeError = dependencies.writeError ?? console.error;
  const writeInfo = dependencies.writeInfo ?? console.info;
  const cwd = dependencies.cwd ?? process.cwd();
  const platform = dependencies.platform ?? process.platform;
  let plan: UnitTestDatabasePlan;

  try {
    plan = planUnitTestDatabase(env.DATABASE_URL ?? DEFAULT_DATABASE_URL, {
      pid: dependencies.pid ?? process.pid,
      suffix:
        dependencies.suffix?.() ?? randomUUID().replaceAll("-", "").slice(0, 12).toLowerCase(),
    });
  } catch {
    writeError(DATABASE_URL_ERROR);
    return 1;
  }

  const createDatabase = dependencies.createDatabase ?? createIsolatedDatabase;
  const dropDatabase = dependencies.dropDatabase ?? dropIsolatedDatabase;
  const runCommand =
    dependencies.runCommand ??
    ((command, commandEnv) => runInheritedCommand(command, commandEnv, cwd));
  const commandEnv = {
    ...env,
    // Bun loads .env.local before this harness starts. Pin test-safe defaults so a
    // live snapshot/release configuration cannot change default-path test behavior.
    BRUNO_DIGITALOCEAN_IMAGE_MODE: "stock",
    BRUNO_DOCKER_RUNNER_IMAGE: DEFAULT_TEST_DOCKER_RUNNER_IMAGE,
    BRUNO_HERMES_WORKLOAD_IMAGE: DEFAULT_HERMES_WORKLOAD_IMAGE,
    BRUNO_RUNNER_BOOT_VALIDATION_MODE: "full",
    DATABASE_URL: plan.databaseUrl,
    NEXT_PUBLIC_APP_URL: DEFAULT_APP_URL,
  };
  const vitestExecutable = join(
    cwd,
    "node_modules",
    ".bin",
    platform === "win32" ? "vitest.cmd" : "vitest",
  );
  let databaseCreated = false;
  let exitCode = 1;

  try {
    await createDatabase(plan);
    databaseCreated = true;
    writeInfo(`Created isolated unit-test database ${plan.databaseName}.`);

    exitCode = await runCommand({ command: "bun", args: ["run", "db:migrate"] }, commandEnv);
    if (exitCode === 0) {
      exitCode = await runCommand(
        {
          command: vitestExecutable,
          args: ["run", "--no-file-parallelism", ...vitestArgs],
        },
        commandEnv,
      );
    }
  } catch {
    writeError("Unit test database setup or execution failed.");
    exitCode = 1;
  } finally {
    if (databaseCreated) {
      try {
        await dropDatabase(plan);
        writeInfo(`Removed isolated unit-test database ${plan.databaseName}.`);
      } catch {
        writeError(`Failed to remove isolated unit-test database ${plan.databaseName}.`);
        exitCode = 1;
      }
    }
  }

  return exitCode;
}

async function createIsolatedDatabase(plan: UnitTestDatabasePlan): Promise<void> {
  const admin = postgres(plan.adminDatabaseUrl, { connect_timeout: 5, max: 1 });

  try {
    await admin.unsafe(`create database ${quoteIdentifier(plan.databaseName)}`);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

async function dropIsolatedDatabase(plan: UnitTestDatabasePlan): Promise<void> {
  const admin = postgres(plan.adminDatabaseUrl, { connect_timeout: 5, max: 1 });

  try {
    await admin.unsafe(
      `drop database if exists ${quoteIdentifier(plan.databaseName)} with (force)`,
    );
  } finally {
    await admin.end({ timeout: 5 });
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function runInheritedCommand(
  input: UnitTestCommand,
  env: Environment,
  cwd: string,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd,
      env: env as NodeJS.ProcessEnv,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      if (signal === "SIGINT") {
        resolve(130);
        return;
      }
      if (signal === "SIGTERM") {
        resolve(143);
        return;
      }

      reject(new Error("Unit test command exited without a status code."));
    });
  });
}

if (import.meta.main) {
  process.exitCode = await runUnitTests(process.env, {}, process.argv.slice(2));
}
