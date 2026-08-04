import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  planRunnerReleaseSmoke,
  RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION,
  type RunnerReleaseSmokeEvidence,
  type RunnerReleaseSmokeSession,
  smokeRunnerRelease,
} from "@/scripts/smoke-runner-release";

const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `ghcr.io/ametel01/agentbay-runner:${SHA}@${DIGEST}`;
const VALID_ENV = {
  DATABASE_URL: "postgres://release.invalid/plingpling",
  NEXT_PUBLIC_APP_URL: "https://plingpling.example",
  AGENTBAY_DIGITALOCEAN_TOKEN: "release-provider-token",
  AGENTBAY_RUNNER_BEARER_TOKEN: "r".repeat(40),
  AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
  AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "disabled",
  AGENTBAY_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION: RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION,
};

const EVIDENCE: RunnerReleaseSmokeEvidence = {
  releaseVersion: SHA,
  imageDigest: DIGEST,
  bootContractVersion: "plingpling.runner.boot.v1",
  bootComponents: ["docker", "hermes_fixture", "config_load", "health", "model_canary", "cleanup"],
  syntheticActions: ["start", "status", "canary", "stop"],
};
const smokeSource = readFileSync(
  new URL("../../scripts/smoke-runner-release.ts", import.meta.url),
  "utf8",
);

describe("runner release smoke", () => {
  it("fails closed on usage, mutable images, and missing capabilities before effects", () => {
    expect(planRunnerReleaseSmoke([], {})).toMatchObject({
      ok: false,
      code: "usage_invalid",
    });

    const mutable = planRunnerReleaseSmoke(
      ["--image", "ghcr.io/ametel01/agentbay-runner:main"],
      VALID_ENV,
    );
    expect(mutable).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(mutable.ok ? [] : mutable.capabilities).toContainEqual({
      name: "immutable_image",
      envName: "--image",
      state: "malformed",
    });

    const unavailable = planRunnerReleaseSmoke(["--image", IMAGE], {});
    expect(unavailable).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("postgres://");
  });

  it("accepts only the Git-SHA plus digest release contract", () => {
    expect(planRunnerReleaseSmoke(["--image", IMAGE], VALID_ENV)).toEqual({
      ok: true,
      image: IMAGE,
      release: { version: SHA, imageDigest: DIGEST },
    });
  });

  it("always cleans and verifies exact absence after a passing smoke", async () => {
    const calls: string[] = [];
    const result = await smokeRunnerRelease(["--image", IMAGE], VALID_ENV, {
      createSession: () => session(calls),
    });

    expect(result).toEqual({
      ok: true,
      code: "passed",
      sideEffectsAttempted: true,
      cleanupVerified: true,
      evidence: EVIDENCE,
    });
    expect(calls).toEqual(["run", "cleanup", "verifyCleanup"]);
  });

  it("runs cleanup after smoke failure and preserves a closed result", async () => {
    const calls: string[] = [];
    const result = await smokeRunnerRelease(["--image", IMAGE], VALID_ENV, {
      createSession: () =>
        session(calls, {
          run: async () => {
            calls.push("run");
            throw new Error("private cloud-init and credential output");
          },
        }),
    });

    expect(result).toEqual({
      ok: false,
      code: "smoke_failed",
      sideEffectsAttempted: true,
      cleanupVerified: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/cloud-init|credential/i);
    expect(calls).toEqual(["run", "cleanup", "verifyCleanup"]);
  });

  it("blocks promotion when cleanup cannot be verified", async () => {
    const calls: string[] = [];
    const result = await smokeRunnerRelease(["--image", IMAGE], VALID_ENV, {
      createSession: () => session(calls, { verifyCleanup: async () => false }),
    });

    expect(result).toEqual({
      ok: false,
      code: "cleanup_failed",
      sideEffectsAttempted: true,
      cleanupVerified: false,
    });
  });

  it("does not create a session when authorization is absent", async () => {
    const createSession = vi.fn();
    const result = await smokeRunnerRelease(
      ["--image", IMAGE],
      {
        ...VALID_ENV,
        AGENTBAY_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION: undefined,
      },
      { createSession },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "capability_unavailable",
      sideEffectsAttempted: false,
    });
    expect(createSession).not.toHaveBeenCalled();
  });

  it("keeps exact provider cleanup ordered and independently verifies absence", () => {
    const firewallDelete = smokeSource.indexOf("ownedProvider.deleteFirewall");
    const dropletDelete = smokeSource.indexOf("ownedProvider.deleteDroplet");

    expect(firewallDelete).toBeGreaterThan(-1);
    expect(dropletDelete).toBeGreaterThan(firewallDelete);
    expect(smokeSource).toContain("discoverResourcesByTag({ tag: operationKey })");
    expect(smokeSource).toContain("discovered.value.resources.length === 0");
    expect(smokeSource).toContain("runnerCredentials");
    expect(smokeSource).toContain('status: "revoked"');
    expect(smokeSource).toContain('status: "deleted"');
  });
});

function session(
  calls: string[],
  overrides: Partial<RunnerReleaseSmokeSession> = {},
): RunnerReleaseSmokeSession {
  return {
    run: async () => {
      calls.push("run");
      return EVIDENCE;
    },
    cleanup: async () => {
      calls.push("cleanup");
    },
    verifyCleanup: async () => {
      calls.push("verifyCleanup");
      return true;
    },
    ...overrides,
  };
}
