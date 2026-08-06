import { describe, expect, it } from "vitest";
import {
  parseBenchmarkOptions,
  runAgentCreationBenchmark,
} from "@/scripts/benchmark-agent-creation";

describe("agent creation benchmark command", () => {
  it("defaults to read-only existing-run reporting", () => {
    expect(parseBenchmarkOptions([])).toEqual({
      mode: "existing",
      limit: 100,
      trials: 0,
      providerAuthorized: false,
    });
  });

  it("parses bounded read-only filters", () => {
    expect(
      parseBenchmarkOptions([
        "--mode",
        "existing",
        "--limit",
        "30",
        "--deployment-id",
        "00000000-0000-4000-8000-000000000001",
      ]),
    ).toEqual({
      mode: "existing",
      limit: 30,
      deploymentId: "00000000-0000-4000-8000-000000000001",
      trials: 0,
      providerAuthorized: false,
    });
  });

  it("fails closed before any DigitalOcean benchmark execution", async () => {
    await expect(
      runAgentCreationBenchmark(["--mode", "digitalocean"], {
        AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION: undefined,
      }),
    ).rejects.toThrow(/DigitalOcean benchmark mode is fail-closed/);
  });

  it("requires exact bounded positive-integer syntax for provider trials", () => {
    expect(() => parseBenchmarkOptions(["--mode", "digitalocean", "--trials", "1oops"])).toThrow(
      /--trials must be an exact positive integer/,
    );
    expect(() => parseBenchmarkOptions(["--mode", "digitalocean", "--trials", "1.5"])).toThrow(
      /--trials must be an exact positive integer/,
    );
    expect(() => parseBenchmarkOptions(["--mode", "digitalocean", "--trials", "31"])).toThrow(
      /--trials must be a positive integer no greater than 30/,
    );
  });

  it("requires exact bounded positive-integer syntax for report limits", () => {
    expect(() => parseBenchmarkOptions(["--limit", "1oops"])).toThrow(
      /--limit must be an exact positive integer/,
    );
    expect(() => parseBenchmarkOptions(["--limit", "1001"])).toThrow(
      /--limit must be a positive integer no greater than 1000/,
    );
  });

  it("requires exact local Docker sentinels for local benchmark mode", async () => {
    await expect(
      runAgentCreationBenchmark(["--mode", "local_docker"], {
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
        AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
        AGENTBAY_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      }),
    ).rejects.toThrow(/Local Docker benchmark mode requires/);
  });
});
