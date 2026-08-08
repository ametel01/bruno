import { pathToFileURL } from "node:url";
import {
  buildAgentDeploymentLatencyReportForDatabase,
  type AgentDeploymentLatencyReport,
} from "@/src/server/agents/agent-deployment-latency";
import {
  buildProviderTrialCohortReport,
  type ProviderTrialCohortReport,
} from "@/src/server/agents/provider-trial-cohort";
import { createDatabaseConnection } from "@/src/server/db/client";
import {
  LOCAL_AGENT_SMOKE_MODE_ENV,
  LOCAL_AGENT_SMOKE_MODE_VALUE,
} from "@/src/runner-service/local-agent-smoke";
import { findDigitalOceanRunnerResourceProfile } from "@/src/server/runners/runner-resource-profiles";

const DIGITALOCEAN_AUTHORIZATION_SENTINEL = "authorize-digitalocean-agent-deployment-benchmark";
const MAX_REPORT_LIMIT = 1_000;
const MAX_PROVIDER_TRIALS = 30;

type BenchmarkMode = "existing" | "local_docker" | "digitalocean";

type BenchmarkOptions = {
  mode: BenchmarkMode;
  limit: number;
  deploymentId?: string;
  providerTrialCohortId?: string;
  trials: number;
  providerAuthorized: boolean;
  candidateSizeSlugs: string[];
};

export async function runAgentDeploymentBenchmark(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): Promise<AgentDeploymentLatencyReport | ProviderTrialCohortReport> {
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
    if (options.providerTrialCohortId) {
      return await buildProviderTrialCohortReport(connection, options.providerTrialCohortId);
    }
    return await buildAgentDeploymentLatencyReportForDatabase(connection, {
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
  let providerTrialCohortId: string | undefined;
  let trials = 0;
  let providerAuthorized = false;
  let candidateSizeSlugs: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      mode = parseMode(readRequiredValue(argv, index));
      index += 1;
      continue;
    }
    if (arg === "--limit") {
      limit = readBoundedPositiveInteger(
        readRequiredValue(argv, index),
        "--limit",
        MAX_REPORT_LIMIT,
      );
      index += 1;
      continue;
    }
    if (arg === "--deployment-id") {
      deploymentId = readRequiredValue(argv, index);
      index += 1;
      continue;
    }
    if (arg === "--provider-trial-cohort-id") {
      providerTrialCohortId = readUuid(readRequiredValue(argv, index), arg);
      index += 1;
      continue;
    }
    if (arg === "--trials") {
      trials = readBoundedPositiveInteger(
        readRequiredValue(argv, index),
        "--trials",
        MAX_PROVIDER_TRIALS,
      );
      index += 1;
      continue;
    }
    if (arg === "--authorize-provider-costs") {
      providerAuthorized = true;
      continue;
    }
    if (arg === "--candidate-size-slugs") {
      candidateSizeSlugs = readCandidateSizeSlugs(readRequiredValue(argv, index));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    throw new Error(`Unknown Agent Deployment benchmark argument: ${arg ?? ""}\n${usage()}`);
  }

  if (providerTrialCohortId && (mode !== "existing" || deploymentId)) {
    throw new Error(
      "--provider-trial-cohort-id is an existing-ledger report and cannot be combined with provider execution or --deployment-id.",
    );
  }

  return {
    mode,
    limit,
    ...(deploymentId ? { deploymentId } : {}),
    ...(providerTrialCohortId ? { providerTrialCohortId } : {}),
    trials,
    providerAuthorized,
    candidateSizeSlugs,
  };
}

function assertDigitalOceanBenchmarkAuthorized(
  options: BenchmarkOptions,
  env: Record<string, string | undefined>,
): void {
  if (
    options.trials <= 0 ||
    !options.providerAuthorized ||
    options.candidateSizeSlugs.length === 0 ||
    env.BRUNO_AGENT_DEPLOYMENT_BENCHMARK_DIGITALOCEAN_AUTHORIZATION !==
      DIGITALOCEAN_AUTHORIZATION_SENTINEL
  ) {
    throw new Error(
      `DigitalOcean benchmark mode is fail-closed. It requires --trials N, --authorize-provider-costs, --candidate-size-slugs slug[,slug], and BRUNO_AGENT_DEPLOYMENT_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=${DIGITALOCEAN_AUTHORIZATION_SENTINEL}.`,
    );
  }
}

function assertLocalDockerBenchmarkIsolation(env: Record<string, string | undefined>): void {
  if (
    env.BRUNO_DIGITALOCEAN_PROVIDER_MODE !== "local_docker" ||
    env.BRUNO_DIGITALOCEAN_TOKEN !== "local-docker" ||
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

function readBoundedPositiveInteger(value: string, label: string, max: number): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${label} must be an exact positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new Error(`${label} must be a positive integer no greater than ${max}.`);
  }
  return parsed;
}

function readCandidateSizeSlugs(value: string): string[] {
  const slugs = value
    .split(",")
    .map((slug) => slug.trim())
    .filter(Boolean);

  if (slugs.length === 0 || slugs.length > 4) {
    throw new Error("--candidate-size-slugs must include 1 to 4 explicit supported size slugs.");
  }

  const unique = [...new Set(slugs)];
  if (unique.length !== slugs.length) {
    throw new Error("--candidate-size-slugs must not include duplicate size slugs.");
  }

  const unknown = unique.find((slug) => !findDigitalOceanRunnerResourceProfile(slug));
  if (unknown) {
    throw new Error(`Unsupported candidate DigitalOcean size slug: ${unknown}.`);
  }

  return unique.sort();
}

function readUuid(value: string, label: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function usage(): string {
  return [
    "Usage: bun --conditions react-server scripts/benchmark-agent-deployment.ts [--mode existing|local_docker|digitalocean] [--limit N] [--deployment-id UUID] [--provider-trial-cohort-id UUID] [--candidate-size-slugs slug[,slug]]",
    "Default mode is read-only existing-run reporting. An exact Provider Trial Cohort ledger can be reported by ID. DigitalOcean mode is fail-closed, requires explicit candidate size slugs, and is not used by ordinary CI.",
  ].join("\n");
}

async function main(): Promise<void> {
  const report = await runAgentDeploymentBenchmark(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
