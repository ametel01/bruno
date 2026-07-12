import { spawn } from "node:child_process";
import { join } from "node:path";

export const CLERK_HOSTED_REQUIRED_ENV = [
  "CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "E2E_CLERK_TEST_USER_A_EMAIL",
  "E2E_CLERK_TEST_USER_B_EMAIL",
] as const;

export const CLERK_HOSTED_AUTH_ENV = ["CLERK_SECRET_KEY"] as const;

export const CLERK_HOSTED_CAPABILITY_MESSAGE =
  "Hosted Clerk E2E capability unavailable. Configure the required development capability variables for test:e2e:clerk; see docs/E2E_VALIDATION.md.";

export type ClerkHostedCommand = {
  command: string;
  args: string[];
};

type ClerkHostedPlan = { ok: true; command: ClerkHostedCommand } | { ok: false; message: string };

type RunCommand = (command: ClerkHostedCommand) => Promise<number>;
type WriteError = (message: string) => void;

export function planClerkHostedCommand(
  env: Record<string, string | undefined>,
  options: { cwd?: string; platform?: NodeJS.Platform } = {},
): ClerkHostedPlan {
  const missing: string[] = CLERK_HOSTED_REQUIRED_ENV.filter((name) => !hasValue(env[name]));
  if (!CLERK_HOSTED_AUTH_ENV.some((name) => hasValue(env[name]))) {
    missing.push("CLERK_SECRET_KEY");
  }

  if (missing.length > 0) {
    return {
      ok: false,
      message: `${CLERK_HOSTED_CAPABILITY_MESSAGE} Missing capability names: ${missing.join(", ")}.`,
    };
  }

  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "playwright.cmd" : "playwright";

  return {
    ok: true,
    command: {
      command: join(cwd, "node_modules", ".bin", executable),
      args: ["test", "--config=playwright.clerk.config.ts"],
    },
  };
}

export async function runClerkHostedE2E(
  env: Record<string, string | undefined> = process.env,
  options: {
    cwd?: string;
    platform?: NodeJS.Platform;
    runCommand?: RunCommand;
    writeError?: WriteError;
  } = {},
): Promise<number> {
  const plan = planClerkHostedCommand(env, options);

  if (!plan.ok) {
    (options.writeError ?? console.error)(plan.message);
    return 1;
  }

  return (options.runCommand ?? runInheritedCommand)(plan.command);
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function runInheritedCommand(input: ClerkHostedCommand): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }

      reject(
        new Error(`Playwright exited before returning a code${signal ? ` (${signal})` : ""}.`),
      );
    });
  });
}

if (import.meta.main) {
  if (process.argv.length !== 2) {
    console.error("Clerk E2E launcher usage: bun scripts/run-clerk-e2e.ts");
    process.exitCode = 1;
  } else {
    process.exitCode = await runClerkHostedE2E();
  }
}
