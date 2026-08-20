import { spawn } from "node:child_process";
import { join } from "node:path";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
import { buildTestGoogleConnectedAcceptanceRelease } from "./founder-google-test-release";
import {
  buildTestOpenAiConnectedAcceptanceRelease,
  TEST_OPENAI_RELEASE_REVISION,
} from "./founder-openai-test-release";

export const CI_E2E_SELECTORS = [
  "tests/e2e/health-route.spec.ts",
  "tests/e2e/founder-surface-retirement.spec.ts",
  "tests/e2e/root-route.spec.ts:54",
  "tests/e2e/founder-conversation.spec.ts",
  "tests/e2e/founder-calendar-connection.spec.ts",
] as const;

export const FULL_E2E_CAPABILITY_MESSAGE =
  "Full E2E capability unavailable. Configure a valid DigitalOcean or local Docker runner with BRUNO_DIGITALOCEAN_TOKEN and BRUNO_RUNNER_BEARER_TOKEN; see docs/E2E_VALIDATION.md.";

export type E2EMode = "ci" | "full";

export type E2ECommand = {
  command: string;
  args: string[];
};

type ProviderConfigReader = (
  env: Record<string, string | undefined>,
) => ReturnType<typeof readDigitalOceanProviderConfig>;
type RunCommand = (command: E2ECommand, env: Record<string, string | undefined>) => Promise<number>;
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

  const commandEnv = buildE2ECommandEnvironment(mode, env);
  return (options.runCommand ?? runInheritedCommand)(plan.command, commandEnv);
}

function buildE2ECommandEnvironment(
  mode: E2EMode,
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const commandEnv = { ...env };
  if (mode === "full") return commandEnv;

  for (const name of Object.keys(commandEnv)) {
    if (name.startsWith("BRUNO_PROVIDER_TRIAL_")) delete commandEnv[name];
  }
  commandEnv.BRUNO_DIGITALOCEAN_TOKEN = "";
  commandEnv.BRUNO_PROVIDER_TRIAL_MODEL_API_KEY = "";
  commandEnv.BRUNO_PROVIDER_TRIAL_TELEGRAM_BOT_TOKEN = "";
  commandEnv.BRUNO_AUTH_MODE = "development";
  commandEnv.BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE =
    buildTestGoogleConnectedAcceptanceRelease("calendar_reading");
  commandEnv.BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE =
    buildTestGoogleConnectedAcceptanceRelease("gmail_reading");
  commandEnv.BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE =
    buildTestOpenAiConnectedAcceptanceRelease();
  commandEnv.PORT = "3100";
  commandEnv.NEXT_PUBLIC_APP_URL = "http://localhost:3100";
  commandEnv.PLAYWRIGHT_BASE_URL = "http://localhost:3100";
  commandEnv.PLAYWRIGHT_REUSE_EXISTING_SERVER = "";
  commandEnv.VERCEL_GIT_COMMIT_SHA = TEST_OPENAI_RELEASE_REVISION;
  return commandEnv;
}

function runInheritedCommand(
  input: E2ECommand,
  env: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: env as NodeJS.ProcessEnv,
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
