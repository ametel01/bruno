import { describe, expect, it } from "vitest";
import {
  AGENTBAY_AGENT_ID_LABEL,
  ManualRunnerDocker,
  type DockerExecutableRunner,
} from "@/src/runner-service/docker";
import { createRunnerService } from "@/src/runner-service/server";

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
    expect(calls).toContainEqual(["stop", "selected-running"]);
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

function testCommand() {
  return {
    image: "agentbay/runner:test",
    args: ["agentbay-runner", "--serve"],
  };
}

function createMockDocker(
  input: {
    calls?: string[][];
    containers?: { agentId: string; id: string; status: string }[];
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
          Name: `/${container.id}`,
          Config: {
            Image: "agentbay/runner:test",
            Labels: {
              [AGENTBAY_AGENT_ID_LABEL]: container.agentId,
            },
          },
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
      containers.delete(String(args.at(-1)));

      return { stdout: "", stderr: "" };
    }

    if (args[0] === "logs") {
      return {
        stdout: "2026-07-05T00:00:01.000000000Z ready\n",
        stderr: "2026-07-05T00:00:02.000000000Z warn\n",
      };
    }

    throw new Error(`unexpected docker args: ${args.join(" ")}`);
  };
}

function readLabelAgentId(args: readonly string[]): string {
  const label = String(args[args.indexOf("--label") + 1]);

  return label.split(`${AGENTBAY_AGENT_ID_LABEL}=`)[1] ?? "";
}
