import { describe, expect, it } from "vitest";
import {
  parseRunnerBootSnapshot,
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";
import { runnerBootSnapshotMatchesRequirement } from "@/src/server/runners/runner-heartbeat";

const timestamps = {
  startedAt: "2026-08-11T00:00:00.000Z",
  completedAt: "2026-08-11T00:00:01.000Z",
};

describe("runner boot readiness contract", () => {
  it("keeps current-machine observations separate from historical attestations", () => {
    const snapshot = {
      ok: true,
      contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
      validationMode: "release_attested",
      status: "ready",
      observedChecks: {
        docker: "passed",
        requiredServices: "passed",
        injectedBundleDigests: "passed",
        preloadedImages: "passed",
        hermesFixture: "not_applicable",
        detailedHealth: "not_applicable",
        modelCanary: "not_applicable",
        telegramConfig: "not_applicable",
        cleanup: "passed",
      },
      attestedChecks: {
        fullFixture: "verified",
        detailedHealth: "verified",
        modelCanary: "verified",
        telegramConfig: "verified",
        cleanup: "verified",
      },
      evidence: {
        releaseBundleDigest: `sha256:${"a".repeat(64)}`,
        snapshotBundleDigest: `sha256:${"b".repeat(64)}`,
        snapshotImageId: "1102",
      },
      failureReason: null,
      ...timestamps,
    };

    expect(parseRunnerBootSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseRunnerBootSnapshot({
        ...snapshot,
        observedChecks: { ...snapshot.observedChecks, detailedHealth: "verified" },
      }),
    ).toBeNull();
    expect(
      parseRunnerBootSnapshot({
        ...snapshot,
        attestedChecks: { ...snapshot.attestedChecks, detailedHealth: "passed" },
      }),
    ).toBeNull();
  });

  it("requires the full fixture and no attested evidence in full mode", () => {
    const snapshot = {
      ok: true,
      contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
      validationMode: "full",
      status: "ready",
      observedChecks: {
        docker: "passed",
        requiredServices: "not_applicable",
        injectedBundleDigests: "not_applicable",
        preloadedImages: "not_applicable",
        hermesFixture: "passed",
        detailedHealth: "passed",
        modelCanary: "passed",
        telegramConfig: "passed",
        cleanup: "passed",
      },
      attestedChecks: {
        fullFixture: "not_applicable",
        detailedHealth: "not_applicable",
        modelCanary: "not_applicable",
        telegramConfig: "not_applicable",
        cleanup: "not_applicable",
      },
      evidence: null,
      failureReason: null,
      ...timestamps,
    };

    expect(parseRunnerBootSnapshot(snapshot)).toEqual(snapshot);
    expect(
      parseRunnerBootSnapshot({
        ...snapshot,
        observedChecks: { ...snapshot.observedChecks, hermesFixture: "not_applicable" },
      }),
    ).toBeNull();
  });

  it("admits only the exact configured release and snapshot evidence", () => {
    const releaseSnapshot = parseRunnerBootSnapshot({
      ok: true,
      contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
      validationMode: "release_attested",
      status: "ready",
      observedChecks: {
        docker: "passed",
        requiredServices: "passed",
        injectedBundleDigests: "passed",
        preloadedImages: "passed",
        hermesFixture: "not_applicable",
        detailedHealth: "not_applicable",
        modelCanary: "not_applicable",
        telegramConfig: "not_applicable",
        cleanup: "passed",
      },
      attestedChecks: {
        fullFixture: "verified",
        detailedHealth: "verified",
        modelCanary: "verified",
        telegramConfig: "verified",
        cleanup: "verified",
      },
      evidence: {
        releaseBundleDigest: `sha256:${"a".repeat(64)}`,
        snapshotBundleDigest: `sha256:${"b".repeat(64)}`,
        snapshotImageId: "1102",
      },
      failureReason: null,
      ...timestamps,
    });
    expect(releaseSnapshot).not.toBeNull();
    if (!releaseSnapshot) return;

    expect(
      runnerBootSnapshotMatchesRequirement(releaseSnapshot, {
        mode: "release_attested",
        releaseBundleDigest: `sha256:${"a".repeat(64)}`,
        snapshotBundleDigest: `sha256:${"b".repeat(64)}`,
        snapshotImageId: "1102",
      }),
    ).toBe(true);
    expect(
      runnerBootSnapshotMatchesRequirement(releaseSnapshot, {
        mode: "release_attested",
        releaseBundleDigest: `sha256:${"c".repeat(64)}`,
        snapshotBundleDigest: `sha256:${"b".repeat(64)}`,
        snapshotImageId: "1102",
      }),
    ).toBe(false);
    expect(runnerBootSnapshotMatchesRequirement(releaseSnapshot, { mode: "full" })).toBe(false);
  });
});
