import { describe, expect, it } from "vitest";
import {
  applyAgentDeploymentChoices,
  captureAgentDeploymentChoices,
  parseAgentDeploymentChoices,
  runnerCompatibilityRequirementForAgentDeploymentChoices,
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
    const current = {
      ...providerConfig({ token: "new-secret", sizeSlug: "s-2vcpu-2gb" }),
      sshKeyIds: ["current-key"],
      sshSourceAddresses: ["198.51.100.0/24"],
    };

    expect(applyAgentDeploymentChoices(current, choices)).toMatchObject({
      token: "new-secret",
      runnerBearerToken: "new-runner-secret",
      sizeSlug: "s-1vcpu-2gb",
      sshKeyIds: ["accepted-key"],
      sshSourceAddresses: ["203.0.113.0/24"],
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

  it("pins local lifecycle settings without retaining provider credentials", () => {
    const accepted = localProviderConfig({
      endpointUrl: "http://host.docker.internal:3045",
      containerName: "accepted-runner",
    });
    const choices = captureAgentDeploymentChoices({
      config: accepted,
      dispatchMode: "cron",
      rolloutConfigurationGeneration: 4,
    });
    const current = localProviderConfig({
      endpointUrl: "http://host.docker.internal:4045",
      containerName: "current-runner",
    });

    expect(applyAgentDeploymentChoices(current, choices)).toMatchObject({
      token: "current-local-secret",
      runnerBearerToken: "current-runner-secret",
      localRunnerEndpointUrl: "http://host.docker.internal:3045",
      localRunnerContainerName: "accepted-runner",
      localRunnerStartDelayMs: 250,
      localAgentSmokeMode: true,
    });
    expect(JSON.stringify(choices)).not.toContain("accepted-local-secret");
    expect(JSON.stringify(choices)).not.toContain("current-local-secret");
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

  it("pins boot compatibility and disables mutable SSH-key discovery when no keys were accepted", () => {
    const accepted = providerConfig({ token: "accepted-secret", sizeSlug: "s-1vcpu-2gb" });
    delete accepted.sshKeyIds;
    delete accepted.sshSourceAddresses;
    const choices = captureAgentDeploymentChoices({
      config: accepted,
      dispatchMode: "cron",
      rolloutConfigurationGeneration: 2,
    });

    expect(choices.provider).toMatchObject({
      runnerBootContractVersion: "bruno.runner.boot.v1",
      sshKeyIds: [],
      sshSourceAddresses: [],
    });
    expect(runnerCompatibilityRequirementForAgentDeploymentChoices(choices)).toMatchObject({
      mode: "hosted",
      release: { bootContractVersion: "bruno.runner.boot.v1" },
    });
    expect(
      applyAgentDeploymentChoices({ ...accepted, sshKeyIds: ["mutable-account-key"] }, choices),
    ).toMatchObject({ sshKeyIds: [], sshSourceAddresses: [] });
  });

  it("gives legacy v1 records deterministic recovery semantics", () => {
    const complete = captureAgentDeploymentChoices({
      config: providerConfig({ token: "accepted-secret", sizeSlug: "s-1vcpu-2gb" }),
      dispatchMode: "cron",
      rolloutConfigurationGeneration: 2,
    });
    const legacy = structuredClone(complete) as unknown as {
      provider: Record<string, unknown>;
    };
    for (const key of [
      "runnerBootContractVersion",
      "sshKeyIds",
      "sshSourceAddresses",
      "localRunnerEndpointUrl",
      "localRunnerContainerName",
      "localRunnerStartDelayMs",
      "localAgentSmokeMode",
    ]) {
      delete legacy.provider[key];
    }

    const parsed = parseAgentDeploymentChoices(legacy);
    if (!parsed) throw new Error("Legacy deployment choices did not parse.");
    expect(parsed?.provider).toMatchObject({
      runnerBootContractVersion: "bruno.runner.boot.v1",
      sshKeyIds: [],
      sshSourceAddresses: [],
      localRunnerEndpointUrl: null,
      localRunnerContainerName: null,
      localRunnerStartDelayMs: null,
      localAgentSmokeMode: false,
    });
    expect(
      applyAgentDeploymentChoices(
        {
          ...providerConfig({ token: "current-secret", sizeSlug: "s-2vcpu-2gb" }),
          sshKeyIds: ["mutable-current-key"],
          sshSourceAddresses: ["198.51.100.0/24"],
        },
        parsed,
      ),
    ).toMatchObject({ sshKeyIds: [], sshSourceAddresses: [] });
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
    sshKeyIds: ["accepted-key"],
    sshSourceAddresses: ["203.0.113.0/24"],
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

function localProviderConfig(input: {
  endpointUrl: string;
  containerName: string;
}): DigitalOceanProviderConfig {
  return {
    token:
      input.containerName === "accepted-runner" ? "accepted-local-secret" : "current-local-secret",
    providerMode: "local_docker",
    runnerBearerToken:
      input.containerName === "accepted-runner"
        ? "accepted-runner-secret"
        : "current-runner-secret",
    runnerImage: "bruno-runner:local",
    region: "local",
    sizeSlug: "s-1vcpu-2gb",
    image: "local-image",
    tags: ["bruno-local"],
    sshSourceAddresses: [],
    localRunnerEndpointUrl: input.endpointUrl,
    localRunnerContainerName: input.containerName,
    localRunnerStartDelayMs: 250,
    localAgentSmokeMode: true,
  };
}
