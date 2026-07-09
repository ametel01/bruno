import { spawn } from "node:child_process";

type VercelBuildEnvironment = Record<string, string | undefined>;

export type VercelBuildCommand = {
  command: string;
  args: string[];
};

type RunCommand = (command: VercelBuildCommand) => Promise<void>;

export function planVercelBuildCommands(env: VercelBuildEnvironment): VercelBuildCommand[] {
  const commands: VercelBuildCommand[] = [];

  if (env.VERCEL_ENV === "production") {
    if (!env.DATABASE_URL?.trim()) {
      throw new Error("DATABASE_URL is required for production Vercel migrations.");
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
