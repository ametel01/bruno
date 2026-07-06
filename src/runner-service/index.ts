import { createRunnerService } from "@/src/runner-service/server";

type BunServerRuntime = {
  serve(input: {
    fetch(request: Request): Response | Promise<Response>;
    hostname?: string;
    port: number;
  }): {
    hostname: string;
    port: number;
    url?: URL;
  };
};

declare const Bun: BunServerRuntime;

const DEFAULT_RUNNER_PORT = 3045;
const DEFAULT_RUNNER_MAX_AGENTS = 3;
const RUNNER_HOST_ENV = "AGENTBAY_RUNNER_HOST";
const RUNNER_PORT_ENV = "AGENTBAY_RUNNER_PORT";
const RUNNER_HEARTBEAT_INTERVAL_ENV = "AGENTBAY_RUNNER_HEARTBEAT_INTERVAL_MS";
const RUNNER_MAX_AGENTS_ENV = "AGENTBAY_RUNNER_MAX_AGENTS";

const heartbeat = readHeartbeatOptions(process.env);
const service = createRunnerService(heartbeat ? { heartbeat } : {});
const server = Bun.serve({
  hostname: process.env[RUNNER_HOST_ENV]?.trim() || "127.0.0.1",
  port: parsePort(process.env[RUNNER_PORT_ENV]),
  fetch: service.fetch,
});

console.log(
  `AgentBay runner service listening on ${server.url?.href ?? `${server.hostname}:${server.port}`}`,
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
    maxAgents: parsePositiveInteger(env[RUNNER_MAX_AGENTS_ENV], DEFAULT_RUNNER_MAX_AGENTS),
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
