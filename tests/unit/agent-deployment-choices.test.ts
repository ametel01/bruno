import { describe, expect, it } from "vitest";
import {
  applyAgentDeploymentChoices,
  captureAgentDeploymentChoices,
  parseAgentDeploymentChoices,
} from "@/src/server/agents/agent-deployment-choices";
import type { DigitalOceanProviderConfig } from "@/src/server/env";

describe("pinned Agent Deployment choices", () => {
  it("keeps accepted infrastructure and validation choices while using current credentials", () => {
    const accepted = providerConfig({ token: "old-secret", sizeSlug: "s-1vcpu-2gb" });
    const choices = captureAgentDeploymentChoices({
      config: accepted,
      dispatchMode: "qstash",
      rolloutConfigurationGeneration: 7,
    });
    const current = providerConfig({ token: "new-secret", sizeSlug: "s-2vcpu-2gb" });

    expect(applyAgentDeploymentChoices(current, choices)).toMatchObject({
      token: "new-secret",
      runnerBearerToken: "new-runner-secret",
      sizeSlug: "s-1vcpu-2gb",
      runnerImage: accepted.runnerImage,
      snapshotMode: accepted.snapshotMode,
      bootValidation: accepted.bootValidation,
    });
    expect(choices).toMatchObject({
      schemaVersion: "bruno.agent-deployment.choices.v1",
      dispatchMode: "qstash",
      rolloutConfigurationGeneration: 7,
      provider: { sizeSlug: "s-1vcpu-2gb" },
      validation: {
        mode: "release_attested",
        releaseBundleDigest: `sha256:${"e".repeat(64)}`,
        snapshotBundleDigest: `sha256:${"d".repeat(64)}`,
      },
    });
    expect(JSON.stringify(choices)).not.toContain("old-secret");
    expect(JSON.stringify(choices)).not.toContain("new-secret");
  });

  it("rejects unknown or partially rewritten recorded choices", () => {
    const choices = captureAgentDeploymentChoices({
      config: providerConfig({ token: "secret", sizeSlug: "s-1vcpu-2gb" }),
      dispatchMode: "cron",
      rolloutConfigurationGeneration: 3,
    });
    expect(parseAgentDeploymentChoices(choices)).toEqual(choices);
    expect(parseAgentDeploymentChoices({ ...choices, ownerToken: "hostile" })).toBeNull();
    expect(
      parseAgentDeploymentChoices({
        ...choices,
        validation: { ...choices.validation, mode: "full" },
      }),
    ).toBeNull();
  });
});

function providerConfig(input: { token: string; sizeSlug: string }): DigitalOceanProviderConfig {
  const snapshotDigest = `sha256:${"d".repeat(64)}`;
  const releaseDigest = `sha256:${"e".repeat(64)}`;
  return {
    token: input.token,
    providerMode: "digitalocean",
    runnerBearerToken: "new-runner-secret",
    runnerImage: `ghcr.io/ametel01/bruno-runner:release@sha256:${"a".repeat(64)}`,
    hermesWorkloadImage: `ghcr.io/nousresearch/hermes:release@sha256:${"b".repeat(64)}`,
    region: "sfo3",
    sizeSlug: input.sizeSlug,
    image: "1102",
    tags: ["bruno", "bruno-runner"],
    snapshotMode: {
      mode: "snapshot",
      bundleBytes: '{"snapshot":"bundle"}',
      approvedDigest: snapshotDigest,
      trustedPublicKeys: { "snapshot-current": "snapshot-public-key" },
      expected: {
        region: "sfo3",
        sizeSlug: input.sizeSlug,
        sizeDiskGb: 50,
        baseImageId: "ubuntu-24-04-x64-20200101",
        baseImageSlug: "ubuntu-24-04-x64",
        architecture: "amd64",
        runnerImage: `ghcr.io/ametel01/bruno-runner:release@sha256:${"a".repeat(64)}`,
        defaultAgentImage: `ghcr.io/ametel01/bruno-agent:release@sha256:${"c".repeat(64)}`,
        hermesImage: `ghcr.io/nousresearch/hermes:release@sha256:${"b".repeat(64)}`,
      },
    },
    bootValidation: {
      mode: "release_attested",
      bundleBytes: '{"release":"bundle"}',
      approvedReleaseDigest: releaseDigest,
      releaseTrustSetBytes: '{"release-current":"release-public-key"}',
      trustedPublicKeys: { "release-current": "release-public-key" },
      snapshotOciReference: `ghcr.io/ametel01/bruno-snapshots@sha256:${"f".repeat(64)}`,
      snapshotBundleDigest: snapshotDigest,
      snapshotImageId: "1102",
    },
  };
}
