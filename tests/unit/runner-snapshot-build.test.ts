import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  buildRunnerSnapshot,
  buildSnapshotBuilderBootstrap,
} from "@/src/server/runners/runner-snapshot-build";

const RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:abc123@sha256:${"a".repeat(64)}`;
const AGENT_IMAGE = `ghcr.io/ametel01/agentbay-default:abc123@sha256:${"b".repeat(64)}`;
const AUTH = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";

describe("runner snapshot build orchestration", () => {
  it("installs Docker and Caddy before preloading images and emits boot/sanitation evidence", () => {
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: RUNNER_IMAGE,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });

    expect(userData.indexOf("apt-get install -y docker-ce")).toBeLessThan(
      userData.indexOf(`docker pull '${RUNNER_IMAGE}'`),
    );
    expect(userData).toContain("systemctl enable --now docker");
    expect(userData).toContain("systemctl enable --now caddy");
    expect(userData).toContain("/run/agentbay-snapshot-builder/boot-result.json");
    expect(userData).toContain("/run/agentbay-snapshot-builder/sanitation-result.json");
    expect(userData).toContain("docker image inspect");
    expect(userData).toContain("docker ps -aq | xargs --no-run-if-empty docker rm --force");
    expect(userData).toContain("grep -R -I -F");
    expect(userData).toContain("AGENTBAY_RUNNER_REGISTRATION_TOKEN");
    expect(userData).toContain("BEGIN OPENSSH PRIVATE KEY");
  });

  it("shell-quotes image references in the builder bootstrap", () => {
    const maliciousImage = `ghcr.io/owner/runner@sha256:${"a".repeat(64)}'; touch /tmp/pwned; '`;
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: maliciousImage,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });

    expect(userData).toContain("'\"'\"'; touch /tmp/pwned; '\"'\"''");
    expect(userData).not.toContain(`docker pull '${maliciousImage}'`);
  });

  it("builds a signed manifest only after boot, sanitation, power-off, snapshot, and availability", async () => {
    const provider = new FakeDigitalOceanProvider();
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
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        deletedSnapshotId: null,
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "powerOff",
      "readAction",
      "snapshot",
      "readAction",
      "readImage",
      "observeOwnedSet",
      "deleteFirewall",
      "observeOwnedSet",
      "observeOwnedSet",
      "deleteDroplet",
      "observeOwnedSet",
      "observeOwnedSet",
      "observeOwnedSet",
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
        deletedFirewallId: null,
        ambiguousOwnership: false,
        absenceVerified: false,
        steps: [],
      },
    });
    expect(provider.calls).toEqual([]);
  });

  it("deletes the builder and partial snapshot when sanitation fails after creation", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      sanitationResult: {
        ok: false,
        builderResourceId: "do-fake-1",
        forbiddenPathsAbsent: false,
        hostileMarkersAbsent: true,
        removedPaths: ["/etc/agentbay/runner.env"],
        scannedPaths: ["/etc"],
        hostileMarkers: ["AGENTBAY_RUNNER_REGISTRATION_TOKEN"],
        completedAt: "2026-08-07T00:00:02.000Z",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "sanitation_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "observeOwnedSet",
      "deleteFirewall",
      "observeOwnedSet",
      "observeOwnedSet",
      "deleteDroplet",
      "observeOwnedSet",
      "observeOwnedSet",
      "observeOwnedSet",
    ]);
  });

  it("fails closed on asynchronous action errors and removes the partial snapshot", async () => {
    const provider = new ActionErroredProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("readAction");
  });

  it("records ambiguous ownership and does not delete an unowned builder", async () => {
    const provider = new AmbiguousOwnedSetProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: true,
      cleanup: {
        deletedDropletId: null,
        deletedFirewallId: null,
        ambiguousOwnership: true,
        absenceVerified: false,
      },
    });
    expect(provider.calls.map((call) => call.step)).not.toContain("deleteDroplet");
  });
});

class ActionErroredProvider extends FakeDigitalOceanProvider {
  override async readAction(input: { actionId: string }, context?: { signal: AbortSignal }) {
    await super.readAction(input, context);
    return {
      ok: true as const,
      value: {
        id: input.actionId,
        status: input.actionId.endsWith("02") ? ("errored" as const) : ("completed" as const),
        type: input.actionId.endsWith("02") ? "snapshot" : "power_off",
        resourceId: "do-fake-1",
      },
    };
  }
}

class AmbiguousOwnedSetProvider extends FakeDigitalOceanProvider {
  override async observeOwnedSet(
    input: Parameters<FakeDigitalOceanProvider["observeOwnedSet"]>[0],
  ) {
    this.calls.push({ step: "observeOwnedSet", input });
    return {
      ok: false as const,
      reason: "ownership_ambiguous" as const,
      retryable: false,
      message: "ambiguous owner",
    };
  }
}

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
      builderResourceId: "do-fake-1",
      runnerImage: RUNNER_IMAGE,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      preloadedImages: [RUNNER_IMAGE, AGENT_IMAGE, DEFAULT_HERMES_WORKLOAD_IMAGE],
      completedAt: "2026-08-07T00:00:01.000Z",
    },
    sanitationResult: {
      ok: true,
      builderResourceId: "do-fake-1",
      forbiddenPathsAbsent: true,
      hostileMarkersAbsent: true,
      removedPaths: [
        "/etc/agentbay/runner.env",
        "/root/.docker/config.json",
        "/var/lib/cloud/instances",
        "/etc/ssh/ssh_host_ed25519_key",
        "/etc/machine-id",
        "/var/log/cloud-init-output.log",
      ],
      scannedPaths: ["/etc", "/root", "/var/lib/agentbay", "/var/log"],
      hostileMarkers: [
        "AGENTBAY_RUNNER_REGISTRATION_TOKEN",
        "AGENTBAY_RUNNER_BEARER_TOKEN",
        "dop_v1_",
        "BEGIN OPENSSH PRIVATE KEY",
      ],
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
