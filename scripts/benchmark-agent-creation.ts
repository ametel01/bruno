import { pathToFileURL } from "node:url";
import {
  buildAgentCreationLatencyReportForDatabase,
  type AgentCreationLatencyReport,
} from "@/src/server/agents/agent-creation-latency";
import { createDatabaseConnection } from "@/src/server/db/client";
import {
  LOCAL_AGENT_SMOKE_MODE_ENV,
  LOCAL_AGENT_SMOKE_MODE_VALUE,
} from "@/src/runner-service/local-agent-smoke";

const DIGITALOCEAN_AUTHORIZATION_SENTINEL = "authorize-digitalocean-agent-creation-benchmark";

type BenchmarkMode = "existing" | "local_docker" | "digitalocean";

type BenchmarkOptions = {
  mode: BenchmarkMode;
  limit: number;
  deploymentId?: string;
  trials: number;
  providerAuthorized: boolean;
};

export async function runAgentCreationBenchmark(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<AgentCreationLatencyReport> {
  const options = parseBenchmarkOptions(argv);

  if (options.mode === "digitalocean") {
    assertDigitalOceanBenchmarkAuthorized(options, env);
    throw new Error(
      "DigitalOcean trial execution is reserved for the provider-backed SLO proof step and is not implemented by the read-only benchmark.",
    );
  }

  if (options.mode === "local_docker") {
    assertLocalDockerBenchmarkIsolation(env);
  }

  const connection = createDatabaseConnection();
  try {
    return await buildAgentCreationLatencyReportForDatabase(connection, {
      limit: options.limit,
      ...(options.deploymentId ? { deploymentId: options.deploymentId } : {}),
    });
  } finally {
    await connection.close();
  }
}

export function parseBenchmarkOptions(argv: readonly string[]): BenchmarkOptions {
  let mode: BenchmarkMode = "existing";
  let limit = 100;
  let deploymentId: string | undefined;
  let trials = 0;
  let providerAuthorized = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      mode = parseMode(readRequiredValue(argv, index));
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = readPositiveInteger(readRequiredValue(argv, index), "--limit");
      index += 1;
      continue;
    }
    if (arg === "--deployment-id") {
      deploymentId = readRequiredValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--trials") {
      trials = readPositiveInteger(readRequiredValue(argv, index), "--trials");
      index += 1;
      continue;
    }
    if (arg === "--authorize-provider-costs") {
      providerAuthorized = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`Unknown agent creation benchmark argument: ${arg ?? ""}\n${usage()}`);
  }

  return {
    mode,
    limit,
    ...(deploymentId ? { deploymentId } : {}),
    trials,
    providerAuthorized,
  };
}

function assertDigitalOceanBenchmarkAuthorized(
  options: BenchmarkOptions,
  env: Record<string, string | undefined>,
): void {
  if (
    options.trials <= 0 ||
    !options.providerAuthorized ||
    env.AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION !==
      DIGITALOCEAN_AUTHORIZATION_SENTINEL
  ) {
    throw new Error(
      `DigitalOcean benchmark mode is fail-closed. It requires --trials N, --authorize-provider-costs, and AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=${DIGITALOCEAN_AUTHORIZATION_SENTINEL}.`,
    );
  }
}

function assertLocalDockerBenchmarkIsolation(env: Record<string, string | undefined>): void {
  if (
    env.AGENTBAY_DIGITALOCEAN_PROVIDER_MODE !== "local_docker" ||
    env.AGENTBAY_DIGITALOCEAN_TOKEN !== "local-docker" ||
    env[LOCAL_AGENT_SMOKE_MODE_ENV] !== LOCAL_AGENT_SMOKE_MODE_VALUE
  ) {
    throw new Error(
      "Local Docker benchmark mode requires the exact local_docker provider, local-docker token, and synthetic local boundary sentinel.",
    );
  }
}

function parseMode(value: string): BenchmarkMode {
  if (value === "existing" || value === "local_docker" || value === "digitalocean") {
    return value;
  }
  throw new Error(`Unsupported benchmark mode: ${value}\n${usage()}`);
}

function readRequiredValue(argv: readonly string[], index: number): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${argv[index] ?? "argument"}.\n${usage()}`);
  }
  return value;
}

function readPositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function usage(): string {
  return [
    "Usage: bun --conditions react-server scripts/benchmark-agent-creation.ts [--mode existing|local_docker|digitalocean] [--limit N] [--deployment-id UUID]",
    "Default mode is read-only existing-run reporting. DigitalOcean mode is fail-closed and not used by ordinary CI.",
  ].join("\n");
}

async function main(): Promise<void> {
  const report = await runAgentCreationBenchmark(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
