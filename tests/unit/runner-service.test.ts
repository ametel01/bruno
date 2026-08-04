import { execFile } from "node:child_process";
import { access, lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  AGENTBAY_AGENT_ID_LABEL,
  createHermesReadinessWaiter,
  evaluateHermesReadyResponse,
  isHermesReadyResponse,
  ManualRunnerDocker,
  RunnerLaunchCancelledError,
  type DockerExecutableRunner,
  type HermesReadinessReason,
} from "@/src/runner-service/docker";
import { createRunnerService } from "@/src/runner-service/server";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import { sampleLaunchSpec, sampleManagedLaunchSpec } from "@/tests/helpers/agent-launch-spec";

const AGENT_ID = "00000000-0000-4000-8000-000000000123";
const OTHER_AGENT_ID = "00000000-0000-4000-8000-000000000456";
const MOCK_IMAGE_ID = `sha256:${"c".repeat(64)}`;
const MOCK_REPO_DIGEST =
  "nousresearch/hermes-agent@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973";
const execFileAsync = promisify(execFile);

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
      contractVersion: "agentbay.runner.status.v3",
      snapshot: {
        container: { id: "container-001", state: "running" },
        phase: "failed",
        readinessReason: "revision_missing",
      },
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
    expect(calls.find((args) => args[0] === "run")).not.toContain("--restart");
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

    expect(valid.status).toBe(202);
    expect(projected).toEqual([AGENT_ID]);
    expect(readiness).toEqual([]);
    const validBody = await valid.json();
    expect(validBody).toMatchObject({
      ok: true,
      contractVersion: "agentbay.runner.launch.v2",
      operation: { state: "accepted", disposition: "created" },
      snapshot: { phase: "accepted", readinessReason: "launch_accepted" },
    });
    expect(Object.keys(validBody.operation).sort()).toEqual([
      "acceptedAt",
      "disposition",
      "id",
      "state",
      "target",
    ]);
    expect(calls).toContainEqual(expect.arrayContaining(["run", "--detach"]));
    const managedRun = calls.find((args) => args[0] === "run");
    expect(managedRun?.filter((argument) => argument === "--restart")).toHaveLength(1);
    expect(
      managedRun?.slice(managedRun.indexOf("--restart"), managedRun.indexOf("--restart") + 2),
    ).toEqual(["--restart", "unless-stopped"]);
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

  it("fails closed when Docker inspect exposes managed Telegram allowlist values", async () => {
    const calls: string[][] = [];
    const service = createRunnerService({
      authToken: "test-token",
      docker: new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({
          calls,
          inspectEnv: ["TELEGRAM_ALLOWED_USERS=1,222222"],
        }),
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
        sampleManagedLaunchSpec({ agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "docker_command_failed" },
    });
    expect(calls).toContainEqual(["rm", "--force", "container-001"]);
  });

  it("does not poll Hermes readiness during launch acceptance", async () => {
    const readiness = vi.fn(async () => ({ ok: false as const, reason: "timeout" as const }));
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
          wait: readiness,
        },
      }),
    });
    const response = await service.fetch(
      authorizedJsonRequest(
        `/runner/v1/agents/${AGENT_ID}/start`,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    );

    expect(response.status).toBe(202);
    expect(readiness).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      contractVersion: "agentbay.runner.launch.v2",
      snapshot: { phase: "accepted", readinessReason: "launch_accepted" },
    });
  });

  it("retains the accepted container when later health would still be unready", async () => {
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

    expect(response.status).toBe(202);
    await expect(status.json()).resolves.toMatchObject({
      ok: true,
      contractVersion: "agentbay.runner.status.v3",
      snapshot: { container: { id: "container-001", state: "running" } },
    });
    expect(calls).not.toContainEqual(["rm", "--force", "container-001"]);
  });

  it("does not run failed-launch readiness cleanup during async acceptance", async () => {
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

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      snapshot: { phase: "accepted" },
    });
    expect(calls).not.toContainEqual(["rm", "--force", "container-001"]);
  });

  it("serializes duplicate managed starts and reuses the exact accepted container", async () => {
    const calls: string[][] = [];
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, {
              apiServerKey: spec.secrets.apiServerKey,
            }),
        },
      });
      const spec = sampleLaunchSpec({
        agent: { ...sampleLaunchSpec().agent, id: AGENT_ID },
      });

      const [first, second] = await Promise.all([
        docker.start(AGENT_ID, spec),
        docker.start(AGENT_ID, spec),
      ]);

      expect(first).toMatchObject({
        operation: { disposition: "created" },
        snapshot: { container: { id: "container-001" }, phase: "accepted" },
      });
      expect(second).toMatchObject({
        operation: { disposition: "reused" },
        snapshot: { container: { id: "container-001" }, phase: "accepted" },
      });
      expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
      expect(calls).not.toContainEqual(["rm", "--force", "container-001"]);
    });
  });

  it.each([
    ["no", { Name: "no", MaximumRetryCount: 0 }],
    ["always", { Name: "always", MaximumRetryCount: 0 }],
    ["on-failure", { Name: "on-failure", MaximumRetryCount: 3 }],
    ["nonzero unless-stopped retry count", { Name: "unless-stopped", MaximumRetryCount: 1 }],
    ["missing", null],
    ["unknown", { Name: "sometimes", MaximumRetryCount: 0 }],
    ["negative maximum retry count", { Name: "unless-stopped", MaximumRetryCount: -1 }],
  ])("replaces one managed container with %s restart policy evidence", async (_name, policy) => {
    const calls: string[][] = [];
    let exposeStalePolicy = false;
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({
          calls,
          inspectRestartPolicy: () => (exposeStalePolicy ? policy : undefined),
          removed: () => {
            exposeStalePolicy = false;
          },
        }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });

      await expect(docker.start(AGENT_ID, spec)).resolves.toMatchObject({
        operation: { disposition: "created" },
      });
      exposeStalePolicy = true;
      await expect(docker.start(AGENT_ID, spec)).resolves.toMatchObject({
        operation: { disposition: "replaced" },
      });

      expect(calls.filter((args) => args[0] === "run")).toHaveLength(2);
      expect(calls.filter((args) => args[0] === "stop")).toEqual([
        ["stop", "--time", "20", "container-001"],
      ]);
      expect(calls.filter((args) => args[0] === "rm")).toEqual([
        ["rm", "--force", "container-001"],
      ]);
    });
  });

  it("replaces stale selected containers while preserving unrelated agent containers", async () => {
    const calls: string[][] = [];
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({
        calls,
        containers: [
          {
            id: "stale-selected",
            agentId: AGENT_ID,
            image: sampleLaunchSpec().image.ref,
            status: "running",
          },
          { id: "other-selected", agentId: OTHER_AGENT_ID, status: "running" },
        ],
      }),
      nameSuffix: () => "unit001",
      projection: {
        project: (spec) =>
          createHermesProjectionForTest(spec, {
            apiServerKey: spec.secrets.apiServerKey,
          }),
      },
    });

    await expect(
      docker.start(
        AGENT_ID,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
      ),
    ).resolves.toMatchObject({
      operation: { disposition: "replaced" },
      snapshot: { container: { id: "container-001" } },
    });
    expect(calls).toContainEqual(["rm", "--force", "stale-selected"]);
    expect(calls).not.toContainEqual(["rm", "--force", "other-selected"]);
    expect(calls.filter((args) => args[0] === "run")).toHaveLength(1);
  });

  it("cancels an in-progress launch before Docker run when stop wins the race", async () => {
    const calls: string[][] = [];
    let releaseProjection!: () => void;
    const projectionStarted = new Promise<void>((resolveStarted) => {
      releaseProjection = resolveStarted;
    });
    const docker = new ManualRunnerDocker({
      command: testCommand(),
      docker: createMockDocker({ calls }),
      nameSuffix: () => "unit001",
      projection: {
        project: async (spec) => {
          await createHermesProjectionForTest(spec, {
            apiServerKey: spec.secrets.apiServerKey,
          });
          await projectionStarted;
          return await createHermesProjectionForTest(spec, {
            apiServerKey: spec.secrets.apiServerKey,
          });
        },
      },
    });
    const start = docker.start(
      AGENT_ID,
      sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stop = docker.stop(AGENT_ID);
    releaseProjection();

    await expect(start).rejects.toBeInstanceOf(RunnerLaunchCancelledError);
    await expect(stop).resolves.toMatchObject({
      cancelledOperationId: expect.any(String),
      containers: [],
      snapshot: { phase: "stopped", readinessReason: "launch_cancelled" },
    });
    expect(calls.filter((args) => args[0] === "run")).toEqual([]);

    const recovered = await docker.start(
      AGENT_ID,
      sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
    );
    if (!("operation" in recovered)) {
      throw new Error("managed launch did not recover after cancellation");
    }
    await expect(docker.stop(AGENT_ID)).resolves.toMatchObject({
      cancelledOperationId: recovered.operation.id,
      snapshot: { phase: "stopped" },
    });
    await expect(docker.stop(AGENT_ID)).resolves.toMatchObject({
      cancelledOperationId: null,
      snapshot: { phase: "stopped" },
    });
  });

  it("aborts Docker run on cancellation and removes the known created container", async () => {
    const calls: string[][] = [];
    const baseDocker = createMockDocker({ calls });
    let markRunStarted!: () => void;
    const runStarted = new Promise<void>((resolveStarted) => {
      markRunStarted = resolveStarted;
    });
    const dockerRunner: DockerExecutableRunner = async (executable, args, options) => {
      if (args[0] !== "run") {
        return await baseDocker(executable, args, options);
      }

      const result = await baseDocker(executable, args, options);
      markRunStarted();
      await new Promise<void>((_resolveResult, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
        if (options?.signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
      });
      return result;
    };
    const docker = new ManualRunnerDocker({
      docker: dockerRunner,
      nameSuffix: () => "unit001",
      projection: { project: createHermesProjectionForTest },
    });
    const start = docker.start(
      AGENT_ID,
      sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
    );
    await runStarted;
    const stopped = docker.stop(AGENT_ID);

    await expect(start).rejects.toBeInstanceOf(RunnerLaunchCancelledError);
    await expect(stopped).resolves.toMatchObject({
      cancelledOperationId: expect.any(String),
      containers: [],
      snapshot: { phase: "stopped" },
    });
    expect(calls).toContainEqual(["rm", "--force", `agentbay-runner-${AGENT_ID}-unit001`]);
    await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
      snapshot: { phase: "idle", container: { state: "absent" } },
    });
  });

  it("enforces one 30-second launch budget even when projection never resolves", async () => {
    vi.useFakeTimers();
    const calls: string[][] = [];

    try {
      const service = createRunnerService({
        authToken: "test-token",
        docker: new ManualRunnerDocker({
          docker: createMockDocker({ calls }),
          projection: {
            project: async () => await new Promise(() => undefined),
          },
        }),
      });
      const responsePromise = service.fetch(
        authorizedJsonRequest(
          `/runner/v1/agents/${AGENT_ID}/start`,
          sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
        ),
      );

      await vi.advanceTimersByTimeAsync(30_000);
      const response = await responsePromise;

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toEqual({
        ok: false,
        error: {
          code: "launch_acceptance_timeout",
          message: "Runner launch acceptance timed out.",
        },
      });
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps different agents independent while one launch is blocked", async () => {
    let releaseFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const firstGate = new Promise<void>((resolveGate) => {
      releaseFirst = resolveGate;
    });
    const docker = new ManualRunnerDocker({
      docker: createMockDocker(),
      nameSuffix: () => "unit001",
      projection: {
        project: async (spec) => {
          if (spec.agent.id === AGENT_ID) {
            markFirstStarted();
            await firstGate;
          }
          return await createHermesProjectionForTest(spec);
        },
      },
    });
    const first = docker.start(
      AGENT_ID,
      sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } }),
    );
    await firstStarted;

    await expect(
      docker.start(
        OTHER_AGENT_ID,
        sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: OTHER_AGENT_ID } }),
      ),
    ).resolves.toMatchObject({ snapshot: { phase: "accepted" } });

    releaseFirst();
    await expect(first).resolves.toMatchObject({ snapshot: { phase: "accepted" } });
  });

  it("observes ready status with the projected API key and never exposes probe bodies", async () => {
    const probeCalls: Array<{ apiServerKey: string; containerName: string }> = [];
    const dockerCalls: string[][] = [];
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        command: testCommand(),
        docker: createMockDocker({ calls: dockerCalls }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, {
              apiServerKey: spec.secrets.apiServerKey,
            }),
        },
        probe: {
          requestHealth: async (input) => {
            probeCalls.push({
              apiServerKey: input.apiServerKey,
              containerName: input.containerName,
            });
            return {
              ok: true,
              body: { ...pinnedHermesHealth(), raw: "OPENROUTER_API_KEY=sk-or-v1-upstream" },
            };
          },
        },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });

      await docker.start(AGENT_ID, spec);
      const status = await docker.status(AGENT_ID);

      expect(status).toMatchObject({
        contractVersion: "agentbay.runner.status.v3",
        snapshot: {
          phase: "ready",
          readinessReason: null,
          container: {
            imageIdentity: {
              imageId: MOCK_IMAGE_ID,
              repoDigests: [MOCK_REPO_DIGEST],
            },
            restartPolicy: { name: "unless-stopped", maximumRetryCount: 0 },
            restartCount: 0,
          },
          gateway: { state: "running" },
          apiServer: { state: "connected" },
          telegram: { state: "connected" },
        },
      });
      expect(probeCalls).toEqual([
        {
          apiServerKey: spec.secrets.apiServerKey,
          containerName: `agentbay-runner-${AGENT_ID}-unit001`,
        },
      ]);
      expect(dockerCalls).toContainEqual([
        "image",
        "inspect",
        "--format",
        '{"imageId":{{json .Id}},"repoDigests":{{json .RepoDigests}}}',
        MOCK_IMAGE_ID,
      ]);
      expect(JSON.stringify(status)).not.toContain(spec.secrets.apiServerKey);
      expect(JSON.stringify(status)).not.toContain("sk-or-v1-upstream");
    });
  });

  it("falls back to a private in-container health probe when runner-network transport fails", async () => {
    await withHermesStateRootForTest(async () => {
      const dockerCalls: string[][] = [];
      const requestHealth = vi.fn(async () => ({ ok: false, status: 0, body: null }));
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({ calls: dockerCalls, execProbeBody: pinnedHermesHealth() }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });

      await docker.start(AGENT_ID, spec);

      await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
        snapshot: {
          phase: "ready",
          readinessReason: null,
          gateway: { state: "running" },
          apiServer: { state: "connected" },
          telegram: { state: "connected" },
        },
      });
      expect(requestHealth).toHaveBeenCalledOnce();
      const execProbe = dockerCalls.find((args) => args[0] === "exec");
      expect(execProbe).toEqual(
        expect.arrayContaining(["exec", `agentbay-runner-${AGENT_ID}-unit001`, "python", "8642"]),
      );
      expect(JSON.stringify(execProbe)).not.toContain(spec.secrets.apiServerKey);
    });
  });

  it("keeps bounded image identity stable while Docker restart observations advance", async () => {
    let restartCount = 0;

    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({ inspectRestartCount: () => restartCount }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }) },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);

      const before = await docker.status(AGENT_ID);
      restartCount = 1;
      const after = await docker.status(AGENT_ID);

      expect(before.snapshot.container).toMatchObject({
        imageIdentity: { imageId: MOCK_IMAGE_ID, repoDigests: [MOCK_REPO_DIGEST] },
        restartCount: 0,
      });
      expect(after.snapshot.container).toMatchObject({
        imageIdentity: before.snapshot.container.imageIdentity,
        restartCount: 1,
      });
    });
  });

  it.each([
    [
      "mismatched image ID",
      JSON.stringify({ imageId: `sha256:${"d".repeat(64)}`, repoDigests: [MOCK_REPO_DIGEST] }),
    ],
    [
      "malformed projection",
      JSON.stringify({ imageId: MOCK_IMAGE_ID, repoDigests: [MOCK_REPO_DIGEST], rawInspect: {} }),
    ],
    ["oversized projection", "x".repeat(16 * 1024 + 1)],
  ])("fails image identity evidence closed for %s without changing runtime readiness", async (_case, imageInspectStdout) => {
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({ imageInspectStdout: () => imageInspectStdout }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }) },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);

      const status = await docker.status(AGENT_ID);

      expect(status.snapshot).toMatchObject({
        phase: "ready",
        container: { imageIdentity: null },
      });
      expect(JSON.stringify(status)).not.toContain("rawInspect");
    });
  });

  it("normalizes malformed Docker restart counts to unknown status evidence", async () => {
    let restartCount: unknown = 0;
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({ inspectRestartCount: () => restartCount }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }) },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);

      for (const invalid of [undefined, null, -1, 2_147_483_648, 1.5, "3"]) {
        restartCount = invalid;
        await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
          snapshot: { container: { restartCount: null } },
        });
      }
    });
  });

  it.each([
    ["connecting", "starting", "telegram_not_connected"],
    ["connected", "ready", null],
    ["disconnected", "starting", "telegram_not_connected"],
    ["retrying", "starting", "telegram_retrying"],
    ["fatal", "failed", "telegram_fatal"],
    ["paused", "failed", "telegram_paused"],
    ["disabled", "starting", "telegram_not_connected"],
    ["unknown", "starting", "telegram_not_connected"],
  ] as const)("retains exact Telegram %s health state", async (state, phase, reason) => {
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker(),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: {
          requestHealth: async () => ({
            ok: true,
            body: pinnedHermesHealth({ platforms: { telegram: { state } } }),
          }),
        },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);

      await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
        snapshot: {
          phase,
          readinessReason: reason,
          telegram: { state },
        },
      });
    });
  });

  it("bounds both status transports and maps timeout without leaking errors", async () => {
    vi.useFakeTimers();
    let markProbeStarted!: () => void;
    let markFallbackStarted!: () => void;
    const probeStarted = new Promise<void>((resolveStarted) => {
      markProbeStarted = resolveStarted;
    });
    const fallbackStarted = new Promise<void>((resolveStarted) => {
      markFallbackStarted = resolveStarted;
    });

    try {
      await withHermesStateRootForTest(async () => {
        const docker = new ManualRunnerDocker({
          docker: createMockDocker(),
          nameSuffix: () => "unit001",
          projection: {
            project: (spec) =>
              createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
          },
          probe: {
            requestHealth: async () => {
              markProbeStarted();
              return await new Promise(() => undefined);
            },
            requestContainerHealth: async () => {
              markFallbackStarted();
              return await new Promise(() => undefined);
            },
          },
        });
        const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
        await docker.start(AGENT_ID, spec);
        const statusPromise = docker.status(AGENT_ID);
        await probeStarted;

        await vi.advanceTimersByTimeAsync(2_000);
        await fallbackStarted;
        await vi.advanceTimersByTimeAsync(2_000);

        await expect(statusPromise).resolves.toMatchObject({
          snapshot: { phase: "starting", readinessReason: "health_timeout" },
        });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects accessor health fixtures and duplicate projected API keys safely", async () => {
    await withHermesStateRootForTest(async () => {
      const probe = vi.fn(async () => {
        const body = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(body, "status", {
          enumerable: true,
          get() {
            throw new Error("API_SERVER_KEY=agb_agent_hostile_probe_secret");
          },
        });
        return { ok: true, body };
      });
      const docker = new ManualRunnerDocker({
        docker: createMockDocker(),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth: probe },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);

      const hostile = await docker.status(AGENT_ID);
      expect(hostile.snapshot).toMatchObject({
        phase: "starting",
        readinessReason: "health_invalid",
      });
      expect(JSON.stringify(hostile)).not.toContain("hostile_probe_secret");

      const envPath = join(
        String(process.env.AGENTBAY_HERMES_STATE_ROOT),
        AGENT_ID,
        "hermes",
        ".env",
      );
      await writeFile(
        envPath,
        `API_SERVER_KEY="${spec.secrets.apiServerKey}"\nAPI_SERVER_KEY="${spec.secrets.apiServerKey}"\n`,
      );
      const duplicate = await docker.status(AGENT_ID);

      expect(duplicate.snapshot).toMatchObject({
        phase: "starting",
        readinessReason: "probe_credential_unavailable",
      });
      expect(probe).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects a FIFO projected API key without blocking status or canary", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withHermesStateRootForTest(async () => {
      const requestHealth = vi.fn(async () => ({ ok: true, body: pinnedHermesHealth() }));
      const requestCanary = vi.fn(async () => ({
        ok: true,
        status: 200,
        body: { choices: [{ message: { role: "assistant", content: "ok" } }] },
      }));
      const docker = new ManualRunnerDocker({
        docker: createMockDocker(),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: { requestHealth, requestCanary },
      });
      const service = createRunnerService({ authToken: "test-token", docker });
      const spec = sampleManagedLaunchSpec({
        agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID },
      });
      const acceptedResponse = await service.fetch(
        authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/start`, spec),
      );
      const accepted = await acceptedResponse.json();
      const envPath = join(
        String(process.env.AGENTBAY_HERMES_STATE_ROOT),
        AGENT_ID,
        "hermes",
        ".env",
      );

      await rm(envPath);
      await execFileAsync("mkfifo", [envPath]);
      expect((await lstat(envPath)).isFIFO()).toBe(true);

      const statusStartedAt = performance.now();
      const statusResponse = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`),
      );
      const statusElapsedMs = performance.now() - statusStartedAt;
      const status = await statusResponse.json();

      expect(statusResponse.status).toBe(200);
      expect(statusElapsedMs).toBeLessThan(1_000);
      expect(status).toMatchObject({
        ok: true,
        snapshot: {
          phase: "starting",
          readinessReason: "probe_credential_unavailable",
        },
      });

      const canaryStartedAt = performance.now();
      const canaryResponse = await service.fetch(
        authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/canary`, {
          operationId: accepted.operation.id,
          configRevision: spec.agent.configRevision,
          model: spec.model.model,
        }),
      );
      const canaryElapsedMs = performance.now() - canaryStartedAt;

      expect(canaryResponse.status).toBe(409);
      expect(canaryElapsedMs).toBeLessThan(1_000);
      await expect(canaryResponse.json()).resolves.toEqual({
        ok: false,
        error: {
          code: "canary_not_ready",
          message: "Runner canary requires a ready operation.",
        },
      });
      expect(requestHealth).not.toHaveBeenCalled();
      expect(requestCanary).not.toHaveBeenCalled();

      const repeatedStatus = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`),
      );
      await expect(repeatedStatus.json()).resolves.toMatchObject({
        snapshot: { readinessReason: "probe_credential_unavailable" },
      });

      await rm(envPath);
      await writeFile(envPath, `API_SERVER_KEY="${spec.secrets.apiServerKey}"\n`);
      const recovered = await service.fetch(
        authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`),
      );

      await expect(recovered.json()).resolves.toMatchObject({
        snapshot: { phase: "ready", readinessReason: null },
      });
      expect(requestHealth).toHaveBeenCalledTimes(1);
      expect(requestCanary).not.toHaveBeenCalled();
    });
  });

  it("fails transient readiness exactly at the 180-second boundary", async () => {
    let now = new Date("2026-08-03T05:20:00.000Z");
    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker(),
        nameSuffix: () => "unit001",
        now: () => now,
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: {
          requestHealth: async () => ({
            ok: true,
            body: {
              status: "ok",
              gateway_state: "starting",
              platforms: {
                api_server: { state: "connecting" },
                telegram: { state: "connecting" },
              },
            },
          }),
        },
      });
      const spec = sampleLaunchSpec({ agent: { ...sampleLaunchSpec().agent, id: AGENT_ID } });
      await docker.start(AGENT_ID, spec);
      now = new Date(now.getTime() + 180_000);

      await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
        snapshot: { phase: "failed", readinessReason: "readiness_timeout" },
      });
    });
  });

  it("fails canary until status is ready and runs ready canaries through the private API key", async () => {
    const spec = sampleManagedLaunchSpec({
      agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID },
    });
    const canaryCalls: Array<{ apiServerKey: string; model: string }> = [];
    await withHermesStateRootForTest(async () => {
      const service = createRunnerService({
        authToken: "test-token",
        docker: new ManualRunnerDocker({
          command: testCommand(),
          docker: createMockDocker(),
          nameSuffix: () => "unit001",
          projection: {
            project: (launchSpec) =>
              createHermesProjectionForTest(launchSpec, {
                apiServerKey: launchSpec.secrets.apiServerKey,
              }),
          },
          probe: {
            requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }),
            requestCanary: async (input) => {
              canaryCalls.push({ apiServerKey: input.apiServerKey, model: input.model });
              return {
                ok: true,
                status: 200,
                body: {
                  choices: [
                    {
                      message: {
                        role: "assistant",
                        content: "OPENROUTER_API_KEY=sk-or-v1-upstream",
                      },
                    },
                  ],
                },
              };
            },
          },
        }),
      });
      const accepted = await service.fetch(
        authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/start`, spec),
      );
      const acceptedBody = await accepted.json();

      const ready = await service.fetch(
        authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/canary`, {
          operationId: acceptedBody.operation.id,
          configRevision: spec.agent.configRevision,
          model: spec.model.model,
        }),
      );
      const stale = await service.fetch(
        authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/canary`, {
          operationId: "00000000-0000-4000-8000-000000000999",
          configRevision: spec.agent.configRevision,
          model: spec.model.model,
        }),
      );

      expect(ready.status).toBe(200);
      const readyBody = await ready.json();
      expect(readyBody).toMatchObject({
        ok: true,
        contractVersion: "agentbay.runner.canary.v1",
        observation: { state: "passed", reason: null },
      });
      expect(stale.status).toBe(409);
      expect(canaryCalls).toEqual([
        { apiServerKey: spec.secrets.apiServerKey, model: spec.model.model },
      ]);
      expect(JSON.stringify(readyBody)).not.toContain("sk-or-v1-upstream");
    });
  });

  it("sends only the fixed no-tools canary request through the private container boundary", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ input: string; init: RequestInit | undefined }> = [];

    try {
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ input: String(input), init });
        return Response.json({
          choices: [{ message: { role: "assistant", content: "hostile provider output" } }],
        });
      }) as typeof fetch;

      await withHermesStateRootForTest(async () => {
        const docker = new ManualRunnerDocker({
          docker: createMockDocker(),
          nameSuffix: () => "unit001",
          projection: {
            project: (spec) =>
              createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
          },
          probe: { requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }) },
        });
        const spec = sampleManagedLaunchSpec({
          agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID },
        });
        const accepted = await docker.start(AGENT_ID, spec);

        if (!("operation" in accepted)) {
          throw new Error("managed launch did not return an accepted operation");
        }

        const canary = await docker.canary(AGENT_ID, {
          operationId: accepted.operation.id,
          configRevision: spec.agent.configRevision,
          model: spec.model.model,
        });

        expect(canary.observation).toMatchObject({ state: "passed", reason: null });
        expect(JSON.stringify(canary)).not.toContain("hostile provider output");
        expect(requests).toHaveLength(1);
        expect(requests[0]?.input).toBe(
          `http://agentbay-runner-${AGENT_ID}-unit001:8642/v1/chat/completions`,
        );
        expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
          model: spec.model.model,
          messages: [{ role: "user", content: "Reply with ok." }],
          tools: [],
          stream: false,
          max_tokens: 16,
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("falls back to an in-container canary without putting the API key in Docker arguments", async () => {
    const dockerCalls: string[][] = [];
    const requestCanary = vi.fn(async () => ({ ok: false, status: 0, body: null }));

    await withHermesStateRootForTest(async () => {
      const docker = new ManualRunnerDocker({
        docker: createMockDocker({
          calls: dockerCalls,
          execProbeBody: { choices: [{ message: { role: "assistant", content: "ok" } }] },
        }),
        nameSuffix: () => "unit001",
        projection: {
          project: (spec) =>
            createHermesProjectionForTest(spec, { apiServerKey: spec.secrets.apiServerKey }),
        },
        probe: {
          requestHealth: async () => ({ ok: true, body: pinnedHermesHealth() }),
          requestCanary,
        },
      });
      const spec = sampleManagedLaunchSpec({
        agent: { ...sampleManagedLaunchSpec().agent, id: AGENT_ID },
      });
      const accepted = await docker.start(AGENT_ID, spec);

      if (!("operation" in accepted)) {
        throw new Error("managed launch did not return an accepted operation");
      }

      await expect(
        docker.canary(AGENT_ID, {
          operationId: accepted.operation.id,
          configRevision: spec.agent.configRevision,
          model: spec.model.model,
        }),
      ).resolves.toMatchObject({ observation: { state: "passed", reason: null } });

      expect(requestCanary).toHaveBeenCalledOnce();
      const execProbe = dockerCalls.find((args) => args[0] === "exec");
      expect(execProbe).toEqual(expect.arrayContaining(["exec", "python", spec.model.model]));
      expect(JSON.stringify(execProbe)).not.toContain(spec.secrets.apiServerKey);
    });
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
    await expect(docker.status(AGENT_ID)).resolves.toMatchObject({
      contractVersion: "agentbay.runner.status.v3",
      snapshot: { phase: "idle", readinessReason: "container_absent" },
    });
    await expect(docker.status(OTHER_AGENT_ID)).resolves.toMatchObject({
      snapshot: { container: { id: "other-selected", state: "running" } },
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

  it("enforces strict canary bodies, bounded JSON, and safe status failures", async () => {
    const canary = vi.fn(async () => ({}));
    const failingDocker = {
      start: async () => ({}),
      stop: async () => ({}),
      restart: async () => ({}),
      status: async () => {
        throw new Error("DOCKER_STDERR=sk-or-v1-hostile-status-secret");
      },
      logs: async () => ({}),
      cleanup: async () => ({}),
      canary,
    };
    const service = createRunnerService({ authToken: "test-token", docker: failingDocker });
    const invalidContentType = await service.fetch(
      new Request(`http://runner.test/runner/v1/agents/${AGENT_ID}/canary`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/jsonp",
        },
        body: "{}",
      }),
    );
    const extraKey = await service.fetch(
      authorizedJsonRequest(`/runner/v1/agents/${AGENT_ID}/canary`, {
        operationId: "11111111-1111-4111-8111-111111111111",
        configRevision: "cfg-1",
        model: "openrouter/auto",
        prompt: "hostile override",
      }),
    );
    const oversized = await service.fetch(
      new Request(`http://runner.test/runner/v1/agents/${AGENT_ID}/canary`, {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
        },
        body: "x".repeat(64 * 1024 + 1),
      }),
    );
    const status = await service.fetch(authorizedRequest(`/runner/v1/agents/${AGENT_ID}/status`));

    expect(invalidContentType.status).toBe(415);
    expect(extraKey.status).toBe(400);
    expect(oversized.status).toBe(413);
    expect(canary).not.toHaveBeenCalled();
    expect(status.status).toBe(502);
    const statusBody = await status.json();
    expect(statusBody).toEqual({
      ok: false,
      error: { code: "runner_status_failed", message: "Runner status observation failed." },
    });
    expect(JSON.stringify(statusBody)).not.toContain("hostile-status-secret");
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

    expect("container" in result).toBe(true);
    if (!("container" in result)) {
      throw new Error("legacy restart did not return a container");
    }
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
  spec: AgentLaunchSpec,
  options: {
    apiServerKey?: string;
    marker?: Record<string, unknown>;
    signal?: AbortSignal;
  } = {},
) {
  if (options.signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  const agentRoot = process.env.AGENTBAY_HERMES_STATE_ROOT
    ? join(process.env.AGENTBAY_HERMES_STATE_ROOT, spec.agent.id)
    : join(tmpdir(), `agentbay-runner-projection-${Date.now()}-${Math.random()}`);
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
  if (options.apiServerKey) {
    await writeFile(join(hermesHome, ".env"), `API_SERVER_KEY="${options.apiServerKey}"\n`);
  }

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

async function withHermesStateRootForTest<T>(run: () => Promise<T>): Promise<T> {
  const previousStateRoot = process.env.AGENTBAY_HERMES_STATE_ROOT;
  const stateRoot = join(tmpdir(), `agentbay-runner-state-${Date.now()}-${Math.random()}`);

  try {
    process.env.AGENTBAY_HERMES_STATE_ROOT = stateRoot;
    return await run();
  } finally {
    if (previousStateRoot === undefined) {
      delete process.env.AGENTBAY_HERMES_STATE_ROOT;
    } else {
      process.env.AGENTBAY_HERMES_STATE_ROOT = previousStateRoot;
    }
    await rm(stateRoot, { force: true, recursive: true });
  }
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
      restartCount?: unknown;
      restartPolicy?: { MaximumRetryCount?: unknown; Name?: unknown } | null;
      runArgs?: readonly string[];
      status: string;
    }[];
    failRemoveIds?: string[];
    execProbeBody?: unknown;
    inspectEnv?: string[];
    imageInspectStdout?: () => string;
    inspectRestartCount?: () => unknown;
    inspectRestartPolicy?: () => { MaximumRetryCount?: unknown; Name?: unknown } | null | undefined;
    injectDockerSocket?: boolean;
    logs?: { stderr: string; stdout: string };
    psIds?: string[];
    removed?: (containerId: string) => void;
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
        restartCount: 0,
        runArgs: args,
        status: "running",
      });

      return { stdout: "container-001\n", stderr: "" };
    }

    if (args[0] === "image" && args[1] === "inspect") {
      return {
        stdout:
          input.imageInspectStdout?.() ??
          JSON.stringify({ imageId: MOCK_IMAGE_ID, repoDigests: [MOCK_REPO_DIGEST] }),
        stderr: "",
      };
    }

    if (args[0] === "inspect") {
      const id = String(args.at(-1));
      const container = containers.get(id);

      if (!container) {
        throw new Error(`missing container ${id}`);
      }
      const inspectedRestartPolicy = input.inspectRestartPolicy
        ? input.inspectRestartPolicy()
        : container.restartPolicy;

      return {
        stdout: JSON.stringify({
          Id: container.id,
          Image: MOCK_IMAGE_ID,
          RestartCount: input.inspectRestartCount
            ? input.inspectRestartCount()
            : container.restartCount,
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
          Name: `/${readArgValue(container.runArgs, "--name") ?? container.id}`,
          Config: {
            Cmd: readContainerCommandArgs(container.runArgs),
            Entrypoint: null,
            Env: input.inspectEnv ?? [],
            Image: container.image ?? "agentbay/runner:test",
            Labels: {
              [AGENTBAY_AGENT_ID_LABEL]: container.agentId,
              ...(container.labels ?? {}),
            },
          },
          HostConfig: {
            ...readRunHostConfig(container.runArgs),
            ...(inspectedRestartPolicy === null
              ? { RestartPolicy: undefined }
              : inspectedRestartPolicy
                ? { RestartPolicy: inspectedRestartPolicy }
                : {}),
          },
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
      const container = containers.get(String(args.at(-1)));

      if (container) {
        container.status = "exited";
      }

      return { stdout: "", stderr: "" };
    }

    if (args[0] === "rm") {
      const target = String(args.at(-1));
      const targetId =
        [...containers.values()].find(
          (container) => readArgValue(container.runArgs, "--name") === target,
        )?.id ?? target;

      if (input.failRemoveIds?.includes(targetId)) {
        throw new Error("cleanup failed");
      }

      containers.delete(targetId);
      input.removed?.(targetId);

      return { stdout: "", stderr: "" };
    }

    if (args[0] === "logs") {
      return {
        stdout: input.logs?.stdout ?? "2026-07-05T00:00:01.000000000Z ready\n",
        stderr: input.logs?.stderr ?? "2026-07-05T00:00:02.000000000Z warn\n",
      };
    }

    if (args[0] === "exec") {
      return {
        stdout: JSON.stringify({ status: 200, body: input.execProbeBody ?? pinnedHermesHealth() }),
        stderr: "",
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
  const restartPolicy = readArgValue(args, "--restart");

  return {
    Binds: [],
    CapDrop: readRepeatedArgValues(args, "--cap-drop"),
    CapAdd: readRepeatedArgValues(args, "--cap-add"),
    Memory: memory ? parseDockerMemoryBytesForTest(memory) : 0,
    NanoCpus: cpus ? Math.round(Number.parseFloat(cpus) * 1_000_000_000) : 0,
    NetworkMode: readArgValue(args, "--network") ?? "bridge",
    PidsLimit: pidsLimit ? Number.parseInt(pidsLimit, 10) : 0,
    PortBindings: {},
    RestartPolicy: restartPolicy ? { Name: restartPolicy, MaximumRetryCount: 0 } : undefined,
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
