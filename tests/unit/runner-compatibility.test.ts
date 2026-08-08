import { describe, expect, it } from "vitest";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import {
  assessRunnerCompatibility,
  readRunnerCompatibilityRequirement,
  requiredRunnerImageDigestForProvider,
} from "@/src/server/runners/runner-compatibility";

const IMAGE_DIGEST = `sha256:${"a".repeat(64)}`;
const OLD_IMAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const IMMUTABLE_IMAGE = `ghcr.io/ametel01/bruno-runner:sha-current@${IMAGE_DIGEST}`;
const NOW = new Date("2026-08-04T00:00:00.000Z");
const RELEASE = {
  version: "sha-current",
  imageDigest: IMAGE_DIGEST,
  bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
};

describe("runner release compatibility policy", () => {
  it("derives a hosted requirement only from an immutable image reference", () => {
    expect(readRunnerCompatibilityRequirement({ BRUNO_RUNNER_IMAGE: IMMUTABLE_IMAGE })).toEqual({
      mode: "hosted",
      release: RELEASE,
    });
    expect(
      readRunnerCompatibilityRequirement({
        BRUNO_RUNNER_IMAGE: "ghcr.io/ametel01/bruno-runner:main",
      }),
    ).toEqual({ mode: "unavailable", release: null });
    expect(requiredRunnerImageDigestForProvider({ runnerImage: IMMUTABLE_IMAGE })).toBe(
      IMAGE_DIGEST,
    );
  });

  it("accepts only an exact hosted release and reports safe mismatch reasons", () => {
    const requirement = readRunnerCompatibilityRequirement({
      BRUNO_RUNNER_IMAGE: IMMUTABLE_IMAGE,
    });

    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: IMAGE_DIGEST,
        observedRelease: RELEASE,
        requirement,
        now: NOW,
      }),
    ).toEqual({
      state: "compatible",
      reason: "compatible",
      requiredImageDigest: IMAGE_DIGEST,
      observedRelease: RELEASE,
      verifiedAt: NOW,
    });

    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: OLD_IMAGE_DIGEST,
        observedRelease: { ...RELEASE, imageDigest: OLD_IMAGE_DIGEST },
        requirement,
        now: NOW,
      }),
    ).toMatchObject({ state: "outdated", reason: "required_release_changed" });

    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: IMAGE_DIGEST,
        observedRelease: null,
        requirement,
        now: NOW,
      }),
    ).toMatchObject({ state: "unknown", reason: "release_evidence_missing" });
  });

  it("fails hosted managed runners closed when the required release is unavailable", () => {
    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: null,
        observedRelease: RELEASE,
        requirement: { mode: "unavailable", release: null },
        now: NOW,
      }),
    ).toMatchObject({ state: "invalid", reason: "required_release_unavailable" });
  });

  it("adopts local Docker evidence but rejects an obsolete boot contract", () => {
    const requirement = { mode: "local_docker", release: null } as const;

    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: null,
        observedRelease: RELEASE,
        requirement,
        now: NOW,
      }),
    ).toMatchObject({
      state: "compatible",
      requiredImageDigest: IMAGE_DIGEST,
    });

    expect(
      assessRunnerCompatibility({
        kind: "digitalocean",
        provider: "digitalocean",
        requiredImageDigest: null,
        observedRelease: { ...RELEASE, bootContractVersion: "bruno.runner.boot.v0" },
        requirement,
        now: NOW,
      }),
    ).toMatchObject({ state: "outdated", reason: "boot_contract_mismatch" });
  });

  it("keeps legacy manual runners unknown and marks explicit incompatible evidence outdated", () => {
    expect(
      assessRunnerCompatibility({
        kind: "manual_vps",
        provider: null,
        requiredImageDigest: null,
        observedRelease: null,
        requirement: { mode: "unavailable", release: null },
        now: NOW,
      }),
    ).toMatchObject({ state: "unknown", reason: "release_evidence_missing" });

    expect(
      assessRunnerCompatibility({
        kind: "manual_vps",
        provider: null,
        requiredImageDigest: null,
        observedRelease: { ...RELEASE, bootContractVersion: "bruno.runner.boot.v0" },
        requirement: { mode: "unavailable", release: null },
        now: NOW,
      }),
    ).toMatchObject({ state: "outdated", reason: "boot_contract_mismatch" });
  });
});
