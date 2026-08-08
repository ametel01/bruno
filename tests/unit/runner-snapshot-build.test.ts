import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  buildRunnerSnapshot,
  buildSnapshotBuilderBootstrap,
} from "@/src/server/runners/runner-snapshot-build";

const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:abc123@sha256:${"a".repeat(64)}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:abc123@sha256:${"b".repeat(64)}`;
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
    expect(userData).toContain("/run/bruno-snapshot-builder/boot-result.json");
    expect(userData).toContain("/run/bruno-snapshot-builder/sanitation-result.json");
    expect(userData).toContain("docker image inspect");
    expect(userData).toContain("docker ps -aq | xargs --no-run-if-empty docker rm --force");
    expect(userData).toContain("grep -R -I -F");
    expect(userData).toContain("BRUNO_RUNNER_REGISTRATION_TOKEN");
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
        snapshot: { id: "9102", regions: ["sfo3"], architecture: "amd64" },
      },
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        deletedSshKeyId: null,
        sshKeyDeletionFailed: false,
        deletedSnapshotId: null,
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "readBuilderEvidence",
      "powerOff",
      "readAction",
      "snapshot",
      "readAction",
      "findImage",
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
    expect(provider.calls).toEqual(
      expect.arrayContaining([
        {
          step: "firewall",
          input: expect.objectContaining({
            sshSourceAddresses: ["203.0.113.7/32"],
            webSourceAddresses: [],
          }),
        },
      ]),
    );
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
        deletedSshKeyId: null,
        sshKeyDeletionFailed: false,
        ambiguousOwnership: false,
        absenceVerified: false,
        steps: [],
      },
    });
    expect(provider.calls).toEqual([]);
  });

  it("fails before provider effects on world-open, non-exact, invalid, or injected controller CIDRs", async () => {
    for (const controllerSshSourceCidr of [
      "0.0.0.0/0",
      "0.0.0.0/32",
      "::/0",
      "::/128",
      "203.0.113.7/24",
      "bad/32",
      "203.0.113.7/32; touch /tmp/pwned",
    ]) {
      const provider = new FakeDigitalOceanProvider();
      const result = await buildRunnerSnapshot({
        ...baseInput(provider),
        controllerSshSourceCidr,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "input_invalid",
      });
      expect(provider.calls).toEqual([]);
    }
  });

  it("records ephemeral SSH key deletion success in cleanup evidence", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderSshKeyId: "ssh-key-123",
    });

    expect(result).toMatchObject({
      ok: true,
      cleanup: {
        deletedSshKeyId: "ssh-key-123",
        sshKeyDeletionFailed: false,
      },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([{ step: "deleteSshKey", input: { id: "ssh-key-123" } }]),
    );
  });

  it("records provider SSH key deletion failure without claiming success", async () => {
    const provider = new FakeDigitalOceanProvider({ fail: { deleteSshKey: "delete denied" } });
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderSshKeyId: "ssh-key-123",
    });

    expect(result).toMatchObject({
      ok: true,
      cleanup: {
        deletedSshKeyId: null,
        sshKeyDeletionFailed: true,
      },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([{ step: "deleteSshKey", input: { id: "ssh-key-123" } }]),
    );
  });

  it("deletes the builder when retrieved sanitation evidence fails after creation", async () => {
    const provider = new BadSanitationEvidenceProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
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
      "readBuilderEvidence",
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

  it("fails closed when the expected builder host key does not match the pinned identity", async () => {
    const provider = new FakeDigitalOceanProvider({
      builderHostKeySha256: "SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      expectedBuilderHostKeySha256: "SHA256:ccccccccccccccccccccccccccccccccccccccccccc",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "boot_fixture_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("readBuilderEvidence");
    expect(provider.calls.map((call) => call.step)).not.toContain("powerOff");
  });

  it("rejects invalid expected builder host-key fingerprints before provider effects", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      expectedBuilderHostKeySha256: "SHA256:bad; touch /tmp/pwned",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "input_invalid",
    });
    expect(provider.calls).toEqual([]);
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

  it("does not use the snapshot action ID as the manifest image ID", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: true,
      manifest: { snapshot: { id: "9102" } },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([
        { step: "readAction", input: { actionId: "8102" } },
        { step: "findImage", input: { name: "bruno-snapshot-builder-111111111111" } },
        { step: "readImage", input: { imageId: "9102" } },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('"id":"8102"');
  });

  it("fails closed when the provider cannot resolve a distinct snapshot image after action completion", async () => {
    const provider = new MissingSnapshotImageProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_unavailable",
      cleanup: {
        deletedSnapshotId: null,
        deletedDropletId: "do-fake-1",
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("findImage");
    expect(provider.calls.map((call) => call.step)).not.toContain("readImage");
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

class BadSanitationEvidenceProvider extends FakeDigitalOceanProvider {
  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
    context?: { signal: AbortSignal },
  ) {
    const result = await super.readSnapshotBuilderEvidence(input, context);
    if (!result.ok) return result;
    return {
      ok: true as const,
      value: {
        ...result.value,
        sanitationResult: {
          ok: false,
          builderResourceId: input.providerResourceId,
          forbiddenPathsAbsent: false,
          hostileMarkersAbsent: true,
          removedPaths: ["/etc/bruno/runner.env"],
          scannedPaths: ["/etc"],
          hostileMarkers: ["BRUNO_RUNNER_REGISTRATION_TOKEN"],
          completedAt: "2026-08-07T00:00:02.000Z",
        },
      },
    };
  }
}

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

class MissingSnapshotImageProvider extends FakeDigitalOceanProvider {
  override async findSnapshotImageByName(
    input: Parameters<FakeDigitalOceanProvider["findSnapshotImageByName"]>[0],
    context?: { signal: AbortSignal },
  ) {
    await super.findSnapshotImageByName(input, context);
    return {
      ok: false as const,
      reason: "image_lookup_failed" as const,
      message: "missing image",
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
    controllerSshSourceCidr: "203.0.113.7/32",
    privateKeyPem: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
    provider,
    context: { signal: new AbortController().signal },
    now: () => new Date("2026-08-07T00:00:03.000Z"),
  };
}
