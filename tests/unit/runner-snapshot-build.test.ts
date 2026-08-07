import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import { buildRunnerSnapshot } from "@/src/server/runners/runner-snapshot-build";

const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:abc123@sha256:${"a".repeat(64)}`;
const AGENT_IMAGE = `ghcr.io/ametel01/agentbay-default:abc123@sha256:${"b".repeat(64)}`;
const AUTH = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";

describe("runner snapshot build orchestration", () => {
  it("builds a signed manifest only after boot, sanitation, power-off, snapshot, and availability", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "snapshot" });
    const { privateKey } = generateKeyPairSync("ed25519");

    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        snapshot: { id: "1102", regions: ["sfo3"], architecture: "amd64" },
      },
      cleanup: { deletedDropletId: "snapshot-1", deletedSnapshotId: null },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "powerOff",
      "snapshot",
      "readImage",
      "cleanup",
    ]);
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("fails before provider effects without the cost authorization sentinel", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      costAuthorization: "yes",
    });

    expect(result).toEqual({
      ok: false,
      reason: "authorization_missing",
      cleanup: {
        deletedSnapshotId: null,
        deletedDropletId: null,
        ambiguousOwnership: false,
        steps: [],
      },
    });
    expect(provider.calls).toEqual([]);
  });

  it("deletes the builder and partial snapshot when sanitation fails after creation", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "failed-snapshot" });
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      sanitationResult: {
        ok: false,
        forbiddenPathsAbsent: false,
        hostileMarkersAbsent: true,
        completedAt: "2026-08-07T00:00:02.000Z",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "sanitation_failed",
      cleanup: { deletedDropletId: "failed-snapshot-1" },
    });
    expect(provider.calls.map((call) => call.step)).toEqual(["create", "cleanup"]);
  });
});

function baseInput(provider: FakeDigitalOceanProvider) {
  return {
    costAuthorization: AUTH,
    operationId: "123456",
    sourceRevision: "1".repeat(40),
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    baseImageId: "ubuntu-24-04-x64-20260801",
    baseImageSlug: "ubuntu-24-04-x64",
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    bootResult: {
      ok: true,
      runnerImage: RUNNER_IMAGE,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      completedAt: "2026-08-07T00:00:01.000Z",
    },
    sanitationResult: {
      ok: true,
      forbiddenPathsAbsent: true,
      hostileMarkersAbsent: true,
      completedAt: "2026-08-07T00:00:02.000Z",
    },
    privateKeyPem: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
    provider,
    context: { signal: new AbortController().signal },
    now: () => new Date("2026-08-07T00:00:03.000Z"),
  };
}
