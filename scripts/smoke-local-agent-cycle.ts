import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import {
  DEFAULT_LOCAL_HERMES_IMAGE,
  HERMES_VERSION_FRAGMENT,
} from "@/scripts/smoke-hermes-agent-image";
import {
  LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER,
  LOCAL_AGENT_SMOKE_MODE_ENV,
  LOCAL_AGENT_SMOKE_MODE_VALUE,
} from "@/src/runner-service/local-agent-smoke";
import { evaluateHermesReadyResponse } from "@/src/runner-service/docker";
import { reconcileTargetAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { buildHermesAgentLaunchSpecForUser } from "@/src/server/agents/agent-launch-builder";
import { reconcileTargetAgentRuntime } from "@/src/server/agents/agent-runtime-reconciler";
import { createAgentForUser } from "@/src/server/agents/create-agent";
import {
  deleteAgentForUser,
  restartAgentForUser,
  stopAgentForUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentRuntimeReconciliations,
  agentSecrets,
  agents,
  runnerCredentials,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
import { LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID } from "@/src/server/runners/local-docker-provider-constants";
import {
  LOCAL_AGENT_SMOKE_DROPLET_IMAGE,
  LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH,
  LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
} from "@/src/server/runners/local-docker-digitalocean-provider";
import { ManualRunnerAdapter } from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import { createConfiguredDigitalOceanProvider } from "@/src/server/runners/runner-provisioning";

const COMPOSE_PROJECT = "agentbay-agent-smoke";
const DASHBOARD_CONTAINER = `${COMPOSE_PROJECT}-dashboard-1`;
const DATABASE_URL = "postgres://agentbay:agentbay@127.0.0.1:55432/plingpling";
const APP_URL = "http://host.docker.internal:3000";
const RUNNER_ENDPOINT_URL = "http://host.docker.internal:3045";
const TIMEOUT_MS = readPositiveInteger(
  process.env.AGENTBAY_LOCAL_AGENT_CYCLE_TIMEOUT_MS,
  12 * 60_000,
);
const POLL_MS = readPositiveInteger(process.env.AGENTBAY_LOCAL_AGENT_CYCLE_POLL_MS, 1_000);
const SECRET_KEY = Buffer.alloc(32, 73).toString("base64url");
const MANAGED_CONTAINER_NAMES = [
  LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
  "agentbay-runner",
  LOCAL_AGENT_SMOKE_FAKE_MODEL_CONTAINER,
  DASHBOARD_CONTAINER,
  `${COMPOSE_PROJECT}-postgres-1`,
] as const;

export type LocalAgentCycleSmokeSummary = {
  agentCreated: true;
  agentDeleted: true;
  agentId: string;
  cleanupVerified: true;
  deploymentStages: string[];
  digitalOceanRequests: 0;
  fakeModelBoundary: true;
  hermesGatewayLiveInsideDroplet: true;
  hermesInstalledInsideDroplet: true;
  nestedDocker: true;
  runnerId: string;
  runnerProvisioned: true;
  runtimeRestarted: true;
  runtimeStopped: true;
  simulatedDroplets: 1;
  telegramBoundary: "synthetic-local-health";
};

export function assertLocalAgentCycleIsolation(env: Record<string, string | undefined>): void {
  if (
    env.AGENTBAY_DIGITALOCEAN_PROVIDER_MODE !== "local_docker" ||
    env.AGENTBAY_DIGITALOCEAN_TOKEN !== "local-docker" ||
    env[LOCAL_AGENT_SMOKE_MODE_ENV] !== LOCAL_AGENT_SMOKE_MODE_VALUE
  ) {
    throw new Error(
      "Local agent cycle smoke requires the exact local_docker provider, local-docker token, and synthetic boundary mode.",
    );
  }
}

export async function smokeLocalAgentCycle(): Promise<LocalAgentCycleSmokeSummary> {
  assertLocalAgentCycleIsolation(process.env);
  await assertNoManagedContainers();

  const smokeEnv = buildSmokeEnv(process.env);
  const previousEnv = installProcessEnv(smokeEnv);
  let connection: DatabaseConnection | null = null;
  let provider: ReturnType<typeof createConfiguredDigitalOceanProvider> | null = null;
  let runnerId: string | null = null;
  let agentId: string | null = null;
  let summary: LocalAgentCycleSmokeSummary | null = null;
  let primaryError: unknown = null;
  const cleanupErrors: unknown[] = [];

  try {
    await ensureLocalDropletImage();
    await ensureLocalHermesImage();
    await ensureImage("busybox:1.36");
    await compose(["build", "local-cloud-runner-image"], smokeEnv);
    await prepareNestedImageBundle();
    await compose(["up", "--build", "--detach", "dashboard"], smokeEnv);
    await waitForControlPlane();

    connection = createDatabaseConnection();
    const config = readDigitalOceanProviderConfig(smokeEnv);
    if (config?.providerMode !== "local_docker" || !config.localAgentSmokeMode) {
      throw new Error("Local agent cycle provider configuration did not remain isolated.");
    }
    provider = createConfiguredDigitalOceanProvider(config);

    const [owner] = await connection.db.insert(users).values({}).returning({ id: users.id });
    if (!owner) throw new Error("Local agent cycle owner could not be created.");

    const created = await createAgentForUser(
      owner.id,
      {
        name: "Local full-cycle agent",
        templateKey: "research_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: `local-agent-cycle-${randomUUID()}`,
        assistant: "chatgpt",
        modelApiKey: "sk-localagentcyclesyntheticmodelkey123456",
        telegramBotToken: "123456789:localAgentCycleSyntheticTelegramToken",
        telegramAllowedUserIds: ["111111"],
      },
      {
        createConnection: () => connection as DatabaseConnection,
        env: smokeEnv,
        onReadyDeploymentCommitted: () => undefined,
        telegramBotValidator: async () => ({
          ok: true,
          bot: { botId: "123456789", username: "local_agent_cycle_bot" },
        }),
      },
    );
    if (!("deployment" in created)) {
      throw new Error("Local agent cycle did not create a ready-mode deployment.");
    }
    agentId = created.agent.id;

    const deploymentStages = await driveDeployment(connection, {
      deploymentId: created.deployment.id,
      provider,
      config,
      env: smokeEnv,
    });
    const ready = await waitForPersistedReady(connection, {
      agentId,
      deploymentId: created.deployment.id,
    });
    runnerId = ready.agent.runnerId;
    if (!runnerId) throw new Error("Local agent cycle did not assign the simulated runner.");

    await verifyHermesInsideDroplet(connection, {
      agentId,
      env: smokeEnv,
      userId: owner.id,
    });
    await assertNoAgentContainers(agentId);

    const restarted = await restartAgentForUser(owner.id, agentId, {
      createConnection: () => connection as DatabaseConnection,
      manualRunnerAdapter: createHostRunnerAdapter,
      scheduleRuntimeReconcile: () => undefined,
    });
    if (!restarted.ok || restarted.state !== "accepted") {
      throw new Error("Local agent cycle restart was not accepted.");
    }
    await driveRuntime(connection, agentId, "running", smokeEnv);

    const stopped = await stopAgentForUser(owner.id, agentId, {
      createConnection: () => connection as DatabaseConnection,
      manualRunnerAdapter: createHostRunnerAdapter,
      scheduleRuntimeReconcile: () => undefined,
    });
    if (!stopped.ok) throw new Error("Local agent cycle stop was rejected.");
    await driveRuntime(connection, agentId, "stopped", smokeEnv);
    await assertNoRunningAgentContainersInsideDroplet(agentId);

    const deleted = await deleteAgentForUser(owner.id, agentId, {
      createConnection: () => connection as DatabaseConnection,
      manualRunnerAdapter: createHostRunnerAdapter,
    });
    if (!deleted.ok) throw new Error("Local agent cycle delete was rejected.");

    await cleanupRunner(connection, runnerId, provider);
    await assertPersistedCleanup(connection, { agentId, runnerId });
    await assertNoAgentContainers(agentId);

    summary = {
      agentCreated: true,
      agentDeleted: true,
      agentId,
      cleanupVerified: true,
      deploymentStages,
      digitalOceanRequests: 0,
      fakeModelBoundary: true,
      hermesGatewayLiveInsideDroplet: true,
      hermesInstalledInsideDroplet: true,
      nestedDocker: true,
      runnerId,
      runnerProvisioned: true,
      runtimeRestarted: true,
      runtimeStopped: true,
      simulatedDroplets: 1,
      telegramBoundary: "synthetic-local-health",
    };
  } catch (error) {
    primaryError = error;
    await printFailureDiagnostics();
  } finally {
    if (agentId) {
      await cleanupAgentContainers(agentId).catch((error) => cleanupErrors.push(error));
    }
    if (connection && runnerId && provider) {
      await cleanupRunner(connection, runnerId, provider).catch((error) =>
        cleanupErrors.push(error),
      );
    } else if (provider) {
      await provider
        .cleanupResource({ providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID })
        .catch((error) => cleanupErrors.push(error));
    }
    if (connection) {
      await connection.close().catch((error) => cleanupErrors.push(error));
    }
    await compose(["down", "--volumes", "--remove-orphans"], smokeEnv).catch((error) =>
      cleanupErrors.push(error),
    );
    await rm(dirname(LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH), {
      force: true,
      recursive: true,
    }).catch((error) => cleanupErrors.push(error));
    restoreProcessEnv(previousEnv);

    const containersRemain = await listManagedContainers();
    if (containersRemain.length > 0) {
      cleanupErrors.push(new Error("Local agent cycle cleanup left managed containers behind."));
    }
    if (agentId) {
      await assertNoAgentContainers(agentId).catch((error) => cleanupErrors.push(error));
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Local agent cycle cleanup could not be verified.");
  }
  if (!summary) throw new Error("Local agent cycle produced no summary.");
  return summary;
}

async function verifyHermesInsideDroplet(
  connection: DatabaseConnection,
  input: { agentId: string; env: Record<string, string>; userId: string },
): Promise<void> {
  const installed = await docker([
    "exec",
    LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
    "docker",
    "image",
    "inspect",
    DEFAULT_LOCAL_HERMES_IMAGE,
    "--format",
    "{{.Id}}",
  ]);
  if (!installed.stdout.trim().startsWith("sha256:")) {
    throw new Error("Hermes image was not installed inside the simulated Droplet.");
  }

  const listed = await listAgentContainersInsideDroplet(input.agentId);
  if (listed.length !== 1) {
    throw new Error(
      `Expected one Hermes container inside the simulated Droplet, found ${listed.length}.`,
    );
  }
  const containerName = listed[0] as string;
  const version = await docker([
    "exec",
    LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
    "docker",
    "exec",
    containerName,
    "/opt/hermes/bin/hermes",
    "--version",
  ]);
  if (!version.stdout.includes(HERMES_VERSION_FRAGMENT)) {
    throw new Error("Hermes executable version inside the simulated Droplet was unexpected.");
  }

  const launch = await buildHermesAgentLaunchSpecForUser(input.userId, input.agentId, {
    createConnection: () => connection,
    env: input.env,
    hermesWorkloadImage: DEFAULT_LOCAL_HERMES_IMAGE,
  });
  if (!launch.ok) {
    throw new Error(`Hermes liveness credentials were unavailable: ${launch.reason}.`);
  }
  const probe = await docker([
    "exec",
    LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
    "docker",
    "exec",
    containerName,
    "python",
    "-c",
    HERMES_INSIDE_DROPLET_LIVENESS_SOURCE,
    launch.spec.secrets.apiServerKey,
  ]);
  const parsed: unknown = JSON.parse(probe.stdout);
  if (
    !isRecord(parsed) ||
    parsed.status !== 200 ||
    !evaluateHermesReadyResponse(parsed.body, { requireTelegram: false }).ok
  ) {
    throw new Error("Hermes gateway liveness probe failed inside the simulated Droplet.");
  }
}

async function assertNoRunningAgentContainersInsideDroplet(agentId: string): Promise<void> {
  const listed = await listAgentContainersInsideDroplet(agentId, false);
  if (listed.length > 0) {
    throw new Error("Stopped Hermes workload remained running inside the simulated Droplet.");
  }
}

async function listAgentContainersInsideDroplet(
  agentId: string,
  includeStopped = true,
): Promise<string[]> {
  const listed = await docker([
    "exec",
    LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
    "docker",
    "ps",
    ...(includeStopped ? ["--all"] : []),
    "--filter",
    `label=agentbay.agent_id=${agentId}`,
    "--format",
    "{{.Names}}",
  ]);
  return listed.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function driveDeployment(
  connection: DatabaseConnection,
  input: {
    deploymentId: string;
    provider: ReturnType<typeof createConfiguredDigitalOceanProvider>;
    config: NonNullable<ReturnType<typeof readDigitalOceanProviderConfig>>;
    env: Record<string, string>;
  },
): Promise<string[]> {
  const deadline = Date.now() + TIMEOUT_MS;
  const stages: string[] = [];

  while (Date.now() < deadline) {
    const [deployment] = await connection.db
      .select({
        stage: agentDeployments.stage,
        errorCode: agentDeployments.errorCode,
        errorDetail: agentDeployments.errorDetail,
      })
      .from(agentDeployments)
      .where(eq(agentDeployments.id, input.deploymentId))
      .limit(1);
    if (!deployment) throw new Error("Local agent cycle deployment disappeared.");
    if (stages.at(-1) !== deployment.stage) stages.push(deployment.stage);
    if (deployment.stage === "ready") return stages;
    if (deployment.stage === "failed") {
      throw new Error(
        `Local agent cycle deployment failed with ${deployment.errorCode ?? "unknown"}: ${deployment.errorDetail ?? "no detail"}.`,
      );
    }

    const result = await reconcileTargetAgentDeployment(input.deploymentId, {
      createConnection: () => connection,
      digitalOceanProvider: input.provider,
      launchSpec: (userId, agentId, dependencies) =>
        buildHermesAgentLaunchSpecForUser(userId, agentId, {
          ...dependencies,
          createConnection: () => connection,
          env: input.env,
        }),
      readDigitalOceanConfig: () => input.config,
      readHermesWorkloadImage: () => DEFAULT_LOCAL_HERMES_IMAGE,
      manualRunnerAdapter: (runner, options) => createHostRunnerAdapter(runner, options),
      triggerReplacement: () => undefined,
    });
    if (result.outcome === "recovering") {
      throw new Error("Local agent cycle refuses managed-runner replacement during smoke.");
    }
    await sleep(POLL_MS);
  }

  throw new Error("Local agent cycle deployment exceeded its bounded timeout.");
}

async function driveRuntime(
  connection: DatabaseConnection,
  agentId: string,
  expectedStatus: "running" | "stopped",
  env: Record<string, string>,
): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;

  while (Date.now() < deadline) {
    await reconcileTargetAgentRuntime(agentId, {
      createConnection: () => connection,
      launchSpec: (userId, selectedAgentId, dependencies) =>
        buildHermesAgentLaunchSpecForUser(userId, selectedAgentId, {
          ...dependencies,
          createConnection: () => connection,
          env,
        }),
      manualRunnerAdapter: (runner, options) => createHostRunnerAdapter(runner, options),
      readHermesWorkloadImage: () => DEFAULT_LOCAL_HERMES_IMAGE,
    });
    const [state] = await connection.db
      .select({ agentStatus: agents.status, runtimeState: agentRuntimeReconciliations.state })
      .from(agents)
      .innerJoin(agentRuntimeReconciliations, eq(agentRuntimeReconciliations.agentId, agents.id))
      .where(eq(agents.id, agentId))
      .limit(1);
    if (
      state?.agentStatus === expectedStatus &&
      (expectedStatus === "running"
        ? state.runtimeState === "observing"
        : state.runtimeState === "stopped")
    ) {
      return;
    }
    if (state?.runtimeState === "circuit_open") {
      throw new Error("Local agent cycle runtime opened its recovery circuit.");
    }
    await sleep(POLL_MS);
  }

  throw new Error(`Local agent cycle runtime did not converge to ${expectedStatus}.`);
}

async function waitForPersistedReady(
  connection: DatabaseConnection,
  input: { agentId: string; deploymentId: string },
) {
  const deadline = Date.now() + 10_000;
  let latest = await readAgentState(connection, input);

  while (
    Date.now() < deadline &&
    (latest.agent?.status !== "running" || latest.deployment?.stage !== "ready")
  ) {
    await sleep(POLL_MS);
    latest = await readAgentState(connection, input);
  }

  if (latest.agent?.status !== "running" || latest.deployment?.stage !== "ready") {
    throw new Error(
      `Local agent cycle did not reach persisted ready/running state (agent=${latest.agent?.status ?? "missing"}, deployment=${latest.deployment?.stage ?? "missing"}).`,
    );
  }

  return { agent: latest.agent, deployment: latest.deployment };
}

async function readAgentState(
  connection: DatabaseConnection,
  input: { agentId: string; deploymentId: string },
) {
  const [agent] = await connection.db
    .select({ status: agents.status, runnerId: agents.runnerId })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  const [deployment] = await connection.db
    .select({ stage: agentDeployments.stage })
    .from(agentDeployments)
    .where(eq(agentDeployments.id, input.deploymentId))
    .limit(1);
  return { agent: agent ?? null, deployment: deployment ?? null };
}

function createHostRunnerAdapter(
  runner: ManualRunnerRecord,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): ManualRunnerAdapter {
  return new ManualRunnerAdapter(runner, {
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "host.docker.internal") {
        url.hostname = "127.0.0.1";
      }
      return fetch(url, init);
    },
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

async function cleanupRunner(
  connection: DatabaseConnection,
  runnerId: string,
  provider: ReturnType<typeof createConfiguredDigitalOceanProvider>,
): Promise<void> {
  const cleanup = await provider.cleanupResource({
    providerResourceId: LOCAL_DOCKER_DIGITALOCEAN_RESOURCE_ID,
  });
  if (!cleanup.ok && cleanup.reason !== "resource_not_found") {
    throw new Error("Local agent cycle simulated runner cleanup failed.");
  }

  const now = new Date();
  await connection.db.transaction(async (tx) => {
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(runnerCredentials.runnerId, runnerId), eq(runnerCredentials.status, "active")));
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: now, usedAt: null, updatedAt: now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, runnerId),
          eq(runnerRegistrationTokens.status, "pending"),
        ),
      );
    await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        provisioningCompletedAt: now,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(runners.id, runnerId));
  });
}

async function assertPersistedCleanup(
  connection: DatabaseConnection,
  input: { agentId: string; runnerId: string },
): Promise<void> {
  const [agent] = await connection.db
    .select({ deletedAt: agents.deletedAt })
    .from(agents)
    .where(eq(agents.id, input.agentId))
    .limit(1);
  const activeSecrets = await connection.db
    .select({ id: agentSecrets.id })
    .from(agentSecrets)
    .where(and(eq(agentSecrets.agentId, input.agentId), eq(agentSecrets.status, "active")));
  const [runner] = await connection.db
    .select({ deletedAt: runners.deletedAt, status: runners.status })
    .from(runners)
    .where(eq(runners.id, input.runnerId))
    .limit(1);

  if (
    !agent?.deletedAt ||
    activeSecrets.length !== 0 ||
    runner?.status !== "deleted" ||
    !runner.deletedAt
  ) {
    throw new Error("Local agent cycle persisted cleanup evidence was incomplete.");
  }
}

async function waitForControlPlane(): Promise<void> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await fetch("http://127.0.0.1:3000/health").catch(() => null);
    if (response?.ok) return;
    const dashboard = await docker(
      ["inspect", "--format", "{{.State.Status}}", DASHBOARD_CONTAINER],
      { allowFailure: true },
    );
    if (dashboard.exitCode === 0 && dashboard.stdout.trim() !== "running") {
      throw new Error("Local agent cycle control plane exited during startup.");
    }
    await sleep(POLL_MS);
  }
  throw new Error("Local agent cycle control plane did not become healthy.");
}

async function printFailureDiagnostics(): Promise<void> {
  for (const name of [LOCAL_DOCKER_DROPLET_CONTAINER_NAME, DASHBOARD_CONTAINER]) {
    const result = await docker(["logs", "--tail", "80", name], { allowFailure: true });
    if (result.exitCode === 0 && (result.stdout.trim() || result.stderr.trim())) {
      console.error(`--- ${name} diagnostics ---`);
      console.error([result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n"));
    }
  }
  const nested = await docker(
    [
      "exec",
      LOCAL_DOCKER_DROPLET_CONTAINER_NAME,
      "sh",
      "-lc",
      "docker ps -a; docker logs --tail 80 agentbay-runner 2>&1; tail -n 80 /var/log/agentbay-local-dockerd.log",
    ],
    { allowFailure: true },
  );
  if (nested.stdout.trim() || nested.stderr.trim()) {
    console.error("--- simulated Droplet nested Docker diagnostics ---");
    console.error([nested.stdout.trim(), nested.stderr.trim()].filter(Boolean).join("\n"));
  }
}

async function ensureImage(image: string): Promise<void> {
  const inspected = await docker(["image", "inspect", image], { allowFailure: true });
  if (inspected.exitCode === 0) return;
  await docker(["pull", image], { timeoutMs: TIMEOUT_MS });
}

async function ensureLocalDropletImage(): Promise<void> {
  await docker(
    [
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      LOCAL_AGENT_SMOKE_DROPLET_IMAGE,
      "--file",
      "Dockerfile.local-droplet",
      ".",
    ],
    { timeoutMs: TIMEOUT_MS },
  );
}

async function ensureLocalHermesImage(): Promise<void> {
  const inspected = await docker(["image", "inspect", DEFAULT_LOCAL_HERMES_IMAGE], {
    allowFailure: true,
  });
  if (inspected.exitCode === 0) return;
  await docker(
    [
      "build",
      "--platform",
      "linux/amd64",
      "--tag",
      DEFAULT_LOCAL_HERMES_IMAGE,
      "--file",
      "Dockerfile.agent",
      ".",
    ],
    { timeoutMs: TIMEOUT_MS },
  );
}

async function prepareNestedImageBundle(): Promise<void> {
  await mkdir(dirname(LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH), { recursive: true });
  await docker(
    [
      "save",
      "--output",
      LOCAL_AGENT_SMOKE_IMAGE_BUNDLE_PATH,
      "agentbay-runner:local",
      DEFAULT_LOCAL_HERMES_IMAGE,
      "busybox:1.36",
    ],
    { timeoutMs: TIMEOUT_MS },
  );
}

async function assertNoManagedContainers(): Promise<void> {
  const existing = await listManagedContainers();
  if (existing.length > 0) {
    throw new Error(
      `Local agent cycle refuses to replace existing local runner containers: ${existing.join(", ")}.`,
    );
  }
}

async function listManagedContainers(): Promise<string[]> {
  const existing: string[] = [];
  for (const name of MANAGED_CONTAINER_NAMES) {
    const inspected = await docker(["container", "inspect", name], { allowFailure: true });
    if (inspected.exitCode === 0) existing.push(name);
  }
  return existing;
}

async function assertNoAgentContainers(agentId: string): Promise<void> {
  const listed = await docker([
    "ps",
    "--all",
    "--filter",
    `label=agentbay.agent_id=${agentId}`,
    "--format",
    "{{.ID}}",
  ]);
  if (listed.stdout.trim()) throw new Error("Local agent cycle left an agent container behind.");
}

async function cleanupAgentContainers(agentId: string): Promise<void> {
  const listed = await docker([
    "ps",
    "--all",
    "--filter",
    `label=agentbay.agent_id=${agentId}`,
    "--format",
    "{{.ID}}",
  ]);
  const containerIds = listed.stdout
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (containerIds.length > 0) {
    await docker(["rm", "--force", ...containerIds]);
  }
}

function buildSmokeEnv(env: Record<string, string | undefined>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter((entry): entry is [string, string] => !!entry[1]),
    ),
    AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION: "local-smoke-v1",
    AGENTBAY_AGENT_SECRET_KEYS_JSON: JSON.stringify({ "local-smoke-v1": SECRET_KEY }),
    AGENTBAY_AUTH_MODE: "development",
    AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
    AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "none",
    AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
    AGENTBAY_DIGITALOCEAN_SIZE_SLUG: "s-2vcpu-4gb",
    AGENTBAY_HERMES_PRIVATE_NETWORK: "agentbay-hermes",
    AGENTBAY_HERMES_WORKLOAD_IMAGE: DEFAULT_LOCAL_HERMES_IMAGE,
    AGENTBAY_LOCAL_AGENT_SMOKE_MODE: LOCAL_AGENT_SMOKE_MODE_VALUE,
    AGENTBAY_LOCAL_CLOUD_RUNNER_ENDPOINT_URL: RUNNER_ENDPOINT_URL,
    AGENTBAY_LOCAL_CLOUD_RUNNER_START_DELAY_MS: "100",
    AGENTBAY_POSTGRES_HOST_PORT: "55432",
    AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
    AGENTBAY_RUNNER_BEARER_TOKEN: "local-runner-command-token",
    AGENTBAY_RUNNER_IMAGE: "agentbay-runner:local",
    DATABASE_URL,
    NEXT_PUBLIC_APP_URL: APP_URL,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HERMES_INSIDE_DROPLET_LIVENESS_SOURCE = `
import json
import sys
import urllib.error
import urllib.request

request = urllib.request.Request(
    "http://127.0.0.1:8642/health/detailed",
    headers={"authorization": "Bearer " + sys.argv[1], "accept": "application/json"},
    method="GET",
)
try:
    with urllib.request.urlopen(request, timeout=10) as response:
        print(json.dumps({"status": response.status, "body": json.load(response)}))
except urllib.error.HTTPError as error:
    print(json.dumps({"status": error.code, "body": None}))
`;

function installProcessEnv(env: Record<string, string>): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return previous;
}

function restoreProcessEnv(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function compose(args: readonly string[], env: Record<string, string>): Promise<CommandResult> {
  return runCommand(
    "docker",
    ["compose", "--project-name", COMPOSE_PROJECT, "--profile", "local-cloud", ...args],
    { env, timeoutMs: TIMEOUT_MS },
  );
}

function docker(
  args: readonly string[],
  options: { allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return runCommand("docker", args, options);
}

type CommandResult = { exitCode: number; stdout: string; stderr: string };

function runCommand(
  command: string,
  args: readonly string[],
  options: {
    allowFailure?: boolean;
    env?: Record<string, string>;
    timeoutMs?: number;
  } = {},
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: options.env ? { ...process.env, ...options.env } : process.env,
        timeout: options.timeoutMs ?? 60_000,
      },
      (error, stdout, stderr) => {
        const exitCode =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? ((error as { code: number }).code ?? 1)
            : error
              ? 1
              : 0;
        if (error && !options.allowFailure) {
          reject(new Error(`${command} ${args[0] ?? "command"} failed with exit ${exitCode}.`));
          return;
        }
        resolvePromise({ exitCode, stdout, stderr });
      },
    );
  });
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function main(): Promise<void> {
  const summary = await smokeLocalAgentCycle();
  process.stdout.write(
    `${JSON.stringify({ event: "local_agent_cycle_smoke_passed", ...summary })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(formatErrorChain(error));
    process.exit(1);
  });
}

function formatErrorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(`${current.name}: ${current.message}`);
    current = current.cause;
  }
  if (messages.length === 0) return String(error);
  return messages.join(" <- ");
}
