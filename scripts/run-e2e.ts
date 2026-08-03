import { spawn } from "node:child_process";
import { join } from "node:path";
import { readDigitalOceanProviderConfig } from "@/src/server/env";

export const CI_E2E_SELECTORS = [
  "tests/e2e/health-route.spec.ts",
  "tests/e2e/root-route.spec.ts:45",
  "tests/e2e/root-route.spec.ts:60",
  "tests/e2e/root-route.spec.ts:2187",
  "tests/e2e/automatic-ready.spec.ts",
  "tests/e2e/runtime-presentation.spec.ts",
] as const;

export const FULL_E2E_CAPABILITY_MESSAGE =
  "Full E2E capability unavailable. Configure a valid DigitalOcean or local Docker runner with AGENTBAY_DIGITALOCEAN_TOKEN and AGENTBAY_RUNNER_BEARER_TOKEN; see docs/E2E_VALIDATION.md.";

export type E2EMode = "ci" | "full";

export type E2ECommand = {
  command: string;
  args: string[];
};

type ProviderConfigReader = (
  env: Record<string, string | undefined>,
) => ReturnType<typeof readDigitalOceanProviderConfig>;
type RunCommand = (command: E2ECommand) => Promise<number>;
type WriteError = (message: string) => void;

type E2EPlan =
  | { ok: true; command: E2ECommand }
  | { ok: false; message: typeof FULL_E2E_CAPABILITY_MESSAGE };

export function planE2ECommand(
  mode: E2EMode,
  env: Record<string, string | undefined>,
  options: {
    cwd?: string;
    platform?: NodeJS.Platform;
    readProviderConfig?: ProviderConfigReader;
  } = {},
): E2EPlan {
  if (mode === "full") {
    const readProviderConfig = options.readProviderConfig ?? readDigitalOceanProviderConfig;

    try {
      if (!readProviderConfig(env)) {
        return { ok: false, message: FULL_E2E_CAPABILITY_MESSAGE };
      }
    } catch {
      return { ok: false, message: FULL_E2E_CAPABILITY_MESSAGE };
    }
  }

  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const executable = platform === "win32" ? "playwright.cmd" : "playwright";

  return {
    ok: true,
    command: {
      command: join(cwd, "node_modules", ".bin", executable),
      args: ["test", ...(mode === "ci" ? CI_E2E_SELECTORS : [])],
    },
  };
}

export async function runE2E(
  mode: E2EMode,
  env: Record<string, string | undefined> = process.env,
  options: {
    cwd?: string;
    platform?: NodeJS.Platform;
    readProviderConfig?: ProviderConfigReader;
    runCommand?: RunCommand;
    writeError?: WriteError;
  } = {},
): Promise<number> {
  const plan = planE2ECommand(mode, env, options);

  if (!plan.ok) {
    (options.writeError ?? console.error)(plan.message);
    return 1;
  }

  return (options.runCommand ?? runInheritedCommand)(plan.command);
}

function runInheritedCommand(input: E2ECommand): Promise<number> {
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

function parseMode(argv: string[]): E2EMode | null {
  if (argv.length !== 1) {
    return null;
  }

  return argv[0] === "ci" || argv[0] === "full" ? argv[0] : null;
}

if (import.meta.main) {
  const mode = parseMode(process.argv.slice(2));

  if (!mode) {
    console.error("E2E launcher usage: bun scripts/run-e2e.ts ci|full");
    process.exitCode = 1;
  } else {
    process.exitCode = await runE2E(mode);
  }
}
