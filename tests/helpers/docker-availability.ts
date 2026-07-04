import { execFile } from "node:child_process";

export type DockerAvailability =
  | {
      available: true;
      serverVersion: string;
    }
  | {
      available: false;
      reason: string;
    };

export type DockerInfoRunner = () => Promise<{
  stderr: string;
  stdout: string;
}>;

export async function detectDockerAvailability(
  runDockerInfo: DockerInfoRunner = runDockerInfoCommand,
): Promise<DockerAvailability> {
  try {
    const result = await runDockerInfo();
    const serverVersion = result.stdout.trim();

    if (serverVersion.length === 0) {
      return {
        available: false,
        reason: "Docker daemon check returned no server version.",
      };
    }

    return {
      available: true,
      serverVersion,
    };
  } catch (error) {
    return {
      available: false,
      reason: describeDockerFailure(error),
    };
  }
}

export function dockerUnavailableSkipReason(availability: DockerAvailability): string | null {
  if (availability.available) {
    return null;
  }

  return `Skipping real Docker tests: ${availability.reason}`;
}

function runDockerInfoCommand(): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      {
        encoding: "utf8",
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolve({ stderr, stdout });
      },
    );
  });
}

function describeDockerFailure(error: unknown): string {
  if (isNodeError(error) && error.code === "ENOENT") {
    return "Docker CLI was not found on PATH.";
  }

  const message = error instanceof Error ? error.message.trim() : "";

  if (message.includes("Cannot connect to the Docker daemon")) {
    return "Docker daemon is not reachable.";
  }

  if (message.length > 0) {
    return `Docker daemon check failed: ${message}`;
  }

  return "Docker daemon check failed.";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
