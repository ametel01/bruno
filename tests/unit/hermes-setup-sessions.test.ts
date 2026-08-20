import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesSetupSessionManager } from "@/src/runner-service/hermes-setup-sessions";
import { createRunnerService } from "@/src/runner-service/server";
import { readyRunnerBootController } from "@/tests/helpers/runner-boot";

const AGENT_ID = "00000000-0000-4000-8000-000000000123";

describe("Hermes setup sessions", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(
      tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("terminates an active PTY when its short-lived session expires", async () => {
    vi.useFakeTimers();
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const dockerCalls: string[][] = [];
    const processKill = vi.fn();
    const terminalClose = vi.fn();
    const manager = new HermesSetupSessionManager({
      stateRoot,
      sessionTtlMs: 1_000,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "" };
      },
      spawn: () => ({
        exited: new Promise<number>(() => undefined),
        kill: processKill,
        terminal: {
          write: () => 0,
          resize: () => undefined,
          close: terminalClose,
        },
      }),
    });
    const descriptor = await manager.create(AGENT_ID);
    const authorized = manager.authorizeUpgrade(
      new Request(`https://runner.test${descriptor.websocketPath}`, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": descriptor.websocketProtocol,
        },
      }),
    );
    expect(authorized.ok).toBe(true);
    const socket = { send: vi.fn(() => 1), close: vi.fn() };
    manager.open(descriptor.id, socket);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "status", status: "expired" }));
    expect(socket.close).toHaveBeenCalledWith(4408, "Hermes setup session expired.");
    expect(processKill).toHaveBeenCalledWith("SIGTERM");
    expect(terminalClose).toHaveBeenCalled();
    expect(dockerCalls).toContainEqual([
      "rm",
      "--force",
      expect.stringMatching(/^bruno-hermes-setup-/),
    ]);
  });

  it("rejects an upgrade after expiry even when no websocket has opened", async () => {
    vi.useFakeTimers();
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const manager = new HermesSetupSessionManager({
      stateRoot,
      sessionTtlMs: 1_000,
      docker: async () => ({ stdout: "" }),
    });
    const descriptor = await manager.create(AGENT_ID);
    await vi.advanceTimersByTimeAsync(1_001);

    expect(
      manager.authorizeUpgrade(
        new Request(`https://runner.test${descriptor.websocketPath}`, {
          headers: { "Sec-WebSocket-Protocol": descriptor.websocketProtocol },
        }),
      ),
    ).toEqual({ ok: false });
    await expect(manager.create(AGENT_ID)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("issues a one-time websocket protocol and streams a real PTY contract", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const dockerCalls: string[][] = [];
    const spawnCalls: string[][] = [];
    const spawnEnvironments: Array<Record<string, string | undefined>> = [];
    const terminalWrites: string[] = [];
    const terminalResizes: Array<[number, number]> = [];
    const terminalClose = vi.fn();
    const processKill = vi.fn();
    let resolveExit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    let emitTerminalData: ((data: Uint8Array) => void) | undefined;
    const manager = new HermesSetupSessionManager({
      stateRoot,
      image: "bruno-hermes:test",
      network: "bruno-hermes-test",
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "" };
      },
      spawn: (command, options) => {
        spawnCalls.push(command);
        spawnEnvironments.push(options.env);
        const terminal = {
          write(data: string | Uint8Array) {
            terminalWrites.push(String(data));
            return String(data).length;
          },
          resize(cols: number, rows: number) {
            terminalResizes.push([cols, rows]);
          },
          close: terminalClose,
        };
        emitTerminalData = (data) => options.terminal.data(terminal, data);
        return { exited, kill: processKill, terminal };
      },
    });

    const descriptor = await manager.create(AGENT_ID);
    const request = new Request(`https://runner.test${descriptor.websocketPath}`, {
      headers: {
        Upgrade: "websocket",
        "Sec-WebSocket-Protocol": descriptor.websocketProtocol,
      },
    });
    const authorized = manager.authorizeUpgrade(request);

    expect(authorized).toEqual({
      ok: true,
      data: { setupSessionId: descriptor.id },
      protocol: descriptor.websocketProtocol,
    });
    expect(manager.authorizeUpgrade(request)).toEqual({ ok: false });

    const sent: string[] = [];
    const socket = {
      send(message: string) {
        sent.push(message);
        return message.length;
      },
      close: vi.fn(),
    };
    manager.open(descriptor.id, socket);
    manager.message(descriptor.id, JSON.stringify({ type: "input", data: "\r" }));
    manager.message(descriptor.id, JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    expect(emitTerminalData).toBeTypeOf("function");
    emitTerminalData?.(new TextEncoder().encode("Hermes setup\r\n"));

    expect(spawnCalls[0]).toEqual(
      expect.arrayContaining([
        "docker",
        "run",
        "--interactive",
        "--tty",
        "--network",
        "bruno-hermes-test",
        "bruno-hermes:test",
        "sh",
        "-lc",
        expect.stringContaining("hermes setup"),
      ]),
    );
    expect(JSON.stringify(spawnCalls)).not.toContain(descriptor.websocketProtocol);
    expect(spawnEnvironments[0]).not.toHaveProperty("BRUNO_RUNNER_BEARER_TOKEN");
    expect(spawnEnvironments[0]).not.toHaveProperty("DATABASE_URL");
    expect(terminalWrites).toEqual(["\r"]);
    expect(terminalResizes).toEqual([[120, 40]]);
    expect(sent.map((message) => JSON.parse(message))).toEqual(
      expect.arrayContaining([
        { type: "status", status: "starting" },
        { type: "status", status: "running" },
        {
          type: "output",
          data: Buffer.from("Hermes setup\r\n").toString("base64"),
        },
      ]),
    );

    resolveExit(0);
    await exited;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(socket.close).toHaveBeenCalledWith(1000, "Hermes setup finished.");
    expect(terminalClose).toHaveBeenCalled();
    expect(dockerCalls).toContainEqual([
      "rm",
      "--force",
      expect.stringMatching(/^bruno-hermes-setup-/),
    ]);
  });

  it("rejects concurrent setup and setup while the agent workload is running", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const manager = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "" }),
    });

    await manager.create(AGENT_ID);
    await expect(manager.create(AGENT_ID)).rejects.toMatchObject({
      reason: "setup_session_active",
    });

    const runningManager = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "running-container-id\n" }),
    });
    await expect(runningManager.create(AGENT_ID)).rejects.toMatchObject({
      reason: "agent_running",
    });
  });

  it("reuses the persistent Hermes home after the runner service restarts", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const first = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "" }),
    });
    await first.create(AGENT_ID);
    const configPath = join(stateRoot, AGENT_ID, "hermes", "config.yaml");
    await writeFile(configPath, "model:\n  provider: hermes\n  default: founder-choice\n");

    const restarted = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "" }),
    });
    await restarted.create(AGENT_ID);

    await expect(readFile(configPath, "utf8")).resolves.toContain("founder-choice");
  });

  it("keeps the one-time transport token out of the persistent Hermes home", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const manager = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "" }),
    });
    const descriptor = await manager.create(AGENT_ID);
    const persistedConfig = join(stateRoot, AGENT_ID, "hermes", "config.yaml");
    await writeFile(persistedConfig, "model:\n  provider: hermes\n");

    await expect(readFile(persistedConfig, "utf8")).resolves.not.toContain(
      descriptor.websocketProtocol,
    );
  });

  it("exposes authenticated session creation and upgrades without the runner bearer token", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-setup-"));
    tempRoots.push(stateRoot);
    const setupSessions = new HermesSetupSessionManager({
      stateRoot,
      docker: async () => ({ stdout: "" }),
    });
    const service = createRunnerService({
      readiness: readyRunnerBootController(),
      authToken: "runner-secret",
      setupSessions,
      docker: createNoopDocker(),
    });
    const unauthorized = await service.fetch(
      new Request(`https://runner.test/runner/v1/agents/${AGENT_ID}/setup-sessions`, {
        method: "POST",
      }),
    );
    const created = await service.fetch(
      new Request(`https://runner.test/runner/v1/agents/${AGENT_ID}/setup-sessions`, {
        method: "POST",
        headers: { Authorization: "Bearer runner-secret" },
      }),
    );

    expect(unauthorized.status).toBe(401);
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      session: { websocketPath: string; websocketProtocol: string };
    };
    const upgrade = vi.fn(() => true);
    const upgraded = await service.fetch(
      new Request(`https://runner.test${body.session.websocketPath}`, {
        headers: {
          Upgrade: "websocket",
          "Sec-WebSocket-Protocol": body.session.websocketProtocol,
        },
      }),
      { upgrade },
    );

    expect(upgraded).toBeUndefined();
    expect(upgrade).toHaveBeenCalledWith(
      expect.any(Request),
      expect.objectContaining({
        data: { setupSessionId: expect.any(String) },
        headers: { "Sec-WebSocket-Protocol": body.session.websocketProtocol },
      }),
    );
  });
});

function createNoopDocker() {
  const container = {
    id: "container-id",
    name: "container-name",
    image: "bruno-hermes:test",
    status: "running",
    startedAt: null,
    finishedAt: null,
  };

  return {
    start: async () => ({ container, projection: null }),
    stop: async () => ({ containers: [] }),
    restart: async () => ({ container, projection: null }),
    status: async () => ({ containers: [] }),
    logs: async () => ({ container: null, logs: [] }),
    cleanup: async () => ({ containers: [], removedAgentRoot: false }),
  };
}
