import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
  MAX_HERMES_DOCKER_PIDS_LIMIT,
  findDigitalOceanRunnerResourceProfile,
  isSupportedDigitalOceanRunnerSizeSlug,
  listDigitalOceanRunnerResourceProfiles,
  parseHermesDockerCpus,
  parseHermesDockerPidsLimit,
  validateDigitalOceanRunnerResourceCompatibility,
} from "@/src/server/runners/runner-resource-profiles";

describe("DigitalOcean runner resource profiles", () => {
  it("keeps size resources and price metadata in one deterministic catalog", () => {
    expect(listDigitalOceanRunnerResourceProfiles()).toEqual([
      {
        sizeSlug: "s-1vcpu-512mb-10gb",
        vcpus: 1,
        memoryMiB: 512,
        diskGiB: 10,
        monthlyCents: 400,
        lowMemorySwapResilience: true,
      },
      {
        sizeSlug: "s-1vcpu-1gb",
        vcpus: 1,
        memoryMiB: 1024,
        diskGiB: 25,
        monthlyCents: 600,
        lowMemorySwapResilience: false,
      },
      {
        sizeSlug: "s-1vcpu-2gb",
        vcpus: 1,
        memoryMiB: 2048,
        diskGiB: 50,
        monthlyCents: 1200,
        lowMemorySwapResilience: false,
      },
      {
        sizeSlug: "s-2vcpu-2gb",
        vcpus: 2,
        memoryMiB: 2048,
        diskGiB: 60,
        monthlyCents: 1800,
        lowMemorySwapResilience: false,
      },
    ]);
  });

  it("accepts the supported one-agent 2 GiB profile with the documented physical reserve", () => {
    expect(
      validateDigitalOceanRunnerResourceCompatibility({
        sizeSlug: "s-1vcpu-2gb",
        runnerMaxAgents: 1,
        hermesDockerCpus: "1",
        hermesDockerMemory: "1536m",
        hermesDockerPidsLimit: "256",
      }),
    ).toMatchObject({
      ok: true,
      profile: {
        sizeSlug: "s-1vcpu-2gb",
        vcpus: 1,
        memoryMiB: 2048,
      },
      requiredPhysicalMemoryMiB: 1536 + DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
      hostMemoryReserveMiB: DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
    });
  });

  it("rejects inherited object property names as supported size slugs", () => {
    for (const sizeSlug of ["toString", "constructor"]) {
      expect(isSupportedDigitalOceanRunnerSizeSlug(sizeSlug)).toBe(false);
      expect(findDigitalOceanRunnerResourceProfile(sizeSlug)).toBeNull();
      expect(
        validateDigitalOceanRunnerResourceCompatibility({
          sizeSlug,
          runnerMaxAgents: 1,
          hermesDockerCpus: "1",
          hermesDockerMemory: "1536m",
          hermesDockerPidsLimit: "256",
        }),
      ).toMatchObject({
        ok: false,
        issues: [expect.objectContaining({ field: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG" })],
      });
    }
  });

  it("fails closed for CPU precision and PID limits Docker can actually represent", () => {
    expect(parseHermesDockerCpus("0.000000001")).toBe(0.000000001);
    expect(parseHermesDockerCpus("0.0000000001")).toBeNull();
    expect(parseHermesDockerCpus("1.0000000001")).toBeNull();
    expect(parseHermesDockerPidsLimit(String(MAX_HERMES_DOCKER_PIDS_LIMIT))).toBe(
      MAX_HERMES_DOCKER_PIDS_LIMIT,
    );
    expect(parseHermesDockerPidsLimit(String(MAX_HERMES_DOCKER_PIDS_LIMIT + 1))).toBeNull();
  });

  it("rejects 512 MiB and 1 GiB hosts for the 1536 MiB Hermes limit without counting swap", () => {
    for (const sizeSlug of ["s-1vcpu-512mb-10gb", "s-1vcpu-1gb"]) {
      expect(
        validateDigitalOceanRunnerResourceCompatibility({
          sizeSlug,
          runnerMaxAgents: 1,
          hermesDockerCpus: "1",
          hermesDockerMemory: "1536m",
          hermesDockerPidsLimit: "256",
        }),
      ).toMatchObject({
        ok: false,
        issues: [
          expect.objectContaining({
            field: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
            message: expect.stringContaining("Swap is not counted as compatible memory"),
          }),
        ],
      });
    }
  });

  it("fails closed for unknown profiles, malformed limits, CPU overcommit, and capacity above one", () => {
    expect(
      validateDigitalOceanRunnerResourceCompatibility({
        sizeSlug: "s-4vcpu-8gb",
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG" })],
    });

    expect(
      validateDigitalOceanRunnerResourceCompatibility({
        sizeSlug: "s-1vcpu-2gb",
        runnerMaxAgents: 1,
        hermesDockerCpus: "1.5",
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "AGENTBAY_HERMES_DOCKER_CPUS" })],
    });

    expect(
      validateDigitalOceanRunnerResourceCompatibility({
        sizeSlug: "s-1vcpu-2gb",
        runnerMaxAgents: 1,
        hermesDockerMemory: "1536k",
      }),
    ).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ field: "AGENTBAY_HERMES_DOCKER_MEMORY" })],
    });

    expect(
      validateDigitalOceanRunnerResourceCompatibility({
        sizeSlug: "s-2vcpu-2gb",
        runnerMaxAgents: 2,
      }),
    ).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ field: "AGENTBAY_RUNNER_MAX_AGENTS" }),
      ]),
    });
  });
});
