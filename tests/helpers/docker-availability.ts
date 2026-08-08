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

type DockerAvailabilityOptions = {
  attempts?: number;
  retryDelayMs?: number;
  wait?: (delayMs: number) => Promise<void>;
};

const DEFAULT_DOCKER_INFO_ATTEMPTS = 3;
const DEFAULT_DOCKER_INFO_RETRY_DELAY_MS = 250;

export async function detectDockerAvailability(
  runDockerInfo: DockerInfoRunner = runDockerInfoCommand,
  options: DockerAvailabilityOptions = {},
): Promise<DockerAvailability> {
  const attempts = options.attempts ?? DEFAULT_DOCKER_INFO_ATTEMPTS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_DOCKER_INFO_RETRY_DELAY_MS;
  const wait = options.wait ?? waitForRetry;
  let lastFailure = "Docker daemon check failed.";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await runDockerInfo();
      const serverVersion = result.stdout.trim();

      if (serverVersion.length > 0) {
        return {
          available: true,
          serverVersion,
        };
      }

      lastFailure = "Docker daemon check returned no server version.";
    } catch (error) {
      lastFailure = describeDockerFailure(error);
    }

    if (attempt < attempts) {
      await wait(retryDelayMs);
    }
  }

  return {
    available: false,
    reason: lastFailure,
  };
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

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
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
