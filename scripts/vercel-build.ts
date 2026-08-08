import { spawn } from "node:child_process";
import { requireValidAuthMode } from "@/src/auth/auth-mode";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";

type VercelBuildEnvironment = Record<string, string | undefined>;

export type VercelBuildCommand = {
  command: string;
  args: string[];
};

type RunCommand = (command: VercelBuildCommand) => Promise<void>;

export function planVercelBuildCommands(env: VercelBuildEnvironment): VercelBuildCommand[] {
  const commands: VercelBuildCommand[] = [];
  requireValidAuthMode(env);

  if (env.VERCEL_ENV === "production") {
    if (!env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required for production Vercel migrations.");
    }

    if (env.BRUNO_READY_AGENT_CREATION_ENABLED?.trim() === "true") {
      if (!env.BRUNO_DIGITALOCEAN_TOKEN?.trim()) {
        throw new Error(
          "DigitalOcean runner provisioning is required when ready agent creation is enabled in production.",
        );
      }
      if (!env.BRUNO_RUNNER_BEARER_TOKEN?.trim()) {
        throw new Error(
          "BRUNO_RUNNER_BEARER_TOKEN is required when ready agent creation is enabled in production.",
        );
      }
      if (!parseImmutableRunnerImageReference(env.BRUNO_RUNNER_IMAGE?.trim() ?? "")) {
        throw new Error(
          "BRUNO_RUNNER_IMAGE must be an immutable registry image reference with a sha256 digest for hosted DigitalOcean provisioning.",
        );
      }
    }

    commands.push({ command: "bun", args: ["run", "db:migrate"] });
  }

  commands.push({ command: "bun", args: ["run", "build"] });
  return commands;
}

export async function runVercelBuild(
  env: VercelBuildEnvironment = process.env,
  runCommand: RunCommand = runInheritedCommand,
): Promise<void> {
  for (const command of planVercelBuildCommands(env)) {
    await runCommand(command);
  }
}

function runInheritedCommand(input: VercelBuildCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          `${input.command} ${input.args.join(" ")} failed with ${
            signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`
          }.`,
        ),
      );
    });
  });
}

if (import.meta.main) {
  await runVercelBuild();
}
