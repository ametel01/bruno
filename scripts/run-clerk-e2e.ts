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

export const CLERK_HOSTED_SETUP_FAILURE_MESSAGE =
  "Hosted Clerk E2E setup failed. Verify the approved development capability and try again; raw provider details are intentionally suppressed.";

export type ClerkHostedCommand = {
  command: string;
  args: string[];
};

type ClerkHostedPlan = { ok: true; command: ClerkHostedCommand } | { ok: false; message: string };

type RunCommand = (command: ClerkHostedCommand) => Promise<number>;
type WriteError = (message: string) => void;
type SetupClerk = () => Promise<void>;

export function planClerkHostedCommand(
  env: Record<string, string | undefined>,
  options: { cwd?: string; platform?: NodeJS.Platform } = {},
): ClerkHostedPlan {
  const missing: string[] = CLERK_HOSTED_REQUIRED_ENV.filter((name) => !hasValue(env[name]));
  if (!CLERK_HOSTED_AUTH_ENV.some((name) => hasValue(env[name]))) {
    missing.push("CLERK_SECRET_KEY");
  }

  const userA = env.E2E_CLERK_TEST_USER_A_EMAIL?.trim();
  const userB = env.E2E_CLERK_TEST_USER_B_EMAIL?.trim();
  if (
    userA !== undefined &&
    userB !== undefined &&
    userA !== "" &&
    userB !== "" &&
    (userA.toLowerCase() === userB.toLowerCase() ||
      !isClerkTestIdentity(userA) ||
      !isClerkTestIdentity(userB))
  ) {
    missing.push("distinct +clerk_test identities");
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
    setupClerk?: SetupClerk;
  } = {},
): Promise<number> {
  const plan = planClerkHostedCommand(env, options);

  if (!plan.ok) {
    (options.writeError ?? console.error)(plan.message);
    return 1;
  }

  try {
    await (options.setupClerk ?? setupClerkTestingEnvironment)();
  } catch {
    (options.writeError ?? console.error)(CLERK_HOSTED_SETUP_FAILURE_MESSAGE);
    return 1;
  }

  return (options.runCommand ?? runInheritedCommand)(plan.command);
}

function hasValue(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function isClerkTestIdentity(value: string): boolean {
  return /^[^@\s]+\+clerk_test@[^@\s]+\.[^@\s]+$/i.test(value);
}

async function setupClerkTestingEnvironment(): Promise<void> {
  const { clerkSetup } = await import("@clerk/testing/playwright");
  await clerkSetup();
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
