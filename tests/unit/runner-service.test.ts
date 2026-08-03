import { access, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTBAY_AGENT_ID_LABEL,
  createHermesReadinessWaiter,
  evaluateHermesReadyResponse,
  isHermesReadyResponse,
  ManualRunnerDocker,
  type DockerExecutableRunner,
  type HermesReadinessReason,
} from "@/src/runner-service/docker";
import { createRunnerService } from "@/src/runner-service/server";
import { sampleLaunchSpec } from "@/tests/helpers/agent-launch-spec";

const AGENT_ID = "00000000-0000-4000-8000-000000000123";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000456";

describe("manual runner service HTTP contract", () => {
  it("requires bearer auth and returns safe JSON failures", async () => {
    const service = createTestService();
    const response = await service.fetch(
      new Request(`http://runner.test/runner/v1/agents/${AGENT_ID}/status`),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "unauthorized",
        message: "Unauthorized.",
      },
    });
  });

  it("exposes authenticated readiness without invoking Docker", async () => {
    const calls: string[][] = [];
    const service = createTestService({ docker: createMockDocker({ calls }) });

    const unauthorized = await service.fetch(new Request("http://runner.test/runner/v1/readiness"));
    const ready = await service.fetch(authorizedRequest("/runner/v1/readiness"));
    const wrongMethod = await service.fetch(authorizedRequest("/runner/v1/readiness", "POST"));

    expect(unauthorized.status).toBe(401);
    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toEqual({ ok: true, status: "ready" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET");
    expect(calls).toEqual([]);
  });

  it("starts a continuous heartbeat loop when configured with runner identity", () => {
    const starts: Array<{ runnerId: string; credential: string; appBaseUrl: string }> = [];

    createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker(),
      }),
      heartbeat: {
        runnerId: "00000000-0000-4000-8000-000000000153",
        credential: "agb_run_1234567890123456789012345678901234567890123",
        appBaseUrl: "https://app.agentbay.test",
        start(input: { runnerId: string; credential: string; appBaseUrl: string }) {
          starts.push(input);
          return { stop() {} };
        },
      },
    } as Parameters<typeof createRunnerService>[0] & {
      heartbeat: {
        runnerId: string;
        credential: string;
        appBaseUrl: string;
        start(input: { runnerId: string; credential: string; appBaseUrl: string }): {
          stop(): void;
        };
      };
    });

    expect(starts).toEqual([
      {
        runnerId: "00000000-0000-4000-8000-000000000153",
        credential: "agb_run_1234567890123456789012345678901234567890123",
        appBaseUrl: "https://app.agentbay.test",
      },
    ]);
  });

  it("sends startup heartbeat payloads with capacity metrics without requiring Docker calls", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker(),
      }),
      heartbeat: {
        runnerId: "00000000-0000-4000-8000-000000000153",
        credential: "agb_run_1234567890123456789012345678901234567890123",
        appBaseUrl: "https://app.agentbay.test/",
        intervalMs: 60_000,
        maxAgents: 5,
        fetch: async (url, init) => {
          requests.push({ url: String(url), init: init ?? {} });
          return Response.json({ ok: true });
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    service.heartbeatLoop?.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://app.agentbay.test/runner/v1/heartbeat",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer agb_run_1234567890123456789012345678901234567890123",
          "content-type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
      version: "agentbay-runner/service",
      metrics: {
        maxAgents: 5,
        runningAgents: 0,
      },
    });
  });

  it("rejects invalid agent IDs before invoking Docker", async () => {
    const calls: string[][] = [];
    const service = createTestService({ docker: createMockDocker({ calls }) });
    const response = await service.fetch(authorizedRequest("/runner/v1/agents/not-a-uuid/status"));

    expect(response.status).toBe(400);
    expect(calls).toEqual([]);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "invalid_agent_id",
      },
    });
  });

  it("exposes start/status/logs over the local fetch handler with mocked Docker", async () => {
    const calls: string[][] = [];
    const service = createTestService({ docker: createMockDocker({ calls }) });

    const start = await service.fetch(
      authorizedRequest(`/runner/v1/agents/${AGENT_ID}/start`, "POST"),
    );
    const status = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`));
    const logs = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/logs`));

    expect(start.status).toBe(200);
    expect(await start.json()).toMatchObject({
      ok: true,
      agentId: AGENT_ID,
      action: "start",
      container: {
        id: "container-001",
        status: "running",
      },
    });
    expect(await status.json()).toMatchObject({
      ok: true,
      containers: [{ id: "container-001", status: "running" }],
    });
    expect(await logs.json()).toMatchObject({
      ok: true,
      container: { id: "container-001" },
      logs: [
        { stream: "stdout", message: "ready" },
        { stream: "stderr", message: "warn" },
      ],
    });
    expect(calls).toContainEqual([
      "run",
      "--detach",
      "--name",
      expect.stringContaining(`agentbay-runner-${AGENT_ID}`),
      "--label",
      `${AGENTBAY_AGENT_ID_LABEL}=${AGENT_ID}`,
      "--env",
      `AGENTBAY_AGENT_ID=${AGENT_ID}`,
      "agentbay/runner:test",
      "agentbay-runner",
      "--serve",
    ]);
  });

  it("validates and projects launch specs for start before Docker runs", async () => {
    const calls: string[][] = [];
    const projected: string[] = [];
    const readiness: Array<{
      apiServerKey: string;
      configRevision: string;
      containerName: string;
    }> = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls }),
        nameSuffix: () => "unit001",
        projection: {
          project: async (spec) => {
            projected.push(spec.agent.id);
            return await createHermesProjectionForTest(spec);
          },
        },
        readiness: {
          wait: async (input) => {
            readiness.push({
              apiServerKey: input.apiServerKey,
              configRevision: input.configRevision,
              containerName: input.containerName,
            });
            return { ok: true };
          },
        },
      }),
    });
    const invalid = await service.fetch(
      authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/start`, {
        ...sampleLaunchSpec(),
        version: "agentbay.hermes.launch.v0",
      }),
    );

    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "launch_spec_invalid" },
    });
    expect(calls).toEqual([]);

    const valid = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(valid.status).toBe(200);
    expect(projected).toEqual([AGENT_ID]);
    expect(readiness).toEqual([
      {
        apiServerKey: sampleLaunchSpec().secrets.apiServerKey,
        configRevision: sampleLaunchSpec().agent.configRevision,
        containerName: expect.stringContaining(`agentbay-runner-${AGENT_ID}`),
      },
    ]);
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--detach"]));
    expect(calls).toContainEqual(
      expect.arrayContaining([
        "--network",
        "agentbay-hermes",
        "--mount",
        expect.stringMatching(/^type=bind,source=.+\/hermes,target=\/opt\/data$/),
        "--mount",
        expect.stringMatching(/^type=bind,source=.+\/workspace,target=\/workspace$/),
        sampleLaunchSpec().image.ref,
        "gateway",
        "run",
      ]),
    );
    expect(calls).not.toContainEqual(expect.arrayContaining(["-p"]));
    expect(calls).not.toContainEqual(expect.arrayContaining(["--publish"]));
    expect(JSON.stringify(calls)).not.toContain(sampleLaunchSpec().secrets.apiServerKey);
  });

  it("fails closed when inspect reports a Docker socket mount for Hermes", async () => {
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ injectDockerSocket: true }),
        nameSuffix: () => "unit001",
        projection: {
          project: createHermesProjectionForTest,
        },
        readiness: {
          wait: async () => ({ ok: true }),
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "docker_command_failed" },
    });
  });

  it("returns a safe typed failure when Hermes readiness fails", async () => {
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker(),
        nameSuffix: () => "unit001",
        projection: {
          project: createHermesProjectionForTest,
        },
        readiness: {
          wait: async () => ({ ok: false, reason: "timeout" }),
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "hermes_readiness_failed",
        message: "Hermes readiness failed.",
        reason: "timeout",
      },
    });
  });

  it("removes the just-created Hermes container when readiness fails", async () => {
    const calls: string[][] = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls }),
        nameSuffix: () => "unit001",
        projection: {
          project: createHermesProjectionForTest,
        },
        readiness: {
          wait: async () => ({ ok: false, reason: "telegram_not_connected" }),
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );
    const status = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "hermes_readiness_failed",
        reason: "telegram_not_connected",
      },
    });
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      containers: [],
    });
    expect(calls).toContainEqual(["rm", "--force", "container-001"]);
  });

  it("keeps the primary readiness reason when failed-launch cleanup fails", async () => {
    const calls: string[][] = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls, failRemoveIds: ["container-001"] }),
        nameSuffix: () => "unit001",
        projection: {
          project: createHermesProjectionForTest,
        },
        readiness: {
          wait: async () => ({ ok: false, reason: "api_server_not_connected" }),
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "hermes_readiness_failed",
        message: "Hermes readiness failed.",
        reason: "api_server_not_connected",
      },
    });
    expect(calls).toContainEqual(["rm", "--force", "container-001"]);
  });

  it("keeps the primary revision reason when failed-launch cleanup fails", async () => {
    const calls: string[][] = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls, failRemoveIds: ["container-001"] }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, {
              marker: { configRevision: "wrong-revision" },
            }),
        },
        readiness: {
          wait: async () => ({ ok: true }),
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "hermes_readiness_failed",
        message: "Hermes readiness failed.",
        reason: "revision_mismatch",
      },
    });
    expect(calls).toContainEqual(["rm", "--force", "container-001"]);
  });

  it("removes a failed restart replacement without removing another agent", async () => {
    const calls: string[][] = [];
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({
        calls,
        containers: [
          { id: "old-selected", agentId: AGENT_ID, status: "running" },
          { id: "other-selected", agentId: OTHER_AGENT_ID, status: "running" },
        ],
      }),
      nameSuffix: () => "unit001",
      projection: {
        project: (spec) =>
          createHermesProjectionForTest(spec, {
            marker: { configRevision: "wrong-revision" },
          }),
      },
      readiness: {
        wait: async () => ({ ok: true }),
      },
    });

    await expect(docker.restart(AGENT_ID, sampleLaunchSpec())).rejects.toMatchObject({
      reason: "revision_mismatch",
    });
    await expect(docker.status(AGENT_ID)).resolves.toEqual({ containers: [] });
    await expect(docker.status(OTHER_AGENT_ID)).resolves.toMatchObject({
      containers: [{ id: "other-selected", status: "running" }],
    });
    expect(calls).toContainEqual(["rm", "--force", "old-selected"]);
    expect(calls).toContainEqual(["rm", "--force", "container-001"]);
    expect(calls).not.toContainEqual(["rm", "--force", "other-selected"]);
  });

  it("returns redacted durable Hermes gateway logs before bootstrap diagnostics", async () => {
    const previousStateRoot = process.env.AGENTBAY_HERMES_STATE_ROOT;
    const stateRoot = join(tmpdir(), `agentbay-runner-logs-${Date.now()}`);
    const logDir = join(stateRoot, AGENT_ID, "hermes", "logs", "gateways", "default");

    await mkdir(logDir, { recursive: true });
    await writeFile(
      join(logDir, "current.1"),
      [
        "2026-07-05T00:00:00.000Z rotated OPENROUTER_API_KEY=sk-or-v1-secret",
        "2026-07-05T00:00:01.000Z ready",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(logDir, "current"),
      [
        "2026-07-05T00:00:03.000Z telegram 123456:abcdefghijklmnopqrstuvwxyz",
        "2026-07-05T00:00:04.000Z authorization: Bearer agb_agent_secret123456789",
        "",
      ].join("\n"),
    );

    try {
      process.env.AGENTBAY_HERMES_STATE_ROOT = stateRoot;
      const service = createTestService({
        docker: createMockDocker({
          containers: [{ id: "container-001", agentId: AGENT_ID, status: "running" }],
          logs: {
            stdout:
              "2026-07-05T00:00:01.000000000Z ready\n2026-07-05T00:00:02.000000000Z bootstrap sk-or-v1-bootstrap\n",
            stderr: "",
          },
        }),
      });
      const response = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/logs`));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(JSON.stringify(body)).not.toContain("sk-or-v1-secret");
      expect(JSON.stringify(body)).not.toContain("sk-or-v1-bootstrap");
      expect(JSON.stringify(body)).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
      expect(JSON.stringify(body)).not.toContain("agb_agent_secret123456789");
      expect(body.logs).toEqual([
        expect.objectContaining({
          source: "hermes_gateway",
          message: "rotated OPENROUTER_API_KEY=[redacted-env-value]",
        }),
        expect.objectContaining({
          source: "hermes_gateway",
          message: "ready",
        }),
        expect.objectContaining({
          source: "container_bootstrap",
          message: "bootstrap [redacted-openrouter-key]",
        }),
        expect.objectContaining({
          source: "hermes_gateway",
          message: "telegram [redacted-telegram-token]",
        }),
        expect.objectContaining({
          source: "hermes_gateway",
          message: "authorization: Bearer [redacted-bearer-token]",
        }),
      ]);
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.AGENTBAY_HERMES_STATE_ROOT;
      } else {
        process.env.AGENTBAY_HERMES_STATE_ROOT = previousStateRoot;
      }
      await rm(stateRoot, { force: true, recursive: true });
    }
  });

  it("cleans selected containers and the exact Hermes agent root idempotently", async () => {
    const previousStateRoot = process.env.AGENTBAY_HERMES_STATE_ROOT;
    const stateRoot = join(tmpdir(), `agentbay-runner-cleanup-${Date.now()}`);
    const agentRoot = join(stateRoot, AGENT_ID);
    const calls: string[][] = [];

    await mkdir(join(agentRoot, "workspace"), { recursive: true });

    try {
      process.env.AGENTBAY_HERMES_STATE_ROOT = stateRoot;
      const service = createTestService({
        docker: createMockDocker({
          calls,
          containers: [{ id: "container-001", agentId: AGENT_ID, status: "running" }],
        }),
      });
      const first = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/cleanup`, "POST"),
      );
      const second = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/cleanup`, "POST"),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await expect(access(agentRoot)).rejects.toThrow();
      expect(calls).toContainEqual(["rm", "--force", "container-001"]);
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.AGENTBAY_HERMES_STATE_ROOT;
      } else {
        process.env.AGENTBAY_HERMES_STATE_ROOT = previousStateRoot;
      }
      await rm(stateRoot, { force: true, recursive: true });
    }
  });

  it("fails cleanup closed when the managed agent root is a symlink", async () => {
    const previousStateRoot = process.env.AGENTBAY_HERMES_STATE_ROOT;
    const stateRoot = join(tmpdir(), `agentbay-runner-symlink-${Date.now()}`);
    const targetRoot = join(tmpdir(), `agentbay-runner-symlink-target-${Date.now()}`);

    await mkdir(stateRoot, { recursive: true });
    await mkdir(targetRoot, { recursive: true });
    await symlink(targetRoot, join(stateRoot, AGENT_ID));

    try {
      process.env.AGENTBAY_HERMES_STATE_ROOT = stateRoot;
      const service = createTestService({ docker: createMockDocker() });
      const response = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/cleanup`, "POST"),
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "docker_command_failed" },
      });
      await expect(lstat(join(stateRoot, AGENT_ID))).resolves.toMatchObject({});
    } finally {
      if (previousStateRoot === undefined) {
        delete process.env.AGENTBAY_HERMES_STATE_ROOT;
      } else {
        process.env.AGENTBAY_HERMES_STATE_ROOT = previousStateRoot;
      }
      await rm(stateRoot, { force: true, recursive: true });
      await rm(targetRoot, { force: true, recursive: true });
    }
  });

  it("uses the required route methods", async () => {
    const service = createTestService();
    const response = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/start`));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "method_not_allowed",
      },
    });
  });
});

describe("manual runner Docker command contract", () => {
  it("stops only containers with the selected agent label", async () => {
    const calls: string[][] = [];
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({
        calls,
        containers: [
          { id: "selected-running", agentId: AGENT_ID, status: "running" },
          { id: "selected-exited", agentId: AGENT_ID, status: "exited" },
          { id: "other-running", agentId: OTHER_AGENT_ID, status: "running" },
        ],
      }),
      nameSuffix: () => "unit001",
    });

    const result = await docker.stop(AGENT_ID);

    expect(result.containers.map((container) => container.id)).toEqual([
      "selected-running",
      "selected-exited",
    ]);
    expect(calls).toContainEqual(["stop", "--time", "20", "selected-running"]);
    expect(calls).not.toContainEqual(["stop", "selected-exited"]);
    expect(calls).not.toContainEqual(["stop", "other-running"]);
  });

  it("fails closed when inspect returns a mismatched agent label", async () => {
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({
        containers: [{ id: "mismatched", agentId: OTHER_AGENT_ID, status: "running" }],
        psIds: ["mismatched"],
      }),
    });

    await expect(docker.status(AGENT_ID)).rejects.toThrow("Docker container label mismatch.");
  });

  it("restarts by removing selected containers and starting one replacement", async () => {
    const calls: string[][] = [];
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({
        calls,
        containers: [{ id: "old-selected", agentId: AGENT_ID, status: "running" }],
      }),
      nameSuffix: () => "unit001",
    });

    const result = await docker.restart(AGENT_ID);

    expect(result.container).toMatchObject({
      id: "container-001",
      status: "running",
    });
    expect(calls).toContainEqual(["rm", "--force", "old-selected"]);
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--detach"]));
  });
});

describe("Hermes detailed readiness contract", () => {
  it("accepts the pinned detailed-health shape without HTTP revision evidence", () => {
    expect(isHermesReadyResponse(pinnedHermesHealth())).toBe(true);
    expect(
      isHermesReadyResponse(pinnedHermesHealth({ platforms: { telegram: undefined } }), {
        requireTelegram: false,
      }),
    ).toBe(true);
  });

  it("rejects legacy aliases and classifies pinned platform failures safely", () => {
    const matrix: Array<[unknown, HermesReadinessReason]> = [
      [{ ...pinnedHermesHealth(), status: "ready" }, "gateway_failed"],
      [{ ...pinnedHermesHealth(), gateway_state: "starting" }, "gateway_failed"],
      [pinnedHermesHealth({ platforms: { api_server: undefined } }), "api_server_not_connected"],
      [
        pinnedHermesHealth({ platforms: { api_server: { state: "starting" } } }),
        "api_server_not_connected",
      ],
      [
        pinnedHermesHealth({ platforms: { api_server: { state: "fatal" } } }),
        "api_server_not_connected",
      ],
      [pinnedHermesHealth({ platforms: { telegram: undefined } }), "telegram_not_connected"],
      [
        pinnedHermesHealth({ platforms: { telegram: { state: "disconnected" } } }),
        "telegram_not_connected",
      ],
      [
        pinnedHermesHealth({ platforms: { telegram: { state: "retrying" } } }),
        "telegram_not_connected",
      ],
      [
        pinnedHermesHealth({ platforms: { telegram: { state: "fatal" } } }),
        "telegram_not_connected",
      ],
      [null, "gateway_failed"],
      [
        {
          status: "ready",
          ok: true,
          configRevision: "cfg-1",
          telegram: { enabled: true, status: "connected" },
          messaging: { telegram: { connected: true } },
        },
        "gateway_failed",
      ],
    ];

    for (const [body, reason] of matrix) {
      expect(evaluateHermesReadyResponse(body)).toEqual({ ok: false, reason });
      expect(isHermesReadyResponse(body)).toBe(false);
    }
  });

  it("returns the latest semantic reason at timeout and ignores unparseable probes", async () => {
    let now = 0;
    const waiter = createHermesReadinessWaiter(
      {
        cpus: "1",
        memory: "1536m",
        network: "agentbay-hermes",
        pidsLimit: "256",
        readinessPort: 8642,
      },
      {
        now: () => now,
        pollMs: 10,
        sleep: async (ms) => {
          now += ms;
        },
        timeoutMs: 30,
        requestHealth: async () => ({
          ok: true,
          body: now === 0 ? null : pinnedHermesHealth({ platforms: { telegram: undefined } }),
        }),
      },
    );

    await expect(
      waiter({
        agentId: AGENT_ID,
        apiServerKey: "agb_agent_key",
        configRevision: "cfg-1",
        containerName: "agentbay-runner-test",
      }),
    ).resolves.toEqual({ ok: false, reason: "telegram_not_connected" });
  });

  it("returns timeout when the deadline expires without parseable health evidence", async () => {
    let now = 0;
    const waiter = createHermesReadinessWaiter(
      {
        cpus: "1",
        memory: "1536m",
        network: "agentbay-hermes",
        pidsLimit: "256",
        readinessPort: 8642,
      },
      {
        now: () => now,
        pollMs: 10,
        sleep: async (ms) => {
          now += ms;
        },
        timeoutMs: 30,
        requestHealth: async () => ({
          ok: true,
          body: null,
        }),
      },
    );

    await expect(
      waiter({
        agentId: AGENT_ID,
        apiServerKey: "agb_agent_key",
        configRevision: "cfg-1",
        containerName: "agentbay-runner-test",
      }),
    ).resolves.toEqual({ ok: false, reason: "timeout" });
  });
});

async function createHermesProjectionForTest(
  spec: ReturnType<typeof sampleLaunchSpec>,
  options: { marker?: Record<string, unknown> } = {},
) {
  const agentRoot = join(tmpdir(), `agentbay-runner-projection-${Date.now()}-${Math.random()}`);
  const hermesHome = join(agentRoot, "hermes");
  const workspace = join(agentRoot, "workspace");
  const revisionPath = join(hermesHome, "agentbay-config-revision.json");

  await mkdir(hermesHome, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    revisionPath,
    JSON.stringify({
      version: spec.version,
      requestId: spec.requestId,
      agentId: spec.agent.id,
      configRevision: spec.agent.configRevision,
      image: spec.image.ref,
      ...(options.marker ?? {}),
    }),
  );

  return {
    agentRoot,
    hermesHome,
    workspace,
    configPath: join(hermesHome, "config.yaml"),
    envPath: join(hermesHome, ".env"),
    soulPath: join(hermesHome, "SOUL.md"),
    revisionPath,
  };
}

function pinnedHermesHealth(
  overrides: {
    platforms?: {
      api_server?: { state: string } | undefined;
      telegram?: { state: string } | undefined;
    };
  } = {},
) {
  return {
    status: "ok",
    platform: "hermes-agent",
    version: "v2026.7.7.2",
    gateway_state: "running",
    platforms: {
      api_server: { state: "connected" },
      telegram: { state: "connected" },
      ...(overrides.platforms ?? {}),
    },
    exit_reason: null,
    updated_at: "2026-08-03T00:00:00.000Z",
    pid: 123,
  };
}

function createTestService(input: { docker?: DockerExecutableRunner } = {}) {
  return createRunnerService({
    authToken: "test-token",
    docker: new ManualRunnerDocker({
      command: testCommand(),
      ...(input.docker ? { docker: input.docker } : {}),
      nameSuffix: () => "unit001",
    }),
  });
}

function authorizedRequest(path: string, method = "GET"): Request {
  return new Request(`http://runner.test${path}`, {
    method,
    headers: {
      Authorization: "Bearer test-token",
    },
  });
}

function authorizedJsonRequest(path: string, body: unknown): Request {
  return new Request(`http://runner.test${path}`, {
    method: "POST",
    headers: {
      Authorization: "Bearer test-token",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function testCommand() {
  return {
    image: "agentbay/runner:test",
    args: ["agentbay-runner", "--serve"],
  };
}

function createMockDocker(
  input: {
    calls?: string[][];
    containers?: {
      agentId: string;
      id: string;
      image?: string;
      labels?: Record<string, string>;
      runArgs?: readonly string[];
      status: string;
    }[];
    failRemoveIds?: string[];
    injectDockerSocket?: boolean;
    logs?: { stderr: string; stdout: string };
    psIds?: string[];
  } = {},
): DockerExecutableRunner {
  const containers = new Map(
    (input.containers ?? []).map((container) => [container.id, { ...container }]),
  );

  return async (_executable, args) => {
    input.calls?.push([...args]);

    if (args[0] === "ps") {
      const filter = String(args[args.indexOf("--filter") + 1]);
      const agentId = filter.split(`${AGENTBAY_AGENT_ID_LABEL}=`)[1] ?? "";
      const rows = (
        input.psIds ?? [
          ...[...containers.values()]
            .filter((container) => container.agentId === agentId)
            .map((container) => container.id),
        ]
      ).map((id) => JSON.stringify({ ID: id }));

      return { stdout: rows.join("\n"), stderr: "" };
    }

    if (args[0] === "run") {
      containers.set("container-001", {
        id: "container-001",
        agentId: readLabelAgentId(args),
        image: readRunImage(args),
        labels: readRunLabels(args),
        runArgs: args,
        status: "running",
      });

      return { stdout: "container-001\n", stderr: "" };
    }

    if (args[0] === "inspect") {
      const id = String(args.at(-1));
      const container = containers.get(id);

      if (!container) {
        throw new Error(`missing container ${id}`);
      }

      return {
        stdout: JSON.stringify({
          Id: container.id,
          Args: readContainerCommandArgs(container.runArgs),
          Mounts: [
            ...readRunMounts(container.runArgs),
            ...(input.injectDockerSocket
              ? [
                  {
                    Type: "bind",
                    Source: "/var/run/docker.sock",
                    Destination: "/var/run/docker.sock",
                  },
                ]
              : []),
          ],
          Name: `/${container.id}`,
          Config: {
            Cmd: readContainerCommandArgs(container.runArgs),
            Entrypoint: null,
            Env: [],
            Image: container.image ?? "agentbay/runner:test",
            Labels: {
              [AGENTBAY_AGENT_ID_LABEL]: container.agentId,
              ...(container.labels ?? {}),
            },
          },
          HostConfig: readRunHostConfig(container.runArgs),
          NetworkSettings: readRunNetworkSettings(container.runArgs),
          State: {
            Status: container.status,
            StartedAt: "2026-07-05T00:00:00.000Z",
            FinishedAt: "0001-01-01T00:00:00Z",
          },
        }),
        stderr: "",
      };
    }

    if (args[0] === "stop") {
      const container = containers.get(String(args[1]));

      if (container) {
        container.status = "exited";
      }

      return { stdout: "", stderr: "" };
    }

    if (args[0] === "rm") {
      if (input.failRemoveIds?.includes(String(args.at(-1)))) {
        throw new Error("cleanup failed");
      }

      containers.delete(String(args.at(-1)));

      return { stdout: "", stderr: "" };
    }

    if (args[0] === "logs") {
      return {
        stdout: input.logs?.stdout ?? "2026-07-05T00:00:01.000000000Z ready\n",
        stderr: input.logs?.stderr ?? "2026-07-05T00:00:02.000000000Z warn\n",
      };
    }

    throw new Error(`unexpected docker args: ${args.join(" ")}`);
  };
}

function readLabelAgentId(args: readonly string[]): string {
  const label = String(args[args.indexOf("--label") + 1]);

  return label.split(`${AGENTBAY_AGENT_ID_LABEL}=`)[1] ?? "";
}

function readRunImage(args: readonly string[]): string {
  if (args.at(-2) === "gateway" && args.at(-1) === "run") {
    return String(args.at(-3));
  }

  return "agentbay/runner:test";
}

function readRunLabels(args: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--label") {
      continue;
    }

    const [key, value] = String(args[index + 1] ?? "").split("=");

    if (key && value) {
      labels[key] = value;
    }
  }

  return labels;
}

function readRunMounts(args: readonly string[] | undefined) {
  const mounts: Array<{ Type: string; Source: string; Destination: string }> = [];

  if (!args) {
    return mounts;
  }

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--mount") {
      continue;
    }

    const spec = Object.fromEntries(
      String(args[index + 1] ?? "")
        .split(",")
        .map((part) => part.split("=")),
    );

    mounts.push({
      Type: String(spec.type ?? ""),
      Source: String(spec.source ?? ""),
      Destination: String(spec.target ?? ""),
    });
  }

  return mounts;
}

function readRunHostConfig(args: readonly string[] | undefined) {
  const cpus = readArgValue(args, "--cpus");
  const memory = readArgValue(args, "--memory");
  const pidsLimit = readArgValue(args, "--pids-limit");

  return {
    Binds: [],
    CapDrop: readRepeatedArgValues(args, "--cap-drop"),
    CapAdd: readRepeatedArgValues(args, "--cap-add"),
    Memory: memory ? parseDockerMemoryBytesForTest(memory) : 0,
    NanoCpus: cpus ? Math.round(Number.parseFloat(cpus) * 1_000_000_000) : 0,
    NetworkMode: readArgValue(args, "--network") ?? "bridge",
    PidsLimit: pidsLimit ? Number.parseInt(pidsLimit, 10) : 0,
    PortBindings: {},
    SecurityOpt: readRepeatedArgValues(args, "--security-opt"),
  };
}

function readRunNetworkSettings(args: readonly string[] | undefined) {
  const network = readArgValue(args, "--network") ?? "bridge";

  return {
    Networks: { [network]: {} },
    Ports: { "8642/tcp": null },
  };
}

function readContainerCommandArgs(args: readonly string[] | undefined): string[] {
  if (args?.at(-2) === "gateway" && args.at(-1) === "run") {
    return ["gateway", "run"];
  }

  return testCommand().args;
}

function readArgValue(args: readonly string[] | undefined, flag: string): string | null {
  const index = args?.indexOf(flag) ?? -1;

  return index >= 0 ? String(args?.[index + 1] ?? "") : null;
}

function readRepeatedArgValues(args: readonly string[] | undefined, flag: string): string[] {
  const values: string[] = [];

  if (!args) {
    return values;
  }

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      values.push(String(args[index + 1] ?? ""));
    }
  }

  return values;
}

function parseDockerMemoryBytesForTest(value: string): number {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());

  if (!match?.[1]) {
    return 0;
  }

  const units: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  const unit = match[2]?.toLowerCase() ?? "b";

  return Number.parseInt(match[1], 10) * (units[unit] ?? 1);
}
