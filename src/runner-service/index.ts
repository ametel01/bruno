import { createRunnerService } from "@/src/runner-service/server";
import { DEFAULT_HERMES_RUNNER_MAX_AGENTS } from "@/src/runner-service/constants";
import {
  createLocalAgentSmokeBootReadiness,
  createLocalAgentSmokeRunnerDocker,
} from "@/src/runner-service/local-agent-smoke";

type BunServerRuntime = {
  serve(input: {
    fetch(
      request: Request,
      server: {
        upgrade(
          request: Request,
          options: { data: { setupSessionId: string }; headers: Record<string, string> },
        ): boolean;
      },
    ): Response | Promise<Response | undefined> | undefined;
    hostname?: string;
    port: number;
    websocket: {
      open(socket: {
        data: { setupSessionId: string };
        send(data: string): number;
        close(code?: number, reason?: string): void;
      }): void;
      message(
        socket: {
          data: { setupSessionId: string };
          send(data: string): number;
          close(code?: number, reason?: string): void;
        },
        message: string | Buffer,
      ): void;
      close(socket: {
        data: { setupSessionId: string };
        send(data: string): number;
        close(code?: number, reason?: string): void;
      }): void;
    };
  }): {
    hostname: string;
    port: number;
    url?: URL;
  };
};

declare const Bun: BunServerRuntime;

const DEFAULT_RUNNER_PORT = 3045;
const RUNNER_HOST_ENV = "AGENTBAY_RUNNER_HOST";
const RUNNER_PORT_ENV = "AGENTBAY_RUNNER_PORT";
const RUNNER_HEARTBEAT_INTERVAL_ENV = "AGENTBAY_RUNNER_HEARTBEAT_INTERVAL_MS";
const RUNNER_MAX_AGENTS_ENV = "AGENTBAY_RUNNER_MAX_AGENTS";

const heartbeat = readHeartbeatOptions(process.env);
const localAgentSmokeDocker = createLocalAgentSmokeRunnerDocker(process.env);
const service = createRunnerService({
  ...(heartbeat ? { heartbeat } : {}),
  ...(localAgentSmokeDocker ? { docker: localAgentSmokeDocker } : {}),
  ...(localAgentSmokeDocker ? { readiness: createLocalAgentSmokeBootReadiness() } : {}),
});
const server = Bun.serve({
  hostname: process.env[RUNNER_HOST_ENV]?.trim() || "127.0.0.1",
  port: parsePort(process.env[RUNNER_PORT_ENV]),
  fetch: service.fetch,
  websocket: service.websocket,
});

console.log(
  `plingpling runner service listening on ${server.url?.href ?? `${server.hostname}:${server.port}`}`,
);

function parsePort(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RUNNER_PORT;
}

function readHeartbeatOptions(env: NodeJS.ProcessEnv) {
  const appBaseUrl = env.AGENTBAY_APP_URL?.trim();
  const runnerId = env.AGENTBAY_RUNNER_ID?.trim();
  const credential = env.AGENTBAY_RUNNER_CREDENTIAL?.trim();

  if (!appBaseUrl || !runnerId || !credential) {
    return undefined;
  }

  return {
    appBaseUrl,
    runnerId,
    credential,
    intervalMs: parsePositiveInteger(env[RUNNER_HEARTBEAT_INTERVAL_ENV], 30_000),
    maxAgents: parsePositiveInteger(env[RUNNER_MAX_AGENTS_ENV], DEFAULT_HERMES_RUNNER_MAX_AGENTS),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
