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

  it("reports a clear skip reason when the Docker CLI is missing", async () => {
    const availability = await detectDockerAvailability(
      rejectWith(
        Object.assign(new Error(), {
          code: "ENOENT",
        }),
      ),
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
    );

    expect(availability).toEqual({
      available: false,
      reason: "Docker daemon is not reachable.",
    });
  });

  it("reports an empty Docker info response as unavailable", async () => {
    const availability = await detectDockerAvailability(async () => ({
      stderr: "",
      stdout: "\n",
    }));

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
