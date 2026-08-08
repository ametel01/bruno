import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { and, desc, eq } from "drizzle-orm";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import { RUNNER_BOOT_COMPONENTS } from "@/src/runner-service/runner-contracts";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerCredentials,
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import { type DigitalOceanProviderConfig, readDigitalOceanProviderConfig } from "@/src/server/env";
import {
  DIGITALOCEAN_MANAGED_RUNNER_TAG,
  type DigitalOceanOwnedSetExpectation,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import { probeRunnerEndpointReadiness } from "@/src/server/runners/runner-heartbeat";
import {
  createConfiguredDigitalOceanProvider,
  createDigitalOceanRunnerForUser,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";

export const RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION =
  "authorize-disposable-runner-release-smoke";
export const RUNNER_RELEASE_SMOKE_TIMEOUT_MS = 12 * 60 * 1000;

const SAFE_BOOTSTRAP_FAILURE_STEPS = new Set([
  "agent_image_pull",
  "docker_apt_repository",
  "docker_container_start",
  "docker_pull",
  "hermes_image_pull",
  "hermes_private_network",
  "hermes_state_root",
  "swap_setup",
]);

const IMMUTABLE_RELEASE_IMAGE_PATTERN =
  /^ghcr\.io\/ametel01\/bruno-runner:[a-f0-9]{40}@sha256:[a-f0-9]{64}$/;

export type RunnerReleaseSmokePlan =
  | {
      ok: true;
      image: string;
      providerMode: "digitalocean" | "local_docker";
      release: { version: string; imageDigest: string };
    }
  | {
      ok: false;
      code: "capability_unavailable" | "usage_invalid";
      capabilities: Array<{
        name: string;
        envName: string;
        state: "missing" | "malformed";
      }>;
    };

export type RunnerReleaseSmokeEvidence = {
  providerMode: "digitalocean" | "local_docker";
  releaseVersion: string;
  imageDigest: string;
  bootContractVersion: string;
  bootComponents: readonly string[];
  syntheticActions: readonly ["start", "status", "canary", "stop"];
};

export type RunnerReleaseSmokeResult =
  | {
      ok: true;
      code: "passed";
      sideEffectsAttempted: true;
      cleanupVerified: true;
      evidence: RunnerReleaseSmokeEvidence;
    }
  | {
      ok: false;
      code: "capability_unavailable" | "usage_invalid" | "smoke_failed" | "cleanup_failed";
      sideEffectsAttempted: boolean;
      cleanupVerified: boolean;
      capabilities?: RunnerReleaseSmokePlan extends infer _Plan
        ? Array<{ name: string; envName: string; state: "missing" | "malformed" }>
        : never;
    };

export type RunnerReleaseSmokeSession = {
  run(): Promise<RunnerReleaseSmokeEvidence>;
  cleanup(): Promise<void>;
  verifyCleanup(): Promise<boolean>;
};

export type RunnerReleaseSmokeDependencies = {
  createSession?: (
    plan: Extract<RunnerReleaseSmokePlan, { ok: true }>,
    env: Record<string, string | undefined>,
  ) => RunnerReleaseSmokeSession;
};

export function runnerReleaseBootstrapFailureCode(metadata: unknown): string {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "runner_provisioning_failed";
  }

  const step = (metadata as Record<string, unknown>).step;
  return typeof step === "string" && SAFE_BOOTSTRAP_FAILURE_STEPS.has(step)
    ? `bootstrap_${step}`
    : "runner_provisioning_failed";
}

export function planRunnerReleaseSmoke(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): RunnerReleaseSmokePlan {
  if (
    argv.length !== 4 ||
    argv[0] !== "--image" ||
    argv[2] !== "--provider" ||
    (argv[3] !== "digitalocean" && argv[3] !== "local_docker")
  ) {
    return {
      ok: false,
      code: "usage_invalid",
      capabilities: [
        { name: "release_smoke_arguments", envName: "--image/--provider", state: "malformed" },
      ],
    };
  }

  const image = argv[1]?.trim() ?? "";
  const providerMode = argv[3];
  const release = parseImmutableRunnerImageReference(image);
  const capabilities: Array<{
    name: string;
    envName: string;
    state: "missing" | "malformed";
  }> = [];

  if (!release || !IMMUTABLE_RELEASE_IMAGE_PATTERN.test(image)) {
    capabilities.push({ name: "immutable_image", envName: "--image", state: "malformed" });
  }

  if (!env.DATABASE_URL?.trim()) {
    capabilities.push({ name: "database", envName: "DATABASE_URL", state: "missing" });
  }

  const appUrl = safeReleaseControlPlaneUrl(env.NEXT_PUBLIC_APP_URL, providerMode);
  if (!appUrl) {
    capabilities.push({
      name: "public_control_plane",
      envName: "NEXT_PUBLIC_APP_URL",
      state: env.NEXT_PUBLIC_APP_URL === undefined ? "missing" : "malformed",
    });
  }

  if (
    providerMode === "digitalocean" &&
    env.BRUNO_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION?.trim() !==
      RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION
  ) {
    capabilities.push({
      name: "digitalocean_authorization",
      envName: "BRUNO_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION",
      state:
        env.BRUNO_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION === undefined ? "missing" : "malformed",
    });
  }

  let providerConfig: DigitalOceanProviderConfig | null = null;
  try {
    providerConfig = readDigitalOceanProviderConfig({ ...env, BRUNO_RUNNER_IMAGE: image });
  } catch {
    capabilities.push({
      name: "digitalocean_configuration",
      envName: "BRUNO_DIGITALOCEAN_TOKEN",
      state: "malformed",
    });
  }

  if (!providerConfig) {
    capabilities.push({
      name: "digitalocean_configuration",
      envName: "BRUNO_DIGITALOCEAN_TOKEN",
      state: "missing",
    });
  } else if (providerConfig.providerMode !== providerMode) {
    capabilities.push({
      name: "digitalocean_configuration",
      envName: "BRUNO_DIGITALOCEAN_PROVIDER_MODE",
      state: "malformed",
    });
  } else if (providerMode === "local_docker" && env.BRUNO_DIGITALOCEAN_TOKEN !== "local-docker") {
    capabilities.push({
      name: "local_docker_isolation",
      envName: "BRUNO_DIGITALOCEAN_TOKEN",
      state: "malformed",
    });
  }

  if (capabilities.length > 0 || !release) {
    return { ok: false, code: "capability_unavailable", capabilities };
  }

  return {
    ok: true,
    image,
    providerMode,
    release: { version: release.version, imageDigest: release.imageDigest },
  };
}

export async function smokeRunnerRelease(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
  dependencies: RunnerReleaseSmokeDependencies = {},
): Promise<RunnerReleaseSmokeResult> {
  const plan = planRunnerReleaseSmoke(argv, env);

  if (!plan.ok) {
    return {
      ok: false,
      code: plan.code,
      sideEffectsAttempted: false,
      cleanupVerified: false,
      capabilities: plan.capabilities,
    };
  }

  const sessionEnv = { ...env, BRUNO_RUNNER_IMAGE: plan.image };
  const session = (dependencies.createSession ?? createRunnerReleaseSmokeSession)(plan, sessionEnv);
  let evidence: RunnerReleaseSmokeEvidence | null = null;
  let runFailed = false;
  let cleanupFailed = false;

  try {
    evidence = await session.run();
  } catch (error) {
    runFailed = true;
    logClosedSmokeFailure("run_failed", error);
  } finally {
    try {
      await session.cleanup();
      cleanupFailed = !(await session.verifyCleanup());
    } catch (error) {
      cleanupFailed = true;
      logClosedSmokeFailure("cleanup_failed", error);
    }
  }

  if (cleanupFailed) {
    return {
      ok: false,
      code: "cleanup_failed",
      sideEffectsAttempted: true,
      cleanupVerified: false,
    };
  }

  if (runFailed || !evidence) {
    return {
      ok: false,
      code: "smoke_failed",
      sideEffectsAttempted: true,
      cleanupVerified: true,
    };
  }

  return {
    ok: true,
    code: "passed",
    sideEffectsAttempted: true,
    cleanupVerified: true,
    evidence,
  };
}

function createRunnerReleaseSmokeSession(
  plan: Extract<RunnerReleaseSmokePlan, { ok: true }>,
  env: Record<string, string | undefined>,
): RunnerReleaseSmokeSession {
  const connection = createDatabaseConnection();
  const config = readDigitalOceanProviderConfig(env);
  if (config?.providerMode !== plan.providerMode) {
    void connection.close();
    throw new Error("Runner release smoke configuration is unavailable.");
  }

  const operationKey = `bruno-deploy-${randomUUID().replaceAll("-", "")}`;
  const runnerName =
    plan.providerMode === "local_docker"
      ? `bruno release simulation ${plan.release.version.slice(0, 12)}`
      : `bruno release canary ${plan.release.version.slice(0, 12)}`;
  const releaseConfig: DigitalOceanProviderConfig = {
    ...config,
    runnerImage: plan.image,
    sshKeyIds: [],
    sshSourceAddresses: [],
    tags: [...new Set([...config.tags, DIGITALOCEAN_MANAGED_RUNNER_TAG, operationKey])].sort(),
  };
  const provider = createConfiguredDigitalOceanProvider(releaseConfig);
  const ownedProvider =
    plan.providerMode === "digitalocean"
      ? (provider as DigitalOceanProvider & DigitalOceanOwnedSetProvider)
      : null;
  let userId: string | null = null;
  let runnerId: string | null = null;
  let closed = false;

  return {
    async run() {
      const [user] = await connection.db.insert(users).values({}).returning({ id: users.id });
      if (!user) throw new Error("Release smoke owner could not be created.");
      userId = user.id;

      const provisioned = await createDigitalOceanRunnerForUser(
        user.id,
        { provider: "digitalocean", name: runnerName },
        {
          createConnection: () => connection,
          provider,
          readConfig: () => releaseConfig,
        },
      );
      if (!provisioned.ok) throw new Error("Release smoke provisioning was rejected.");
      runnerId = provisioned.runner.id;

      return await waitForReleaseEvidence(connection, {
        runnerId,
        userId: user.id,
        plan,
        config: releaseConfig,
      });
    },

    async cleanup() {
      try {
        if (!runnerId && userId) {
          const [persistedRunner] = await connection.db
            .select({ id: runners.id })
            .from(runners)
            .where(eq(runners.userId, userId))
            .limit(1);
          runnerId = persistedRunner?.id ?? null;
        }

        if (runnerId) {
          await cleanupReleaseRunner(connection, {
            runnerId,
            userId,
            operationKey,
            runnerName,
            config: releaseConfig,
            provider,
            ownedProvider,
          });
        }
      } finally {
        if (!closed) {
          closed = true;
          await connection.close();
        }
      }
    },

    async verifyCleanup() {
      const inspection = createDatabaseConnection();
      try {
        const discovered = await provider.discoverResourcesByTag({ tag: operationKey });
        const [runner] = runnerId
          ? await inspection.db
              .select({ status: runners.status, deletedAt: runners.deletedAt })
              .from(runners)
              .where(eq(runners.id, runnerId))
              .limit(1)
          : [];
        return (
          discovered.ok &&
          discovered.value.authoritative &&
          discovered.value.resources.length === 0 &&
          (!runnerId || (runner?.status === "deleted" && runner.deletedAt !== null))
        );
      } finally {
        await inspection.close();
      }
    },
  };
}

async function waitForReleaseEvidence(
  connection: DatabaseConnection,
  input: {
    runnerId: string;
    userId: string;
    plan: Extract<RunnerReleaseSmokePlan, { ok: true }>;
    config: DigitalOceanProviderConfig;
  },
): Promise<RunnerReleaseSmokeEvidence> {
  const deadline = Date.now() + RUNNER_RELEASE_SMOKE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const [runner] = await connection.db
      .select({
        endpointUrl: runners.endpointUrl,
        status: runners.status,
        provisioningStatus: runners.provisioningStatus,
        compatibilityState: runners.compatibilityState,
        requiredRunnerImageDigest: runners.requiredRunnerImageDigest,
        observedRunnerImageDigest: runners.observedRunnerImageDigest,
        observedRunnerReleaseVersion: runners.observedRunnerReleaseVersion,
        observedRunnerBootContractVersion: runners.observedRunnerBootContractVersion,
      })
      .from(runners)
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)))
      .limit(1);

    if (runner?.status === "provision_failed" || runner?.provisioningStatus === "failed") {
      const [failedEvent] = await connection.db
        .select({ metadata: runnerProvisioningEvents.metadata })
        .from(runnerProvisioningEvents)
        .where(
          and(
            eq(runnerProvisioningEvents.runnerId, input.runnerId),
            eq(runnerProvisioningEvents.status, "failed"),
          ),
        )
        .orderBy(desc(runnerProvisioningEvents.createdAt))
        .limit(1);
      throw new RunnerReleaseSmokeFailure(runnerReleaseBootstrapFailureCode(failedEvent?.metadata));
    }

    if (
      runner?.status === "online" &&
      runner.provisioningStatus === "ready" &&
      runner.compatibilityState === "compatible" &&
      runner.requiredRunnerImageDigest === input.plan.release.imageDigest &&
      runner.observedRunnerImageDigest === input.plan.release.imageDigest &&
      runner.observedRunnerReleaseVersion === input.plan.release.version &&
      runner.observedRunnerBootContractVersion === RUNNER_BOOT_CONTRACT_VERSION
    ) {
      const readiness = await probeRunnerEndpointReadiness({
        endpointUrl: runner.endpointUrl,
        runnerBearerToken: input.config.runnerBearerToken,
        allowInsecureLoopback: input.config.providerMode === "local_docker",
        timeoutMs: 10_000,
      });

      if (
        readiness.ok &&
        RUNNER_BOOT_COMPONENTS.every(
          (component) => readiness.snapshot.components[component] === "passed",
        )
      ) {
        return {
          providerMode: input.plan.providerMode,
          releaseVersion: input.plan.release.version,
          imageDigest: input.plan.release.imageDigest,
          bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
          bootComponents: [...RUNNER_BOOT_COMPONENTS],
          syntheticActions: ["start", "status", "canary", "stop"],
        };
      }
    }

    await delay(5_000);
  }

  throw new Error("Release smoke runner did not become ready before the bounded deadline.");
}

async function cleanupReleaseRunner(
  connection: DatabaseConnection,
  input: {
    runnerId: string;
    userId: string | null;
    operationKey: string;
    runnerName: string;
    config: DigitalOceanProviderConfig;
    provider: DigitalOceanProvider;
    ownedProvider: DigitalOceanOwnedSetProvider | null;
  },
): Promise<void> {
  const [runner] = await connection.db
    .select({
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
    })
    .from(runners)
    .where(eq(runners.id, input.runnerId))
    .limit(1);
  const discovered = await input.provider.discoverResourcesByTag({ tag: input.operationKey });
  if (!discovered.ok || !discovered.value.authoritative || discovered.value.resources.length > 1) {
    throw new Error("Release smoke resource ownership was ambiguous.");
  }
  const discoveredResource = discovered.value.resources[0];
  const providerResourceId = runner?.providerResourceId ?? discoveredResource?.providerResourceId;
  const providerFirewallId =
    runner?.providerFirewallId ?? discoveredResource?.providerFirewallId ?? null;

  if (
    input.config.providerMode === "digitalocean" &&
    input.ownedProvider &&
    providerResourceId &&
    providerFirewallId
  ) {
    const expectation: DigitalOceanOwnedSetExpectation = {
      operationTag: input.operationKey,
      providerResourceId,
      providerFirewallId,
      expectedName: input.runnerName,
      expectedRegion: input.config.region,
      expectedSizeSlug: input.config.sizeSlug,
      expectedFirewallName: digitalOceanRunnerFirewallName(providerResourceId),
    };
    const firewall = await input.ownedProvider.deleteFirewall(expectation);
    if (!firewall.ok) throw new Error("Release smoke firewall cleanup was not verified.");
    const droplet = await input.ownedProvider.deleteDroplet(expectation);
    if (!droplet.ok) throw new Error("Release smoke Droplet cleanup was not verified.");
  } else if (providerResourceId) {
    const cleanup = await input.provider.cleanupResource({
      providerResourceId,
    });
    if (!cleanup.ok && cleanup.reason !== "resource_not_found") {
      throw new Error("Release smoke resource cleanup was not verified.");
    }
  }

  const now = new Date();
  await connection.db.transaction(async (tx) => {
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(eq(runnerCredentials.runnerId, input.runnerId), eq(runnerCredentials.status, "active")),
      );
    await tx
      .update(runnerRegistrationTokens)
      .set({ status: "revoked", revokedAt: now, usedAt: null, updatedAt: now })
      .where(
        and(
          eq(runnerRegistrationTokens.runnerId, input.runnerId),
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
      .where(eq(runners.id, input.runnerId));
  });
}

function safeReleaseControlPlaneUrl(
  value: string | undefined,
  providerMode: "digitalocean" | "local_docker",
): URL | null {
  try {
    const url = new URL(value ?? "");
    const securePublicOrigin = url.protocol === "https:";
    const isolatedLocalOrigin =
      providerMode === "local_docker" &&
      url.protocol === "http:" &&
      url.hostname === "host.docker.internal";
    return (securePublicOrigin || isolatedLocalOrigin) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? url
      : null;
  } catch {
    return null;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class RunnerReleaseSmokeFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super("Release smoke runner provisioning failed safely.");
    this.name = "RunnerReleaseSmokeFailure";
    this.code = code;
  }
}

function logClosedSmokeFailure(event: "cleanup_failed" | "run_failed", error: unknown): void {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error("[bruno] runner.release_smoke", {
    event,
    errorName: error instanceof Error ? error.name : typeof error,
    errorCode: closedErrorCode(error),
    causeName: cause instanceof Error ? cause.name : cause === undefined ? null : typeof cause,
    causeCode: closedErrorCode(cause),
  });
}

function closedErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = error.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
}

async function main(): Promise<void> {
  const result = await smokeRunnerRelease(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
