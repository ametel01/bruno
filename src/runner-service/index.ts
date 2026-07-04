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
const RUNNER_HOST_ENV = "AGENTBAY_RUNNER_HOST";
const RUNNER_PORT_ENV = "AGENTBAY_RUNNER_PORT";

const service = createRunnerService();
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
