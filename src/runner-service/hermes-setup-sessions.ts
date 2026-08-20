import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import {
  BRUNO_AGENT_ID_LABEL,
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import { prepareHermesState } from "@/src/runner-service/hermes-projection";

const execFileAsync = promisify(execFile);
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1_000;
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const SETUP_SESSION_LABEL = "bruno.hermes_setup_session";
const SETUP_PROTOCOL_PREFIX = "bruno.hermes.setup.";
const SETUP_COMMAND = [
  "hermes setup &&",
  "hermes config set terminal.cwd /workspace &&",
  "hermes config set browser.enabled false &&",
  "hermes config set tool_loop_guardrails.hard_stop_enabled true &&",
  "hermes config set tool_loop_guardrails.hard_stop_after.exact_failure 5 &&",
  "hermes config set tool_loop_guardrails.hard_stop_after.idempotent_no_progress 5",
].join("\n");

type SetupSocket = {
  send(data: string): number;
  close(code?: number, reason?: string): void;
};

type SetupTerminal = {
  write(data: string | Uint8Array): number;
  resize(cols: number, rows: number): void;
  close(): void;
};

type SetupProcess = {
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
  terminal: SetupTerminal;
};

type SetupSpawn = (
  command: string[],
  options: {
    env: Record<string, string | undefined>;
    terminal: {
      cols: number;
      rows: number;
      data(terminal: SetupTerminal, data: Uint8Array): void;
    };
  },
) => SetupProcess;

type DockerExec = (args: readonly string[]) => Promise<{ stdout: string }>;

type SetupSession = {
  agentId: string;
  containerName: string;
  createdAt: number;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  hermesHome: string;
  id: string;
  process: SetupProcess | null;
  socket: SetupSocket | null;
  tokenHash: Buffer;
  used: boolean;
  workspace: string;
};

export type HermesSetupSessionDescriptor = {
  id: string;
  websocketPath: string;
  websocketProtocol: string;
  expiresAt: string;
};

export type HermesSetupWebSocketData = {
  setupSessionId: string;
};

export type HermesSetupSessionManagerOptions = {
  docker?: DockerExec;
  dockerExecutable?: string;
  image?: string;
  network?: string;
  now?: () => number;
  sessionTtlMs?: number;
  spawn?: SetupSpawn;
  stateRoot?: string;
};

export class HermesSetupSessionManager {
  readonly #docker: DockerExec;
  readonly #dockerExecutable: string;
  readonly #image: string;
  readonly #network: string;
  readonly #now: () => number;
  readonly #sessionTtlMs: number;
  readonly #sessions = new Map<string, SetupSession>();
  readonly #spawn: SetupSpawn;
  readonly #stateRoot: string;

  constructor(options: HermesSetupSessionManagerOptions = {}) {
    this.#dockerExecutable = options.dockerExecutable ?? "docker";
    this.#docker = options.docker ?? createDockerExec(this.#dockerExecutable);
    this.#image =
      options.image ??
      process.env.BRUNO_HERMES_WORKLOAD_IMAGE?.trim() ??
      DEFAULT_HERMES_WORKLOAD_IMAGE;
    this.#network =
      options.network ??
      process.env.BRUNO_HERMES_PRIVATE_NETWORK?.trim() ??
      DEFAULT_HERMES_PRIVATE_NETWORK;
    this.#now = options.now ?? Date.now;
    this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#stateRoot =
      options.stateRoot ?? process.env.BRUNO_HERMES_STATE_ROOT?.trim() ?? DEFAULT_HERMES_STATE_ROOT;
  }

  async create(agentId: string): Promise<HermesSetupSessionDescriptor> {
    await this.#pruneExpired();

    if ([...this.#sessions.values()].some((session) => this.#now() < session.expiresAt)) {
      throw new HermesSetupSessionError("setup_session_active");
    }

    const running = await this.#docker([
      "ps",
      "--quiet",
      "--filter",
      `label=${BRUNO_AGENT_ID_LABEL}=${agentId}`,
      "--filter",
      "status=running",
    ]);

    if (running.stdout.trim()) {
      throw new HermesSetupSessionError("agent_running");
    }

    const state = await prepareHermesState(agentId, { stateRoot: this.#stateRoot });
    const id = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.#now();
    const expiresAt = createdAt + this.#sessionTtlMs;
    const protocol = `${SETUP_PROTOCOL_PREFIX}${token}`;
    const session: SetupSession = {
      agentId,
      containerName: `bruno-hermes-setup-${id.replaceAll("-", "").slice(0, 20)}`,
      createdAt,
      expiresAt,
      expiryTimer: null,
      hermesHome: state.hermesHome,
      id,
      process: null,
      socket: null,
      tokenHash: hashToken(token),
      used: false,
      workspace: state.workspace,
    };

    this.#sessions.set(id, session);

    return {
      id,
      websocketPath: `/runner/v1/hermes-setup-sessions/${encodeURIComponent(id)}`,
      websocketProtocol: protocol,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  authorizeUpgrade(
    request: Request,
  ): { ok: true; data: HermesSetupWebSocketData; protocol: string } | { ok: false } {
    void this.#pruneExpired();
    const sessionId = parseSetupSessionPath(new URL(request.url).pathname);
    const requestedProtocol = readSetupProtocol(request.headers.get("sec-websocket-protocol"));
    const session = sessionId ? this.#sessions.get(sessionId) : null;

    if (
      !session ||
      session.used ||
      this.#now() >= session.expiresAt ||
      !requestedProtocol ||
      !tokenMatches(session.tokenHash, requestedProtocol.slice(SETUP_PROTOCOL_PREFIX.length))
    ) {
      return { ok: false };
    }

    session.used = true;
    return {
      ok: true,
      data: { setupSessionId: session.id },
      protocol: requestedProtocol,
    };
  }

  open(sessionId: string, socket: SetupSocket): void {
    const session = this.#sessions.get(sessionId);

    if (!session || session.socket || this.#now() >= session.expiresAt) {
      socket.close(4401, "Setup session expired.");
      if (session && this.#now() >= session.expiresAt) {
        void this.#cleanup(session.id);
      }
      return;
    }

    session.socket = socket;
    const expiryTimer = setTimeout(
      () => this.#expire(session.id),
      Math.max(0, session.expiresAt - this.#now()),
    );
    expiryTimer.unref?.();
    session.expiryTimer = expiryTimer;
    sendSocketMessage(socket, { type: "status", status: "starting" });

    try {
      const process = this.#spawn(this.#buildDockerCommand(session), {
        env: { ...processEnv(), TERM: "xterm-256color" },
        terminal: {
          cols: 100,
          rows: 30,
          data: (_terminal, data) => {
            if (session.socket) {
              sendSocketMessage(session.socket, {
                type: "output",
                data: Buffer.from(data).toString("base64"),
              });
            }
          },
        },
      });
      session.process = process;
      sendSocketMessage(socket, { type: "status", status: "running" });
      void process.exited.then((exitCode) => this.#finish(session.id, exitCode));
    } catch {
      sendSocketMessage(socket, { type: "status", status: "failed" });
      socket.close(1011, "Hermes setup could not start.");
      void this.#cleanup(session.id);
    }
  }

  message(sessionId: string, rawMessage: string | Buffer): void {
    const session = this.#sessions.get(sessionId);

    if (
      !session?.process ||
      this.#now() >= (session?.expiresAt ?? 0) ||
      Buffer.byteLength(rawMessage) > MAX_CLIENT_MESSAGE_BYTES
    ) {
      session?.socket?.close(1008, "Invalid setup message.");
      if (session && this.#now() >= session.expiresAt) {
        void this.#cleanup(session.id);
      }
      return;
    }

    let message: unknown;

    try {
      message = JSON.parse(rawMessage.toString());
    } catch {
      session.socket?.close(1008, "Invalid setup message.");
      return;
    }

    if (!isRecord(message) || typeof message.type !== "string") {
      session.socket?.close(1008, "Invalid setup message.");
      return;
    }

    if (message.type === "input" && typeof message.data === "string") {
      session.process.terminal.write(message.data);
      return;
    }

    if (
      message.type === "resize" &&
      isBoundedInteger(message.cols, 20, 400) &&
      isBoundedInteger(message.rows, 5, 200)
    ) {
      session.process.terminal.resize(message.cols, message.rows);
      return;
    }

    session.socket?.close(1008, "Invalid setup message.");
  }

  close(sessionId: string): void {
    void this.#cleanup(sessionId);
  }

  #buildDockerCommand(session: SetupSession): string[] {
    return [
      this.#dockerExecutable,
      "run",
      "--rm",
      "--interactive",
      "--tty",
      "--name",
      session.containerName,
      "--label",
      `${BRUNO_AGENT_ID_LABEL}=${session.agentId}`,
      "--label",
      `${SETUP_SESSION_LABEL}=${session.id}`,
      "--network",
      this.#network,
      "--mount",
      `type=bind,source=${session.hermesHome},target=/opt/data`,
      "--mount",
      `type=bind,source=${session.workspace},target=/workspace`,
      "--cpus",
      "1",
      "--memory",
      "1536m",
      "--pids-limit",
      "256",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--cap-add",
      "SETGID",
      "--cap-add",
      "SETUID",
      this.#image,
      "sh",
      "-lc",
      SETUP_COMMAND,
    ];
  }

  async #finish(sessionId: string, exitCode: number): Promise<void> {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (session.socket) {
      try {
        sendSocketMessage(session.socket, {
          type: "status",
          status: exitCode === 0 ? "completed" : "failed",
          exitCode,
        });
        session.socket.close(exitCode === 0 ? 1000 : 1011, "Hermes setup finished.");
      } catch {
        // Cleanup still runs when the browser disconnects during process exit.
      } finally {
        await this.#cleanup(sessionId, false);
      }

      return;
    }

    await this.#cleanup(sessionId, false);
  }

  #expire(sessionId: string): void {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      return;
    }

    if (session.socket) {
      try {
        sendSocketMessage(session.socket, { type: "status", status: "expired" });
        session.socket.close(4408, "Hermes setup session expired.");
      } catch {
        // Cleanup still runs when the browser disconnects at expiration.
      } finally {
        void this.#cleanup(sessionId);
      }

      return;
    }

    void this.#cleanup(sessionId);
  }

  async #cleanup(sessionId: string, killProcess = true): Promise<void> {
    const session = this.#sessions.get(sessionId);

    if (!session) {
      return;
    }

    this.#sessions.delete(sessionId);
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
    }

    if (killProcess && session.process) {
      try {
        session.process.kill("SIGTERM");
      } catch {
        // The setup process may have exited between the state check and cleanup.
      }
    }

    try {
      session.process?.terminal.close();
    } catch {
      // Docker removal below is the authoritative cleanup fallback.
    }
    await this.#docker(["rm", "--force", session.containerName]).catch(() => undefined);
  }

  async #pruneExpired(): Promise<void> {
    const now = this.#now();
    await Promise.all(
      [...this.#sessions].flatMap(([sessionId, session]) =>
        now >= session.expiresAt ? [this.#cleanup(sessionId)] : [],
      ),
    );
  }
}

export class HermesSetupSessionError extends Error {
  constructor(readonly reason: "agent_running" | "setup_session_active") {
    super(reason);
    this.name = "HermesSetupSessionError";
  }
}

function defaultSpawn(command: string[], options: Parameters<SetupSpawn>[1]): SetupProcess {
  return Bun.spawn(command, options) as SetupProcess;
}

function createDockerExec(executable: string): DockerExec {
  return async (args) => {
    const result = await execFileAsync(executable, [...args], {
      encoding: "utf8",
      timeout: 30_000,
    });

    return { stdout: result.stdout };
  };
}

function parseSetupSessionPath(pathname: string): string | null {
  const match = /^\/runner\/v1\/hermes-setup-sessions\/([0-9a-f-]+)$/i.exec(pathname);

  return match?.[1] ?? null;
}

function readSetupProtocol(value: string | null): string | null {
  const protocols = (value ?? "")
    .split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);

  return protocols.find((protocol) => protocol.startsWith(SETUP_PROTOCOL_PREFIX)) ?? null;
}

function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

function tokenMatches(expectedHash: Buffer, token: string): boolean {
  const candidateHash = hashToken(token);

  return (
    candidateHash.length === expectedHash.length && timingSafeEqual(candidateHash, expectedHash)
  );
}

function sendSocketMessage(socket: SetupSocket, message: Record<string, unknown>): void {
  socket.send(JSON.stringify(message));
}

function isBoundedInteger(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function processEnv(): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const key of [
    "PATH",
    "HOME",
    "TMPDIR",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "XDG_RUNTIME_DIR",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

declare const Bun: {
  spawn(command: string[], options: Parameters<SetupSpawn>[1]): unknown;
};
