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
const LOCAL_VALID_ENV = {
  ...VALID_ENV,
  NEXT_PUBLIC_APP_URL: "http://host.docker.internal:3000",
  AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
  AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
  AGENTBAY_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION: undefined,
};
const DIGITALOCEAN_ARGS = ["--image", IMAGE, "--provider", "digitalocean"] as const;
const LOCAL_DOCKER_ARGS = ["--image", IMAGE, "--provider", "local_docker"] as const;

const EVIDENCE: RunnerReleaseSmokeEvidence = {
  providerMode: "digitalocean",
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
      ["--image", "ghcr.io/ametel01/agentbay-runner:main", "--provider", "digitalocean"],
      VALID_ENV,
    );
    expect(mutable).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(mutable.ok ? [] : mutable.capabilities).toContainEqual({
      name: "immutable_image",
      envName: "--image",
      state: "malformed",
    });

    const unavailable = planRunnerReleaseSmoke(DIGITALOCEAN_ARGS, {});
    expect(unavailable).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(JSON.stringify(unavailable)).not.toContain("postgres://");
  });

  it("accepts only the Git-SHA plus digest release contract", () => {
    expect(planRunnerReleaseSmoke(DIGITALOCEAN_ARGS, VALID_ENV)).toEqual({
      ok: true,
      image: IMAGE,
      providerMode: "digitalocean",
      release: { version: SHA, imageDigest: DIGEST },
    });
  });

  it("accepts the isolated local-Docker provider without billable authorization", () => {
    expect(planRunnerReleaseSmoke(LOCAL_DOCKER_ARGS, LOCAL_VALID_ENV)).toEqual({
      ok: true,
      image: IMAGE,
      providerMode: "local_docker",
      release: { version: SHA, imageDigest: DIGEST },
    });

    const withCloudToken = planRunnerReleaseSmoke(LOCAL_DOCKER_ARGS, {
      ...LOCAL_VALID_ENV,
      AGENTBAY_DIGITALOCEAN_TOKEN: "looks-like-a-real-cloud-token",
    });
    expect(withCloudToken).toMatchObject({ ok: false, code: "capability_unavailable" });
    expect(withCloudToken.ok ? [] : withCloudToken.capabilities).toContainEqual({
      name: "local_docker_isolation",
      envName: "AGENTBAY_DIGITALOCEAN_TOKEN",
      state: "malformed",
    });

    const hostedWithLocalUrl = planRunnerReleaseSmoke(DIGITALOCEAN_ARGS, {
      ...VALID_ENV,
      NEXT_PUBLIC_APP_URL: "http://host.docker.internal:3000",
    });
    expect(hostedWithLocalUrl).toMatchObject({ ok: false, code: "capability_unavailable" });
  });

  it("binds the CLI image to the provider session environment", async () => {
    let sessionEnv: Record<string, string | undefined> | undefined;

    await smokeRunnerRelease(DIGITALOCEAN_ARGS, VALID_ENV, {
      createSession: (_plan, env) => {
        sessionEnv = env;
        return session([]);
      },
    });

    expect(sessionEnv?.AGENTBAY_RUNNER_IMAGE).toBe(IMAGE);
  });

  it("always cleans and verifies exact absence after a passing smoke", async () => {
    const calls: string[] = [];
    const result = await smokeRunnerRelease(DIGITALOCEAN_ARGS, VALID_ENV, {
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
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await smokeRunnerRelease(DIGITALOCEAN_ARGS, VALID_ENV, {
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
    expect(JSON.stringify(error.mock.calls)).not.toMatch(/cloud-init|credential/i);
    expect(error).toHaveBeenCalledWith("[agentbay] runner.release_smoke", {
      event: "run_failed",
      errorName: "Error",
      errorCode: null,
      causeName: null,
      causeCode: null,
    });
    expect(calls).toEqual(["run", "cleanup", "verifyCleanup"]);
    error.mockRestore();
  });

  it("blocks promotion when cleanup cannot be verified", async () => {
    const calls: string[] = [];
    const result = await smokeRunnerRelease(DIGITALOCEAN_ARGS, VALID_ENV, {
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
      DIGITALOCEAN_ARGS,
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
    expect(smokeSource).toContain(
      'allowInsecureLoopback: input.config.providerMode === "local_docker"',
    );
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
