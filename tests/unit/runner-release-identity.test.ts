import { describe, expect, it } from "vitest";
import {
  RUNNER_BOOT_CONTRACT_VERSION,
  RUNNER_OCI_REVISION_LABEL,
  RUNNER_OCI_VERSION_LABEL,
} from "@/src/runner-service/constants";
import {
  parseImmutableRunnerImageReference,
  parseRunnerReleaseIdentity,
  resolveRunnerReleaseEvidence,
  RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV,
  RUNNER_EXPECTED_IMAGE_DIGEST_ENV,
  RUNNER_EXPECTED_RELEASE_VERSION_ENV,
  type RunnerReleaseIdentityError,
  RUNNER_RELEASE_DEVELOPMENT_MODE,
  RUNNER_RELEASE_IDENTITY_MODE_ENV,
  type RunnerReleaseDocker,
} from "@/src/runner-service/release-identity";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const OBSERVED_DIGEST = `sha256:${"b".repeat(64)}`;
const EXPECTED_DIGEST = `sha256:${"c".repeat(64)}`;

describe("runner release identity", () => {
  it("derives observed identity from Docker and uses expected values only for comparison", async () => {
    const calls: string[][] = [];
    const docker = fakeDocker(calls, {
      repoDigests: [
        `ghcr.io/ametel01/agentbay-runner@${OBSERVED_DIGEST}`,
        `mirror.example/runner@${OBSERVED_DIGEST}`,
      ],
      labels: {
        [RUNNER_OCI_VERSION_LABEL]: "0123456789abcdef",
        [RUNNER_OCI_REVISION_LABEL]: "0123456789abcdef",
        "registry.password": "must-not-surface",
      },
    });

    const result = await resolveRunnerReleaseEvidence({
      containerIdentity: "runner-container-id",
      docker,
      env: {
        [RUNNER_EXPECTED_RELEASE_VERSION_ENV]: "fedcba9876543210",
        [RUNNER_EXPECTED_IMAGE_DIGEST_ENV]: EXPECTED_DIGEST,
        [RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV]: RUNNER_BOOT_CONTRACT_VERSION,
      },
    });

    expect(result).toEqual({
      release: {
        version: "0123456789abcdef",
        imageDigest: OBSERVED_DIGEST,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
      expectedMatch: false,
    });
    expect(calls).toEqual([
      [
        "inspect",
        "--type",
        "container",
        "--format",
        '{"imageId":{{json .Image}}}',
        "runner-container-id",
      ],
      [
        "image",
        "inspect",
        "--format",
        '{"imageId":{{json .Id}},"repoDigests":{{json .RepoDigests}},"labels":{{json .Config.Labels}}}',
        IMAGE_ID,
      ],
    ]);
    expect(JSON.stringify(result)).not.toContain("must-not-surface");
    expect(JSON.stringify(calls)).not.toContain(EXPECTED_DIGEST);
  });

  it("accepts one exact matching expected identity", async () => {
    const docker = fakeDocker([], {
      repoDigests: [`ghcr.io/ametel01/agentbay-runner@${OBSERVED_DIGEST}`],
      labels: { [RUNNER_OCI_REVISION_LABEL]: "release-sha" },
    });

    await expect(
      resolveRunnerReleaseEvidence({
        containerIdentity: "runner-container-id",
        docker,
        env: {
          [RUNNER_EXPECTED_RELEASE_VERSION_ENV]: "release-sha",
          [RUNNER_EXPECTED_IMAGE_DIGEST_ENV]: OBSERVED_DIGEST,
          [RUNNER_EXPECTED_BOOT_CONTRACT_VERSION_ENV]: RUNNER_BOOT_CONTRACT_VERSION,
        },
      }),
    ).resolves.toMatchObject({ expectedMatch: true });
  });

  it("requires a registry digest outside the explicit development seam", async () => {
    const docker = fakeDocker([], {
      repoDigests: [],
      labels: { [RUNNER_OCI_VERSION_LABEL]: "development" },
    });

    await expect(
      resolveRunnerReleaseEvidence({ containerIdentity: "runner", docker, env: {} }),
    ).rejects.toMatchObject({
      reason: "observed_digest_missing",
    } satisfies Partial<RunnerReleaseIdentityError>);
    await expect(
      resolveRunnerReleaseEvidence({
        containerIdentity: "runner",
        docker,
        env: { [RUNNER_RELEASE_IDENTITY_MODE_ENV]: RUNNER_RELEASE_DEVELOPMENT_MODE },
      }),
    ).resolves.toEqual({
      release: {
        version: "development",
        imageDigest: IMAGE_ID,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
      expectedMatch: null,
    });
  });

  it("parses only canonical immutable references and bounded release fields", () => {
    expect(
      parseImmutableRunnerImageReference(
        `ghcr.io/ametel01/agentbay-runner:0123456789abcdef@${OBSERVED_DIGEST}`,
      ),
    ).toEqual({
      imageReference: `ghcr.io/ametel01/agentbay-runner:0123456789abcdef@${OBSERVED_DIGEST}`,
      imageDigest: OBSERVED_DIGEST,
      version: "0123456789abcdef",
    });
    expect(
      parseImmutableRunnerImageReference(`ghcr.io/ametel01/agentbay-runner@${OBSERVED_DIGEST}`),
    ).toMatchObject({ imageDigest: OBSERVED_DIGEST, version: "b".repeat(64) });

    for (const image of [
      "ghcr.io/ametel01/agentbay-runner:main",
      `docker.io/Runner/Image@${OBSERVED_DIGEST}`,
      `ghcr.io/ametel01/agentbay-runner@sha256:${"A".repeat(64)}`,
      "ghcr.io/ametel01/agentbay-runner@sha256:short",
    ]) {
      expect(parseImmutableRunnerImageReference(image)).toBeNull();
    }

    expect(
      parseRunnerReleaseIdentity({
        version: "release-1",
        imageDigest: OBSERVED_DIGEST,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
        credential: "ignored",
      }),
    ).toEqual({
      version: "release-1",
      imageDigest: OBSERVED_DIGEST,
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    });
    expect(
      parseRunnerReleaseIdentity({
        version: " release-1 ",
        imageDigest: OBSERVED_DIGEST,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      }),
    ).toBeNull();
  });
});

function fakeDocker(
  calls: string[][],
  image: { repoDigests: string[]; labels: Record<string, string> },
): RunnerReleaseDocker {
  return async (args) => {
    calls.push([...args]);

    if (args[0] === "inspect") {
      return { stdout: JSON.stringify({ imageId: IMAGE_ID }), stderr: "" };
    }

    if (args[0] === "image" && args[1] === "inspect") {
      return {
        stdout: JSON.stringify({
          imageId: IMAGE_ID,
          repoDigests: image.repoDigests,
          labels: image.labels,
        }),
        stderr: "",
      };
    }

    throw new Error("unexpected Docker call");
  };
}
