import { describe, expect, it } from "vitest";
import { bootstrapRegisteredRunner } from "@/src/runner-service/bootstrap";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";

const RELEASE_EVIDENCE = {
  release: {
    version: "0123456789abcdef",
    imageDigest: `sha256:${"a".repeat(64)}`,
    bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
  },
  expectedMatch: true,
} as const;

describe("runner service bootstrap registration", () => {
  it("exchanges the one-time registration token and reports online through the heartbeat endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await bootstrapRegisteredRunner({
      releaseEvidence: RELEASE_EVIDENCE,
      env: {
        BRUNO_APP_URL: "https://app.bruno.test",
        BRUNO_RUNNER_REGISTRATION_TOKEN: "bruno_reg_1234567890123456789012345678901234567890123",
        BRUNO_RUNNER_ENDPOINT_URL: "https://runner.bruno.test",
        BRUNO_RUNNER_NAME: "Cloud Runner 1",
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        if (String(url).endsWith("/runner/v1/register")) {
          return Response.json(
            {
              ok: true,
              runner: { id: "00000000-0000-4000-8000-000000000153" },
              credential: {
                token: "bruno_run_1234567890123456789012345678901234567890123",
                prefix: "bruno_run_12345678",
              },
            },
            { status: 201 },
          );
        }

        if (String(url).endsWith("/runner/v1/heartbeat")) {
          return Response.json({ ok: true }, { status: 200 });
        }

        return Response.json({ ok: false }, { status: 404 });
      },
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://app.bruno.test/runner/v1/register",
      init: {
        method: "POST",
      },
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      endpointUrl: "https://runner.bruno.test",
      name: "Cloud Runner 1",
    });
    expect(calls[1]).toMatchObject({
      url: "https://app.bruno.test/runner/v1/heartbeat",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer bruno_run_1234567890123456789012345678901234567890123",
          "content-type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
      release: RELEASE_EVIDENCE.release,
    });
  });

  it("persists exchanged runner credentials for restart-safe bootstrap", async () => {
    const writes: Array<{ path: string; content: string; mode: number }> = [];
    const result = await bootstrapRegisteredRunner({
      releaseEvidence: RELEASE_EVIDENCE,
      env: {
        BRUNO_APP_URL: "https://app.bruno.test",
        BRUNO_RUNNER_REGISTRATION_TOKEN: "bruno_reg_1234567890123456789012345678901234567890123",
        BRUNO_RUNNER_ENDPOINT_URL: "https://runner.bruno.test",
        BRUNO_RUNNER_NAME: "Cloud Runner 1",
        BRUNO_RUNNER_ENV_FILE: "/etc/bruno/runner.env",
        BRUNO_DOCKER_RUNNER_IMAGE: "ghcr.io/ametel01/bruno-agent:main",
        BRUNO_RUNNER_EXPECTED_RELEASE_VERSION: RELEASE_EVIDENCE.release.version,
        BRUNO_RUNNER_EXPECTED_IMAGE_DIGEST: RELEASE_EVIDENCE.release.imageDigest,
        BRUNO_RUNNER_EXPECTED_BOOT_CONTRACT_VERSION: RELEASE_EVIDENCE.release.bootContractVersion,
        BRUNO_RUNNER_BOOT_MODEL_CANARY_ENABLED: "false",
        BRUNO_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      },
      fetch: async (url) => {
        if (String(url).endsWith("/runner/v1/register")) {
          return Response.json(
            {
              ok: true,
              runner: { id: "00000000-0000-4000-8000-000000000153" },
              credential: {
                token: "bruno_run_1234567890123456789012345678901234567890123",
                prefix: "bruno_run_12345678",
              },
            },
            { status: 201 },
          );
        }

        return Response.json({ ok: true }, { status: 200 });
      },
      writeEnvFile: async (path: string, content: string, options: { mode: number }) => {
        writes.push({ path, content, mode: options.mode });
      },
    } as Parameters<typeof bootstrapRegisteredRunner>[0] & {
      writeEnvFile: (path: string, content: string, options: { mode: number }) => Promise<void>;
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
    });
    expect(writes).toEqual([
      {
        path: "/etc/bruno/runner.env",
        mode: 0o600,
        content: expect.stringContaining('BRUNO_RUNNER_ID="00000000-0000-4000-8000-000000000153"'),
      },
    ]);
    expect(writes[0]?.content).toContain(
      'BRUNO_RUNNER_CREDENTIAL="bruno_run_1234567890123456789012345678901234567890123"',
    );
    expect(writes[0]?.content).toContain(
      'BRUNO_DOCKER_RUNNER_IMAGE="ghcr.io/ametel01/bruno-agent:main"',
    );
    expect(writes[0]?.content).toContain(
      `BRUNO_RUNNER_EXPECTED_RELEASE_VERSION="${RELEASE_EVIDENCE.release.version}"`,
    );
    expect(writes[0]?.content).toContain(
      `BRUNO_RUNNER_EXPECTED_IMAGE_DIGEST="${RELEASE_EVIDENCE.release.imageDigest}"`,
    );
    expect(writes[0]?.content).toContain(
      'BRUNO_LOCAL_AGENT_SMOKE_MODE="synthetic-external-boundaries"',
    );
    expect(writes[0]?.content).toContain('BRUNO_RUNNER_BOOT_MODEL_CANARY_ENABLED="false"');
    expect(writes[0]?.content).not.toContain("BRUNO_RUNNER_REGISTRATION_TOKEN");
  });

  it("uses existing runner credentials when already registered", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await bootstrapRegisteredRunner({
      releaseEvidence: RELEASE_EVIDENCE,
      env: {
        BRUNO_APP_URL: "https://app.bruno.test/",
        BRUNO_RUNNER_ENDPOINT_URL: "https://runner.bruno.test",
        BRUNO_RUNNER_ID: "00000000-0000-4000-8000-000000000154",
        BRUNO_RUNNER_CREDENTIAL: "bruno_run_existing",
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ ok: true }, { status: 200 });
      },
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000154",
      status: "online",
    });
    expect(calls.map((call) => call.url)).toEqual(["https://app.bruno.test/runner/v1/heartbeat"]);
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer bruno_run_existing",
      "content-type": "application/json",
    });
  });

  it("fails closed without bootstrap registration or credential environment", async () => {
    const result = await bootstrapRegisteredRunner({
      env: {
        BRUNO_APP_URL: "https://app.bruno.test",
        BRUNO_RUNNER_ENDPOINT_URL: "https://runner.bruno.test",
      },
      fetch: async () => Response.json({ ok: false }, { status: 500 }),
    });

    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });

  it("reports degraded observed identity without trusting mismatched expected values", async () => {
    const heartbeatBodies: unknown[] = [];
    const result = await bootstrapRegisteredRunner({
      releaseEvidence: { ...RELEASE_EVIDENCE, expectedMatch: false },
      env: {
        BRUNO_APP_URL: "https://app.bruno.test",
        BRUNO_RUNNER_ENDPOINT_URL: "https://runner.bruno.test",
        BRUNO_RUNNER_ID: "00000000-0000-4000-8000-000000000154",
        BRUNO_RUNNER_CREDENTIAL: "bruno_run_existing",
      },
      fetch: async (_url, init) => {
        heartbeatBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ok: true });
      },
    });

    expect(result).toMatchObject({ ok: true, status: "degraded" });
    expect(heartbeatBodies).toEqual([
      expect.objectContaining({ status: "degraded", release: RELEASE_EVIDENCE.release }),
    ]);
  });
});
