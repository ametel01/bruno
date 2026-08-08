import { describe, expect, it } from "vitest";
import {
  detectDockerAvailability,
  dockerUnavailableSkipReason,
  type DockerInfoRunner,
} from "@/tests/helpers/docker-availability";

describe("Docker availability test helper", () => {
  it("reports Docker as available with the server version", async () => {
    const availability = await detectDockerAvailability(async () => ({
      stderr: "",
      stdout: "29.3.1\n",
    }));

    expect(availability).toEqual({
      available: true,
      serverVersion: "29.3.1",
    });
    expect(dockerUnavailableSkipReason(availability)).toBeNull();
  });

  it("retries a transient Docker daemon failure before reporting availability", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const availability = await detectDockerAvailability(
      async () => {
        attempts += 1;

        if (attempts === 1) {
          throw new Error("Docker daemon probe timed out");
        }

        return { stderr: "", stdout: "29.3.1\n" };
      },
      {
        retryDelayMs: 250,
        wait: async (delayMs) => {
          waits.push(delayMs);
        },
      },
    );

    expect(availability).toEqual({ available: true, serverVersion: "29.3.1" });
    expect(attempts).toBe(2);
    expect(waits).toEqual([250]);
  });

  it("reports a clear skip reason when the Docker CLI is missing", async () => {
    const availability = await detectDockerAvailability(
      rejectWith(
        Object.assign(new Error(), {
          code: "ENOENT",
        }),
      ),
      { attempts: 1 },
    );

    expect(availability).toEqual({
      available: false,
      reason: "Docker CLI was not found on PATH.",
    });
    expect(dockerUnavailableSkipReason(availability)).toBe(
      "Skipping real Docker tests: Docker CLI was not found on PATH.",
    );
  });

  it("reports a clear skip reason when the Docker daemon is unreachable", async () => {
    const availability = await detectDockerAvailability(
      rejectWith(new Error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock")),
      { attempts: 1 },
    );

    expect(availability).toEqual({
      available: false,
      reason: "Docker daemon is not reachable.",
    });
  });

  it("reports an empty Docker info response as unavailable", async () => {
    const availability = await detectDockerAvailability(
      async () => ({
        stderr: "",
        stdout: "\n",
      }),
      { attempts: 1 },
    );

    expect(availability).toEqual({
      available: false,
      reason: "Docker daemon check returned no server version.",
    });
  });
});

function rejectWith(error: unknown): DockerInfoRunner {
  return async () => {
    throw error;
  };
}
