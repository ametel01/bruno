import "server-only";

import { generateKeyPairSync, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import { RUNNER_RELEASE_DEVELOPMENT_MODE } from "@/src/runner-service/release-identity";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import { getServerEnv, readDigitalOceanProviderConfig } from "@/src/server/env";
import {
  buildCloudRunnerBootstrapForRunner,
  type CloudRunnerBootstrapContent,
  redactCloudRunnerBootstrapOutput,
} from "@/src/server/runners/cloud-runner-bootstrap";
import { reconcileTimedOutWaitingForRunnerRows } from "@/src/server/runners/cloud-runner-provisioning";
import {
  DIGITALOCEAN_MANAGED_RUNNER_TAG,
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
  DigitalOceanApiProvider,
  type DigitalOceanOwnedSetProvider,
  type DigitalOceanProvider,
  type DigitalOceanProviderErrorReason,
  type DigitalOceanProviderRequestContext,
  type DigitalOceanProviderResult,
  type DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";
import { LocalDockerDigitalOceanProvider } from "@/src/server/runners/local-docker-digitalocean-provider";
import {
  createRunnerRegistrationToken,
  fingerprintRunnerSecret,
  type GeneratedRunnerSecret,
} from "@/src/server/runners/runner-auth-secrets";
import { requiredRunnerImageDigestForProvider } from "@/src/server/runners/runner-compatibility";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";
import { createAppLogger } from "@/src/server/logging/logger";

const runnerProvisioningLogger = createAppLogger("runner.provisioning");

const DEFAULT_CLOUD_RUNNER_NAME = "plingpling Cloud Runner";
const DEFAULT_FIREWALL_NAME = "agentbay-runners";
const CLOUD_REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000;
const PUBLIC_ENDPOINT_POLL_ATTEMPTS = 20;
const PUBLIC_ENDPOINT_POLL_INTERVAL_MS = 3_000;
const LOW_MEMORY_DIGITALOCEAN_SIZE_SLUGS = new Set(["s-1vcpu-512mb-10gb"]);
const MAX_RUNNER_NAME_LENGTH = 80;
const MANAGED_SSH_KEY_NAME = "plingpling managed runner key";

type RunnerProvisioningTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type ProvisioningLogLevel = "debug" | "info" | "warn" | "error";
type ProvisioningLog = (
  event: string,
  metadata?: Record<string, unknown>,
  level?: ProvisioningLogLevel,
  error?: unknown,
) => void;

export type RunnerProvisioningPhase =
  | "pending"
  | "creating"
  | "tagging"
  | "firewall_configuring"
  | "bootstrapping"
  | "waiting_for_runner"
  | "ready"
  | "failed"
  | "cleaning_up"
  | "deleted";

export type RunnerProvisioningEventStatus = "started" | "completed" | "failed";

export type RunnerProvisioningSafeEvent = {
  phase: RunnerProvisioningPhase;
  status: RunnerProvisioningEventStatus;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type RunnerProvisioningDto = {
  id: string;
  name: string;
  kind: typeof DIGITALOCEAN_RUNNER_KIND;
  status: string;
  provider: typeof DIGITALOCEAN_PROVIDER;
  providerResourceId: string | null;
  region: string;
  sizeSlug: string;
  image: string;
  provisioning: {
    status: RunnerProvisioningPhase;
    error: string | null;
    startedAt: string;
    completedAt: string | null;
    phases: RunnerProvisioningSafeEvent[];
  };
};

export type CreateRunnerProvisioningPayload = {
  provider: typeof DIGITALOCEAN_PROVIDER;
  name: string;
};

export type CreateRunnerProvisioningValidationIssue = {
  field: string;
  message: string;
};

export type CreateRunnerProvisioningResult =
  | {
      ok: true;
      duplicate: boolean;
      runner: RunnerProvisioningDto;
    }
  | {
      ok: false;
      reason: "validation_failed";
      issues: CreateRunnerProvisioningValidationIssue[];
    }
  | {
      ok: false;
      reason: "provider_not_configured";
    };

export class RunnerProvisioningPersistenceError extends Error {
  constructor(readonly cause?: unknown) {
    super("Runner provisioning persistence failed.");
    this.name = "RunnerProvisioningPersistenceError";
  }
}

export type RunnerProvisioningDependencies = {
  createConnection?: () => DatabaseConnection;
  provider?: DigitalOceanProvider;
  readConfig?: () => DigitalOceanProviderConfig | null;
  createRegistrationToken?: () => GeneratedRunnerSecret;
  publicEndpointPollAttempts?: number;
  publicEndpointPollIntervalMs?: number;
  now?: () => Date;
};

export type AutomaticRunnerProvisioningResult =
  | { ok: true; state: "pending" | "ready" }
  | {
      ok: false;
      cleanupRequired: boolean;
      terminalCode: "runner_provisioning_outcome_unknown" | "runner_provisioning_unavailable";
    };

export async function advanceAutomaticDigitalOceanRunnerProvisioning(input: {
  connection: DatabaseConnection;
  userId: string;
  runnerId: string;
  operationKey: string;
  attemptCount: number;
  maxAttempts: number;
  config: DigitalOceanProviderConfig;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now: () => Date;
}): Promise<AutomaticRunnerProvisioningResult> {
  const log = createRunnerProvisioningLog({
    lifecycle: "droplet_creation",
    lifecycleId: input.operationKey,
    operationMode: "automatic",
    runnerId: input.runnerId,
    userId: input.userId,
  });
  const [runner] = await input.connection.db
    .select({
      id: runners.id,
      name: runners.name,
      status: runners.status,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
      endpointUrl: runners.endpointUrl,
      provisioningStatus: runners.provisioningStatus,
      provisioningOperationKey: runners.provisioningOperationKey,
      region: runners.region,
      sizeSlug: runners.sizeSlug,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        eq(runners.provisioningOperationKey, input.operationKey),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (!runner || runner.status === "deleted") {
    log("runner_unavailable", { observedRunnerStatus: runner?.status ?? "missing" }, "error");
    return {
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    };
  }

  if (runner.provisioningStatus === "ready") {
    log("completed", { provisioningStatus: runner.provisioningStatus });
    return { ok: true, state: "ready" };
  }

  if (runner.provisioningStatus === "failed" || runner.provisioningStatus === "deleted") {
    log(
      "terminal_state_observed",
      {
        provisioningStatus: runner.provisioningStatus,
        providerResourceId: runner.providerResourceId,
      },
      "error",
    );
    let cleaned = runner.provisioningStatus === "deleted";
    if (runner.provisioningStatus === "failed" && runner.providerResourceId) {
      cleaned = await cleanupAutomaticFailedRunner({
        connection: input.connection,
        provider: input.provider,
        context: input.context,
        runner: {
          id: runner.id,
          userId: input.userId,
          providerResourceId: runner.providerResourceId,
          providerFirewallId: runner.providerFirewallId,
          provisioningOperationKey: runner.provisioningOperationKey,
          region: runner.region,
          sizeSlug: runner.sizeSlug,
        },
        now: input.now,
        log,
      });
      if (!cleaned) {
        log("terminal_cleanup_pending", { providerResourceId: runner.providerResourceId }, "warn");
        return { ok: true, state: "pending" };
      }
    }
    return {
      ok: false,
      cleanupRequired: Boolean(runner.providerResourceId) && !cleaned,
      terminalCode: "runner_provisioning_unavailable",
    };
  }

  const operationTags = [
    ...new Set([...input.config.tags, DIGITALOCEAN_MANAGED_RUNNER_TAG, input.operationKey]),
  ].sort();

  log(
    "phase_observed",
    {
      attemptCount: input.attemptCount,
      maxAttempts: input.maxAttempts,
      provisioningStatus: runner.provisioningStatus,
      providerResourceId: runner.providerResourceId,
    },
    "debug",
  );

  if (runner.provisioningStatus === "pending" || runner.provisioningStatus === "creating") {
    const discovered = await input.provider.discoverResourcesByTag(
      { tag: input.operationKey },
      input.context,
    );

    if (!discovered.ok || !discovered.value.authoritative) {
      log(
        "resource_discovery_inconclusive",
        {
          attemptCount: input.attemptCount,
          maxAttempts: input.maxAttempts,
          reason: discovered.ok ? "non_authoritative" : discovered.reason,
        },
        input.attemptCount >= input.maxAttempts ? "error" : "warn",
      );
      if (input.attemptCount >= input.maxAttempts) {
        await markAutomaticProvisioningFailed(input, runner.providerResourceId);
        return {
          ok: false,
          cleanupRequired: Boolean(runner.providerResourceId),
          terminalCode: "runner_provisioning_outcome_unknown",
        };
      }

      return { ok: true, state: "pending" };
    }

    if (discovered.value.resources.length > 1) {
      log(
        "multiple_provider_resources_discovered",
        { resourceCount: discovered.value.resources.length },
        "error",
      );
      await markAutomaticProvisioningFailed(input, runner.providerResourceId);
      return {
        ok: false,
        cleanupRequired: true,
        terminalCode: "runner_provisioning_outcome_unknown",
      };
    }

    const adopted = discovered.value.resources[0];

    if (adopted) {
      log("provider_resource_adopted", {
        providerResourceId: adopted.providerResourceId,
      });
      await persistAutomaticProviderResource(input, adopted, "tagging");
      return { ok: true, state: "pending" };
    }

    if (runner.provisioningStatus === "creating") {
      if (input.attemptCount >= input.maxAttempts) {
        await markAutomaticProvisioningFailed(input, runner.providerResourceId);
        return {
          ok: false,
          cleanupRequired: Boolean(runner.providerResourceId),
          terminalCode: "runner_provisioning_outcome_unknown",
        };
      }

      return { ok: true, state: "pending" };
    }

    const generatedToken = createRunnerRegistrationToken();
    const createdAt = input.now();
    await input.connection.db.insert(runnerRegistrationTokens).values({
      userId: input.userId,
      runnerId: input.runnerId,
      tokenHash: generatedToken.hash,
      tokenPrefix: generatedToken.prefix,
      status: "pending",
      expiresAt: new Date(createdAt.getTime() + CLOUD_REGISTRATION_TOKEN_TTL_MS),
      createdAt,
      updatedAt: createdAt,
    });

    const sshAccess = await resolveDigitalOceanSshAccess(
      input.provider,
      input.config,
      { runnerId: input.runnerId },
      input.context,
      log,
    );

    if (!sshAccess.ok) {
      log("ssh_access_resolution_failed", { reason: sshAccess.reason }, "error");
      await markAutomaticProvisioningFailed(input, null);
      return {
        ok: false,
        cleanupRequired: false,
        terminalCode: "runner_provisioning_unavailable",
      };
    }

    const hermes = resolveHermesDeploymentConfig(input.config);
    const bootstrap = await buildProvisioningBootstrap({
      connection: input.connection,
      userId: input.userId,
      runnerId: input.runnerId,
      runnerName: runner.name,
      registrationToken: generatedToken.value,
      commandBearerToken: input.config.runnerBearerToken,
      runnerImage: input.config.runnerImage,
      hermesWorkloadImage: hermes.hermesWorkloadImage,
      hermesStateRoot: hermes.hermesStateRoot,
      hermesPrivateNetwork: hermes.hermesPrivateNetwork,
      hermesReadinessTimeoutMs: hermes.hermesReadinessTimeoutMs,
      runnerMaxAgents: hermes.runnerMaxAgents,
      ...(input.config.providerMode === "local_docker"
        ? { releaseIdentityMode: RUNNER_RELEASE_DEVELOPMENT_MODE }
        : {}),
      sizeSlug: input.config.sizeSlug,
      now: input.now,
      log,
    });
    log("provider_create_started", {
      region: input.config.region,
      sizeSlug: input.config.sizeSlug,
      image: input.config.image,
      sshKeyCount: sshAccess.sshKeyIds.length,
    });
    const created = await input.provider.createRunner(
      {
        name: input.operationKey,
        region: input.config.region,
        sizeSlug: input.config.sizeSlug,
        image: input.config.image,
        tags: operationTags,
        firewallName: DEFAULT_FIREWALL_NAME,
        sshKeyIds: sshAccess.sshKeyIds,
        userData: bootstrap.userData,
      },
      input.context,
    );

    if (!created.ok) {
      log(
        "provider_create_failed",
        { reason: created.reason },
        created.reason === "create_outcome_unknown" ? "warn" : "error",
      );
      if (created.reason === "create_outcome_unknown") {
        await setAutomaticProvisioningPhase(input, "creating");
        return { ok: true, state: "pending" };
      }

      await markAutomaticProvisioningFailed(input, null);
      return {
        ok: false,
        cleanupRequired: false,
        terminalCode: "runner_provisioning_unavailable",
      };
    }

    await persistAutomaticProviderResource(input, created.value, "tagging");
    log("provider_create_completed", {
      providerResourceId: created.value.providerResourceId,
      publicIpv4ResolvedInCreateResponse: Boolean(created.value.publicIpv4),
    });
    return { ok: true, state: "pending" };
  }

  if (!runner.providerResourceId) {
    await markAutomaticProvisioningFailed(input, null);
    return {
      ok: false,
      cleanupRequired: false,
      terminalCode: "runner_provisioning_unavailable",
    };
  }

  if (runner.provisioningStatus === "tagging") {
    const tagged = await input.provider.tagResource(
      { providerResourceId: runner.providerResourceId, tags: operationTags },
      input.context,
    );

    if (!tagged.ok) {
      log("provider_tagging_failed", { reason: tagged.reason }, "error");
      await markAutomaticProvisioningFailed(input, runner.providerResourceId);
      return {
        ok: false,
        cleanupRequired: true,
        terminalCode: "runner_provisioning_unavailable",
      };
    }

    await setAutomaticProvisioningPhase(input, "firewall_configuring");
    return { ok: true, state: "pending" };
  }

  if (runner.provisioningStatus === "firewall_configuring") {
    const firewalled = await input.provider.applyFirewall(
      {
        providerResourceId: runner.providerResourceId,
        firewallName: digitalOceanRunnerFirewallName(runner.providerResourceId),
        sshSourceAddresses: resolveSshSourceAddresses(input.config),
      },
      input.context,
    );

    if (!firewalled.ok) {
      log("provider_firewall_failed", { reason: firewalled.reason }, "error");
      await markAutomaticProvisioningFailed(input, runner.providerResourceId);
      return {
        ok: false,
        cleanupRequired: true,
        terminalCode: "runner_provisioning_unavailable",
      };
    }

    if (!firewalled.value.providerFirewallId) {
      log("provider_firewall_missing_id", {}, "error");
      await markAutomaticProvisioningFailed(input, runner.providerResourceId);
      return {
        ok: false,
        cleanupRequired: true,
        terminalCode: "runner_provisioning_unavailable",
      };
    }

    const endpointUrl = endpointForProviderResource(firewalled.value);
    await setAutomaticProvisioningPhase(
      input,
      endpointUrl ? "waiting_for_runner" : "bootstrapping",
      endpointUrl,
      firewalled.value.providerFirewallId,
    );
    log("provider_firewall_completed", {
      providerFirewallId: firewalled.value.providerFirewallId,
      endpointResolved: Boolean(endpointUrl),
    });
    return { ok: true, state: "pending" };
  }

  if (runner.provisioningStatus === "bootstrapping") {
    const refreshed = await input.provider.readResource(
      { providerResourceId: runner.providerResourceId },
      input.context,
    );

    if (!refreshed.ok) {
      log(
        "provider_resource_refresh_failed",
        { reason: refreshed.reason, attemptCount: input.attemptCount },
        input.attemptCount >= input.maxAttempts ? "error" : "warn",
      );
      if (input.attemptCount >= input.maxAttempts) {
        await markAutomaticProvisioningFailed(input, runner.providerResourceId);
        return {
          ok: false,
          cleanupRequired: true,
          terminalCode: "runner_provisioning_outcome_unknown",
        };
      }

      return { ok: true, state: "pending" };
    }

    const endpointUrl = endpointForProviderResource(refreshed.value);

    if (!endpointUrl) {
      log("public_endpoint_pending", {}, "debug");
      return { ok: true, state: "pending" };
    }

    await setAutomaticProvisioningPhase(input, "waiting_for_runner", endpointUrl);
    log("public_endpoint_resolved", { endpointUrl });
    return { ok: true, state: "pending" };
  }

  return { ok: true, state: "pending" };
}

async function cleanupAutomaticFailedRunner(input: {
  connection: DatabaseConnection;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  runner: {
    id: string;
    userId: string;
    providerResourceId: string;
    providerFirewallId: string | null;
    provisioningOperationKey: string | null;
    region: string | null;
    sizeSlug: string | null;
  };
  now: () => Date;
  log: ProvisioningLog;
}): Promise<boolean> {
  const owned = asOwnedSetProvider(input.provider);
  const operationKey = input.runner.provisioningOperationKey;
  const firewallId = input.runner.providerFirewallId;
  const region = input.runner.region;
  const sizeSlug = input.runner.sizeSlug;
  if (!owned || !operationKey || !firewallId || !region || !sizeSlug) return false;

  const expectation = {
    operationTag: operationKey,
    providerResourceId: input.runner.providerResourceId,
    providerFirewallId: firewallId,
    expectedName: operationKey,
    expectedRegion: region,
    expectedSizeSlug: sizeSlug,
    expectedFirewallName: digitalOceanRunnerFirewallName(input.runner.providerResourceId),
  };
  const observed = await owned.observeOwnedSet(expectation, input.context);
  if (!observed.ok) return false;

  if (observed.value.firewall === "present") {
    const deletedFirewall = await owned.deleteFirewall(expectation, input.context);
    if (!deletedFirewall.ok) return false;
  }
  if (observed.value.droplet === "present") {
    const deletedDroplet = await owned.deleteDroplet(expectation, input.context);
    if (!deletedDroplet.ok) return false;
  }

  const absent = await owned.observeOwnedSet(expectation, input.context);
  if (!absent.ok || absent.value.state !== "absent") return false;

  const deletedAt = input.now();
  const cleaned = await input.connection.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        provisioningError: null,
        provisioningCompletedAt: deletedAt,
        deletedAt,
        updatedAt: deletedAt,
      })
      .where(
        and(
          eq(runners.id, input.runner.id),
          eq(runners.userId, input.runner.userId),
          eq(runners.providerResourceId, input.runner.providerResourceId),
          eq(runners.provisioningStatus, "failed"),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });
    if (!updated) return false;

    await recordProvisioningEvent(tx, {
      userId: input.runner.userId,
      runnerId: input.runner.id,
      phase: "deleted",
      status: "completed",
      message: "Failed automatic DigitalOcean runner was cleaned up safely.",
      metadata: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: input.runner.providerResourceId,
      },
      now: deletedAt,
    });
    return true;
  });

  if (cleaned) {
    input.log("terminal_cleanup_completed", {
      runnerId: input.runner.id,
      providerResourceId: input.runner.providerResourceId,
    });
  }
  return cleaned;
}

function asOwnedSetProvider(provider: DigitalOceanProvider): DigitalOceanOwnedSetProvider | null {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;
  return typeof candidate.observeOwnedSet === "function" &&
    typeof candidate.deleteFirewall === "function" &&
    typeof candidate.deleteDroplet === "function"
    ? (candidate as DigitalOceanOwnedSetProvider)
    : null;
}

export function validateCreateRunnerProvisioningPayload(
  payload: unknown,
):
  | { ok: true; value: CreateRunnerProvisioningPayload }
  | { ok: false; issues: CreateRunnerProvisioningValidationIssue[] } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be an object." }],
    };
  }

  const input = payload as Record<string, unknown>;
  const issues: CreateRunnerProvisioningValidationIssue[] = [];
  const provider =
    typeof input.provider === "string" ? input.provider.trim() : DIGITALOCEAN_PROVIDER;
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : DEFAULT_CLOUD_RUNNER_NAME;

  if (provider !== DIGITALOCEAN_PROVIDER) {
    issues.push({ field: "provider", message: "Provider must be digitalocean." });
  }

  if (name.length > MAX_RUNNER_NAME_LENGTH) {
    issues.push({
      field: "name",
      message: `Runner name must be ${MAX_RUNNER_NAME_LENGTH} characters or fewer.`,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      provider: DIGITALOCEAN_PROVIDER,
      name,
    },
  };
}

export async function createDigitalOceanRunnerForDevelopmentUser(
  payload: unknown,
  dependencies: RunnerProvisioningDependencies = {},
): Promise<CreateRunnerProvisioningResult> {
  const validated = validateCreateRunnerProvisioningPayload(payload);

  if (!validated.ok) {
    logRunnerProvisioning("validation_failed", { issueCount: validated.issues.length });
    return { ok: false, reason: "validation_failed", issues: validated.issues };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const userId = await connection.db.transaction((tx) => getOrCreateDevelopmentUserId(tx));

    return await createDigitalOceanRunnerForUser(userId, validated.value, {
      ...dependencies,
      createConnection: () => connection,
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function createDigitalOceanRunnerForUser(
  userId: string,
  payload: unknown,
  dependencies: RunnerProvisioningDependencies = {},
): Promise<CreateRunnerProvisioningResult> {
  const validated = validateCreateRunnerProvisioningPayload(payload);

  if (!validated.ok) {
    logRunnerProvisioning("validation_failed", { issueCount: validated.issues.length });
    return { ok: false, reason: "validation_failed", issues: validated.issues };
  }

  const lifecycleId = randomUUID();
  const log = createRunnerProvisioningLog({
    lifecycle: "droplet_creation",
    lifecycleId,
    operationMode: "manual",
    userId,
  });
  const lifecycleStartedAt = Date.now();

  log("request_received", {
    provider: validated.value.provider,
    name: validated.value.name,
  });

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const operationStartedAt = now();
  const firewallNamePrefix = DEFAULT_FIREWALL_NAME;
  let resolvedConfig: DigitalOceanProviderConfig | null | undefined;
  let resolvedProvider: DigitalOceanProvider | undefined;
  const getConfig = () => {
    if (resolvedConfig === undefined) {
      resolvedConfig = dependencies.readConfig
        ? dependencies.readConfig()
        : readDigitalOceanProviderConfig();
    }

    return resolvedConfig;
  };

  try {
    const duplicate = await connection.db.transaction(async (tx) => {
      await reconcileTimedOutWaitingForRunnerRows(tx, userId, operationStartedAt);
      const duplicateRunner = await findActiveProvisioningRunner(tx, userId);

      return duplicateRunner ? await toRunnerProvisioningDto(tx, userId, duplicateRunner.id) : null;
    });

    if (duplicate) {
      const duplicateStillReusable = await verifyDuplicateRunnerStillReusable({
        connection,
        userId,
        duplicate,
        getConfig,
        getProvider: (config) => {
          resolvedProvider ??=
            dependencies.provider ?? createConfiguredDigitalOceanProvider(config);
          return resolvedProvider;
        },
        now: operationStartedAt,
      });

      if (!duplicateStillReusable) {
        log("duplicate_provider_resource_missing", {
          runnerId: duplicate.id,
          providerResourceId: duplicate.providerResourceId,
        });
      } else {
        log("duplicate_reused", {
          runnerId: duplicate.id,
          runnerStatus: duplicate.status,
          provisioningStatus: duplicate.provisioning.status,
          providerResourceId: duplicate.providerResourceId,
        });

        return {
          ok: true,
          duplicate: true,
          runner: duplicate,
        };
      }
    }

    const config = getConfig();

    if (!config) {
      log("provider_not_configured", {}, "error");
      return { ok: false, reason: "provider_not_configured" };
    }

    const managedTags = [...new Set([...config.tags, DIGITALOCEAN_MANAGED_RUNNER_TAG])].sort();
    const hermesConfig = resolveHermesDeploymentConfig(config);

    log("provider_config_loaded", {
      region: config.region,
      sizeSlug: config.sizeSlug,
      image: config.image,
      runnerImage: config.runnerImage,
      hermesWorkloadImage: hermesConfig.hermesWorkloadImage,
      hermesStateRoot: hermesConfig.hermesStateRoot,
      hermesPrivateNetwork: hermesConfig.hermesPrivateNetwork,
      hermesReadinessTimeoutMs: hermesConfig.hermesReadinessTimeoutMs,
      runnerMaxAgents: hermesConfig.runnerMaxAgents,
      releaseIdentityMode:
        config.providerMode === "local_docker" ? RUNNER_RELEASE_DEVELOPMENT_MODE : undefined,
      tagCount: managedTags.length,
      hasRunnerBearerToken: Boolean(config.runnerBearerToken),
      runnerBearerTokenFingerprint: fingerprintRunnerSecret(config.runnerBearerToken),
      sshKeyMode:
        config.sshKeyIds === undefined
          ? "auto"
          : config.sshKeyIds.length > 0
            ? "configured"
            : "disabled",
    });

    const provider =
      resolvedProvider ?? dependencies.provider ?? createConfiguredDigitalOceanProvider(config);
    const createRegistrationTokenDependency =
      dependencies.createRegistrationToken ?? createRunnerRegistrationToken;

    const initialized = await connection.db.transaction(async (tx) => {
      await reconcileTimedOutWaitingForRunnerRows(tx, userId, operationStartedAt);
      const duplicateRunner = await findActiveProvisioningRunner(tx, userId);

      if (duplicateRunner) {
        log("duplicate_reused_after_lock", { runnerId: duplicateRunner.id });
        return {
          duplicate: true,
          runner: await toRunnerProvisioningDto(tx, userId, duplicateRunner.id),
        };
      }

      const createdAt = operationStartedAt;
      const [runner] = await tx
        .insert(runners)
        .values({
          userId,
          name: validated.value.name,
          kind: DIGITALOCEAN_RUNNER_KIND,
          status: "provisioning",
          provider: DIGITALOCEAN_PROVIDER,
          region: config.region,
          sizeSlug: config.sizeSlug,
          image: config.image,
          requiredRunnerImageDigest: requiredRunnerImageDigestForProvider(config),
          provisioningStatus: "pending",
          provisioningStartedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: runners.id });

      if (!runner) {
        throw new Error("Provisioning runner insert returned no rows.");
      }

      log("runner_row_created", {
        runnerId: runner.id,
        region: config.region,
        sizeSlug: config.sizeSlug,
        image: config.image,
        runnerImage: config.runnerImage,
        hermesWorkloadImage: hermesConfig.hermesWorkloadImage,
        runnerMaxAgents: hermesConfig.runnerMaxAgents,
      });

      const registrationToken = createRegistrationTokenDependency();
      const expiresAt = new Date(createdAt.getTime() + CLOUD_REGISTRATION_TOKEN_TTL_MS);

      const [createdToken] = await tx
        .insert(runnerRegistrationTokens)
        .values({
          userId,
          runnerId: runner.id,
          tokenHash: registrationToken.hash,
          tokenPrefix: registrationToken.prefix,
          status: "pending",
          expiresAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: runnerRegistrationTokens.id });

      if (!createdToken) {
        throw new Error("Provisioning registration token insert returned no rows.");
      }

      await recordProvisioningEvent(tx, {
        userId,
        runnerId: runner.id,
        phase: "pending",
        status: "started",
        message: "DigitalOcean runner provisioning was accepted.",
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          region: config.region,
          sizeSlug: config.sizeSlug,
          image: config.image,
          runnerImage: config.runnerImage,
          hermesWorkloadImage: hermesConfig.hermesWorkloadImage,
          hermesPrivateNetwork: hermesConfig.hermesPrivateNetwork,
          runnerMaxAgents: hermesConfig.runnerMaxAgents,
          tags: managedTags,
          firewallNamePrefix,
        },
        now: createdAt,
      });

      return {
        duplicate: false,
        registrationToken: registrationToken.value,
        runner: await toRunnerProvisioningDto(tx, userId, runner.id),
      };
    });

    if (initialized.duplicate) {
      return {
        ok: true,
        duplicate: true,
        runner: initialized.runner,
      };
    }

    if (!initialized.registrationToken) {
      throw new Error("Provisioning registration token was not available for bootstrap.");
    }

    const runnerId = initialized.runner.id;
    const sshAccess = await resolveDigitalOceanSshAccess(
      provider,
      config,
      { runnerId },
      undefined,
      log,
    );

    if (!sshAccess.ok) {
      log(
        "ssh_key_resolution_failed",
        {
          runnerId,
          reason: sshAccess.reason,
        },
        "error",
      );

      await failProvisioning(connection, {
        userId,
        runnerId,
        phase: "creating",
        reason: sshAccess.reason,
        message: sshAccess.message,
        now: now(),
      });

      return {
        ok: true,
        duplicate: false,
        runner: await getRunnerProvisioningDto(connection, userId, runnerId),
      };
    }

    log("ssh_access_resolved", {
      runnerId,
      sshKeyCount: sshAccess.sshKeyIds.length,
      sshFirewallEnabled: sshAccess.sshSourceAddresses.length > 0,
    });

    const bootstrap = await buildProvisioningBootstrap({
      connection,
      userId,
      runnerId,
      runnerName: initialized.runner.name,
      registrationToken: initialized.registrationToken,
      commandBearerToken: config.runnerBearerToken,
      runnerImage: config.runnerImage,
      hermesWorkloadImage: hermesConfig.hermesWorkloadImage,
      hermesStateRoot: hermesConfig.hermesStateRoot,
      hermesPrivateNetwork: hermesConfig.hermesPrivateNetwork,
      hermesReadinessTimeoutMs: hermesConfig.hermesReadinessTimeoutMs,
      runnerMaxAgents: hermesConfig.runnerMaxAgents,
      ...(config.providerMode === "local_docker"
        ? { releaseIdentityMode: RUNNER_RELEASE_DEVELOPMENT_MODE }
        : {}),
      sizeSlug: initialized.runner.sizeSlug,
      now,
      log,
    });
    const resource = await runProviderStep(connection, {
      userId,
      provider,
      runnerId,
      phase: "creating",
      startedMessage: "Creating DigitalOcean Droplet.",
      completedMessage: "DigitalOcean Droplet was created.",
      safeFailureMessage:
        "DigitalOcean Droplet could not be created. Check provider quota, image, region, and token permissions.",
      failureReason: "create_failed",
      startedMetadata: {
        runnerImage: config.runnerImage,
        hermesWorkloadImage: hermesConfig.hermesWorkloadImage,
        runnerMaxAgents: hermesConfig.runnerMaxAgents,
        sshKeyCount: sshAccess.sshKeyIds.length,
      },
      now,
      log,
      execute: () =>
        provider.createRunner({
          name: initialized.runner.name,
          region: config.region,
          sizeSlug: config.sizeSlug,
          image: config.image,
          tags: managedTags,
          firewallName: firewallNamePrefix,
          sshKeyIds: sshAccess.sshKeyIds,
          userData: bootstrap.userData,
        }),
    });

    if (!resource.ok) {
      log(
        "provider_create_failed",
        {
          runnerId,
          reason: resource.reason,
        },
        "error",
      );

      return {
        ok: true,
        duplicate: false,
        runner: await getRunnerProvisioningDto(connection, userId, runnerId),
      };
    }

    log("provider_create_completed", {
      runnerId,
      providerResourceId: resource.value.providerResourceId,
      publicIpv4ResolvedInCreateResponse: Boolean(resource.value.publicIpv4),
    });

    const publicEndpointOptions: { attempts?: number; intervalMs?: number } = {};

    if (dependencies.publicEndpointPollAttempts !== undefined) {
      publicEndpointOptions.attempts = dependencies.publicEndpointPollAttempts;
    }

    if (dependencies.publicEndpointPollIntervalMs !== undefined) {
      publicEndpointOptions.intervalMs = dependencies.publicEndpointPollIntervalMs;
    }

    const publicEndpoint = await resolveDigitalOceanPublicEndpoint(
      provider,
      resource.value,
      publicEndpointOptions,
    );

    if (!publicEndpoint.ok) {
      log(
        "public_endpoint_resolution_failed",
        {
          runnerId,
          providerResourceId: resource.value.providerResourceId,
          reason: publicEndpoint.reason,
        },
        "error",
      );

      await failProvisioning(connection, {
        userId,
        runnerId,
        phase: "creating",
        reason: publicEndpoint.reason,
        message:
          "DigitalOcean Droplet did not expose a public IPv4 address for runner registration. Check Droplet networking and retry Create runner.",
        now: now(),
      });

      return {
        ok: true,
        duplicate: false,
        runner: await getRunnerProvisioningDto(connection, userId, runnerId),
      };
    }

    log("public_endpoint_resolved", {
      runnerId,
      providerResourceId: resource.value.providerResourceId,
      endpointUrl: publicEndpoint.endpointUrl,
    });

    await connection.db
      .update(runners)
      .set({
        endpointUrl: publicEndpoint.endpointUrl,
        updatedAt: now(),
      })
      .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)));

    const tagging = await runProviderStep(connection, {
      userId,
      provider,
      runnerId,
      phase: "tagging",
      startedMessage: "Applying DigitalOcean runner tags.",
      completedMessage: "DigitalOcean runner tags were applied.",
      safeFailureMessage:
        "DigitalOcean tags could not be applied. Check tag permissions and Droplet state.",
      failureReason: "tag_failed",
      now,
      log,
      execute: () =>
        provider.tagResource({
          providerResourceId: resource.value.providerResourceId,
          tags: managedTags,
        }),
    });

    if (!tagging.ok) {
      return {
        ok: true,
        duplicate: false,
        runner: await cleanupFailedProvisioningResource(connection, {
          userId,
          provider,
          runnerId,
          providerResourceId: resource.value.providerResourceId,
          failedPhase: "tagging",
          tags: managedTags,
          now,
          log,
        }),
      };
    }

    const afterTagging = await getRunnerProvisioningDto(connection, userId, runnerId);

    if (afterTagging.provisioning.status === "failed") {
      return {
        ok: true,
        duplicate: false,
        runner: afterTagging,
      };
    }

    const firewallName = digitalOceanRunnerFirewallName(resource.value.providerResourceId);
    const firewall = await runProviderStep(connection, {
      userId,
      provider,
      runnerId,
      phase: "firewall_configuring",
      startedMessage: "Applying DigitalOcean firewall intent.",
      completedMessage: "DigitalOcean firewall intent was recorded.",
      safeFailureMessage:
        "DigitalOcean firewall intent could not be applied. Check firewall permissions and Droplet state.",
      failureReason: "firewall_failed",
      firewallName,
      startedMetadata: {
        sshEnabled: sshAccess.sshSourceAddresses.length > 0,
        sshSourceAddresses: sshAccess.sshSourceAddresses,
      },
      now,
      log,
      execute: () =>
        provider.applyFirewall({
          providerResourceId: resource.value.providerResourceId,
          firewallName,
          sshSourceAddresses: sshAccess.sshSourceAddresses,
        }),
    });

    if (!firewall.ok) {
      return {
        ok: true,
        duplicate: false,
        runner: await cleanupFailedProvisioningResource(connection, {
          userId,
          provider,
          runnerId,
          providerResourceId: resource.value.providerResourceId,
          failedPhase: "firewall_configuring",
          tags: managedTags,
          now,
          log,
        }),
      };
    }

    const afterFirewall = await getRunnerProvisioningDto(connection, userId, runnerId);

    if (afterFirewall.provisioning.status === "failed") {
      return {
        ok: true,
        duplicate: false,
        runner: afterFirewall,
      };
    }

    await connection.db.transaction(async (tx) => {
      const transitionAt = now();
      await tx
        .update(runners)
        .set({
          status: "registering",
          provisioningStatus: "waiting_for_runner",
          updatedAt: transitionAt,
        })
        .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)));
      await recordProvisioningEvent(tx, {
        userId,
        runnerId,
        phase: "waiting_for_runner",
        status: "started",
        message: "Runner registration token is ready for bootstrap exchange.",
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          bootstrapExchange: "ready",
        },
        now: transitionAt,
      });
    });

    const result = {
      ok: true,
      duplicate: false,
      runner: await getRunnerProvisioningDto(connection, userId, runnerId),
    } as const;
    log("waiting_for_runner", {
      runnerId,
      durationMs: Date.now() - lifecycleStartedAt,
      provisioningStatus: result.runner.provisioning.status,
    });
    return result;
  } catch (error) {
    log("persistence_failed", { durationMs: Date.now() - lifecycleStartedAt }, "error", error);
    throw new RunnerProvisioningPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export function createConfiguredDigitalOceanProvider(
  config: DigitalOceanProviderConfig,
): DigitalOceanProvider {
  if (config.providerMode === "local_docker") {
    return new LocalDockerDigitalOceanProvider({
      ...(config.localAgentSmokeMode ? { agentSmokeMode: true } : {}),
      ...(config.localRunnerContainerName
        ? { containerName: config.localRunnerContainerName }
        : {}),
      ...(config.localRunnerEndpointUrl ? { endpointUrl: config.localRunnerEndpointUrl } : {}),
      ...(config.localRunnerStartDelayMs === undefined
        ? {}
        : { startDelayMs: config.localRunnerStartDelayMs }),
    });
  }

  return new DigitalOceanApiProvider({ token: config.token });
}

async function runProviderStep(
  connection: DatabaseConnection,
  input: {
    userId: string;
    provider: DigitalOceanProvider;
    runnerId: string;
    phase: Extract<RunnerProvisioningPhase, "creating" | "tagging" | "firewall_configuring">;
    startedMessage: string;
    completedMessage: string;
    safeFailureMessage: string;
    failureReason: DigitalOceanProviderErrorReason;
    firewallName?: string;
    startedMetadata?: Record<string, unknown>;
    now: () => Date;
    log: ProvisioningLog;
    execute: () => Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  },
): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
  await connection.db.transaction(async (tx) => {
    const startedAt = input.now();
    await tx
      .update(runners)
      .set({
        status: "provisioning",
        provisioningStatus: input.phase,
        updatedAt: startedAt,
      })
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
    await recordProvisioningEvent(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: input.phase,
      status: "started",
      message: input.startedMessage,
      metadata: { provider: DIGITALOCEAN_PROVIDER, ...input.startedMetadata },
      now: startedAt,
    });
  });

  let result: DigitalOceanProviderResult<DigitalOceanResource>;

  try {
    result = await input.execute();
  } catch (error) {
    input.log(
      "provider_step_threw",
      { runnerId: input.runnerId, phase: input.phase },
      "error",
      error,
    );
    result = {
      ok: false,
      reason: input.failureReason,
      message: input.safeFailureMessage,
    };
  }

  if (!result.ok) {
    input.log(
      "provider_step_failed",
      {
        runnerId: input.runnerId,
        phase: input.phase,
        reason: result.reason,
      },
      "error",
    );

    await failProvisioning(connection, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: input.phase,
      reason: result.reason,
      message: input.safeFailureMessage,
      now: input.now(),
    });

    return result;
  }

  if (input.phase === "firewall_configuring" && !result.value.providerFirewallId) {
    const invalidResult: DigitalOceanProviderResult<DigitalOceanResource> = {
      ok: false,
      reason: "firewall_failed",
      message: input.safeFailureMessage,
    };

    await failProvisioning(connection, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: input.phase,
      reason: invalidResult.reason,
      message: input.safeFailureMessage,
      now: input.now(),
    });

    return invalidResult;
  }

  await connection.db.transaction(async (tx) => {
    const completedAt = input.now();
    await tx
      .update(runners)
      .set({
        providerResourceId: result.value.providerResourceId,
        providerFirewallId: result.value.providerFirewallId,
        region: result.value.region,
        sizeSlug: result.value.sizeSlug,
        image: result.value.image,
        updatedAt: completedAt,
      })
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
    const metadata: Record<string, unknown> = {
      provider: result.value.provider,
      providerResourceId: result.value.providerResourceId,
      region: result.value.region,
      sizeSlug: result.value.sizeSlug,
      image: result.value.image,
      tags: result.value.tags,
      firewallApplied: result.value.firewallApplied,
    };

    if (input.phase === "firewall_configuring") {
      metadata.firewallName = input.firewallName ?? DEFAULT_FIREWALL_NAME;
    }

    await recordProvisioningEvent(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: input.phase,
      status: "completed",
      message: input.completedMessage,
      metadata,
      now: completedAt,
    });
  });

  return result;
}

async function verifyDuplicateRunnerStillReusable(input: {
  connection: DatabaseConnection;
  userId: string;
  duplicate: RunnerProvisioningDto;
  getConfig: () => DigitalOceanProviderConfig | null;
  getProvider: (config: DigitalOceanProviderConfig) => DigitalOceanProvider;
  now: Date;
}): Promise<boolean> {
  if (
    input.duplicate.provisioning.status !== "waiting_for_runner" ||
    !input.duplicate.providerResourceId
  ) {
    return true;
  }

  const config = input.getConfig();

  if (!config) {
    return true;
  }

  const provider = input.getProvider(config);
  const resource = await provider.readResource({
    providerResourceId: input.duplicate.providerResourceId,
  });

  if (resource.ok || resource.reason !== "resource_not_found") {
    return true;
  }

  await failProvisioning(input.connection, {
    userId: input.userId,
    runnerId: input.duplicate.id,
    phase: "waiting_for_runner",
    reason: "resource_not_found",
    message: missingProviderResourceMessage(input.duplicate.providerResourceId),
    now: input.now,
  });

  return false;
}

function missingProviderResourceMessage(providerResourceId: string): string {
  const safeResourceId = /^[A-Za-z0-9_.:-]{1,120}$/.test(providerResourceId)
    ? providerResourceId
    : "the recorded provider resource";

  return `DigitalOcean Droplet ${safeResourceId} is no longer available for runner registration. plingpling marked the stale runner failed and will create a new runner.`;
}

async function resolveDigitalOceanSshAccess(
  provider: DigitalOceanProvider,
  config: DigitalOceanProviderConfig,
  options: { runnerId: string },
  context?: DigitalOceanProviderRequestContext,
  log: ProvisioningLog = logRunnerProvisioning,
): Promise<
  | {
      ok: true;
      sshKeyIds: string[];
      sshSourceAddresses: string[];
    }
  | {
      ok: false;
      reason: Extract<
        DigitalOceanProviderErrorReason,
        "ssh_key_lookup_failed" | "ssh_key_create_failed"
      >;
      message: string;
    }
> {
  const configuredKeyIds = config.sshKeyIds;

  if (configuredKeyIds !== undefined) {
    const sshKeyIds = normalizeUniqueStrings(configuredKeyIds);

    return {
      ok: true,
      sshKeyIds,
      sshSourceAddresses: sshKeyIds.length > 0 ? resolveSshSourceAddresses(config) : [],
    };
  }

  const listedKeys = await provider.listSshKeys(context);

  if (!listedKeys.ok) {
    return {
      ok: false,
      reason: "ssh_key_lookup_failed",
      message:
        "DigitalOcean SSH keys could not be listed. Confirm the provider token has SSH key read permission, then retry Create runner.",
    };
  }

  const sshKeyIds = normalizeUniqueStrings(listedKeys.value.map((key) => key.id));

  if (sshKeyIds.length === 0) {
    log("ssh_key_auto_create_needed", {
      runnerId: options.runnerId,
      sshKeyName: MANAGED_SSH_KEY_NAME,
    });

    const createdKey = await provider.createSshKey(createManagedSshKeyInput(), context);

    if (!createdKey.ok) {
      return {
        ok: false,
        reason: "ssh_key_create_failed",
        message:
          "plingpling could not create a DigitalOcean SSH key for Droplet login. Confirm the provider token has SSH key create permission, then retry Create runner.",
      };
    }

    log("ssh_key_auto_create_completed", {
      runnerId: options.runnerId,
      sshKeyId: createdKey.value.id,
      sshKeyName: createdKey.value.name,
    });

    return {
      ok: true,
      sshKeyIds: [createdKey.value.id],
      sshSourceAddresses: resolveSshSourceAddresses(config),
    };
  }

  return {
    ok: true,
    sshKeyIds,
    sshSourceAddresses: resolveSshSourceAddresses(config),
  };
}

function createManagedSshKeyInput(): { name: string; publicKey: string } {
  const { publicKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "der", type: "spki" });
  const publicKeyBytes = Buffer.from(exported).subarray(-32);
  const opensshKey = Buffer.concat([
    opensshBuffer("ssh-ed25519"),
    opensshBuffer(publicKeyBytes),
  ]).toString("base64");

  return {
    name: MANAGED_SSH_KEY_NAME,
    publicKey: `ssh-ed25519 ${opensshKey} agentbay-managed-runner`,
  };
}

function opensshBuffer(value: string | Buffer): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);

  return Buffer.concat([length, bytes]);
}

function resolveSshSourceAddresses(config: DigitalOceanProviderConfig): string[] {
  return normalizeUniqueStrings(config.sshSourceAddresses ?? ["0.0.0.0/0", "::/0"]);
}

function resolveHermesDeploymentConfig(config: DigitalOceanProviderConfig): {
  hermesWorkloadImage: string;
  hermesStateRoot: string;
  hermesPrivateNetwork: string;
  hermesReadinessTimeoutMs: number;
  runnerMaxAgents: number;
} {
  return {
    hermesWorkloadImage: config.hermesWorkloadImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE,
    hermesStateRoot: config.hermesStateRoot ?? DEFAULT_HERMES_STATE_ROOT,
    hermesPrivateNetwork: config.hermesPrivateNetwork ?? DEFAULT_HERMES_PRIVATE_NETWORK,
    hermesReadinessTimeoutMs:
      config.hermesReadinessTimeoutMs ?? DEFAULT_HERMES_READINESS_TIMEOUT_MS,
    runnerMaxAgents: config.runnerMaxAgents ?? DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  };
}

function normalizeUniqueStrings(values: string[]): string[] {
  const normalizedValues = new Set<string>();
  for (const value of values) {
    const normalizedValue = value.trim();
    if (normalizedValue) normalizedValues.add(normalizedValue);
  }
  return [...normalizedValues].sort();
}

async function buildProvisioningBootstrap(input: {
  connection: DatabaseConnection;
  userId: string;
  runnerId: string;
  runnerName: string;
  registrationToken: string;
  commandBearerToken: string;
  runnerImage: string;
  hermesWorkloadImage?: string;
  hermesStateRoot?: string;
  hermesPrivateNetwork?: string;
  hermesReadinessTimeoutMs?: number;
  runnerMaxAgents?: number;
  releaseIdentityMode?: typeof RUNNER_RELEASE_DEVELOPMENT_MODE;
  sizeSlug: string;
  now: () => Date;
  log: ProvisioningLog;
}): Promise<CloudRunnerBootstrapContent> {
  const appBaseUrl = getServerEnv().NEXT_PUBLIC_APP_URL;
  const appUrl = new URL(appBaseUrl);

  input.log("bootstrap_callback_resolved", {
    runnerId: input.runnerId,
    appBaseUrlOrigin: appUrl.origin,
    appBaseUrlHostname: appUrl.hostname,
  });

  try {
    await input.connection.db.transaction((tx) =>
      assertOwnedRunner(tx, input.userId, input.runnerId),
    );

    return await buildCloudRunnerBootstrapForRunner({
      runnerId: input.runnerId,
      appBaseUrl,
      registrationToken: input.registrationToken,
      commandBearerToken: input.commandBearerToken,
      runnerImage: input.runnerImage,
      ...(input.hermesWorkloadImage ? { hermesWorkloadImage: input.hermesWorkloadImage } : {}),
      ...(input.hermesStateRoot ? { hermesStateRoot: input.hermesStateRoot } : {}),
      ...(input.hermesPrivateNetwork ? { hermesPrivateNetwork: input.hermesPrivateNetwork } : {}),
      ...(input.hermesReadinessTimeoutMs === undefined
        ? {}
        : { hermesReadinessTimeoutMs: input.hermesReadinessTimeoutMs }),
      ...(input.runnerMaxAgents === undefined ? {} : { runnerMaxAgents: input.runnerMaxAgents }),
      ...(input.releaseIdentityMode ? { releaseIdentityMode: input.releaseIdentityMode } : {}),
      bootModelCanaryEnabled: input.releaseIdentityMode === RUNNER_RELEASE_DEVELOPMENT_MODE,
      endpointDiscovery: { type: "digitalocean_metadata" },
      enableSwap: LOW_MEMORY_DIGITALOCEAN_SIZE_SLUGS.has(input.sizeSlug),
      runnerName: input.runnerName,
      createConnection: () => input.connection,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof Error) {
      error.message = redactCloudRunnerBootstrapOutput(error.message);
    }

    throw error;
  }
}

async function resolveDigitalOceanPublicEndpoint(
  provider: DigitalOceanProvider,
  resource: DigitalOceanResource,
  options: {
    attempts?: number;
    intervalMs?: number;
  } = {},
): Promise<
  | {
      ok: true;
      endpointUrl: string;
    }
  | {
      ok: false;
      reason: DigitalOceanProviderErrorReason;
    }
> {
  if (resource.publicEndpointUrl) {
    return { ok: true, endpointUrl: resource.publicEndpointUrl };
  }

  const publicIpv4 = normalizePublicIpv4(resource.publicIpv4);

  if (publicIpv4) {
    return { ok: true, endpointUrl: publicIpv4ToSslipEndpoint(publicIpv4) };
  }

  const attempts = normalizePositiveInteger(options.attempts, PUBLIC_ENDPOINT_POLL_ATTEMPTS);
  const intervalMs = normalizeNonNegativeInteger(
    options.intervalMs,
    PUBLIC_ENDPOINT_POLL_INTERVAL_MS,
  );
  let lastFailureReason: DigitalOceanProviderErrorReason = "resource_not_found";

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const refreshed = await provider.readResource({
      providerResourceId: resource.providerResourceId,
    });

    if (!refreshed.ok) {
      lastFailureReason = refreshed.reason;
    } else {
      if (refreshed.value.publicEndpointUrl) {
        return { ok: true, endpointUrl: refreshed.value.publicEndpointUrl };
      }

      const refreshedPublicIpv4 = normalizePublicIpv4(refreshed.value.publicIpv4);

      if (refreshedPublicIpv4) {
        return { ok: true, endpointUrl: publicIpv4ToSslipEndpoint(refreshedPublicIpv4) };
      }
    }

    if (attempt < attempts - 1 && intervalMs > 0) {
      await delay(intervalMs);
    }
  }

  return { ok: false, reason: lastFailureReason };
}

function publicIpv4ToSslipEndpoint(publicIpv4: string): string {
  return `https://${publicIpv4.replaceAll(".", "-")}.sslip.io`;
}

function endpointForProviderResource(resource: DigitalOceanResource): string | null {
  if (resource.publicEndpointUrl) {
    return resource.publicEndpointUrl;
  }

  const publicIpv4 = normalizePublicIpv4(resource.publicIpv4);
  return publicIpv4 ? publicIpv4ToSslipEndpoint(publicIpv4) : null;
}

export function digitalOceanRunnerFirewallName(providerResourceId: string): string {
  const suffix = providerResourceId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");

  return suffix ? `${DEFAULT_FIREWALL_NAME}-${suffix}` : DEFAULT_FIREWALL_NAME;
}

function normalizePublicIpv4(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  const parts = normalized.split(".");

  if (parts.length !== 4) {
    return null;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const parsed = Number(part);

    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
  })
    ? normalized
    : null;
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistAutomaticProviderResource(
  input: Parameters<typeof advanceAutomaticDigitalOceanRunnerProvisioning>[0],
  resource: DigitalOceanResource,
  phase: RunnerProvisioningPhase,
): Promise<void> {
  const now = input.now();
  await input.connection.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runners)
      .set({
        providerResourceId: resource.providerResourceId,
        providerFirewallId: resource.providerFirewallId,
        endpointUrl: endpointForProviderResource(resource),
        provisioningStatus: phase,
        updatedAt: now,
      })
      .where(
        and(
          eq(runners.id, input.runnerId),
          eq(runners.userId, input.userId),
          eq(runners.provisioningOperationKey, input.operationKey),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });

    if (updated) {
      await recordProvisioningEvent(tx, {
        userId: input.userId,
        runnerId: input.runnerId,
        phase,
        status: "completed",
        message: automaticProvisioningPhaseMessage(phase),
        metadata: { provider: DIGITALOCEAN_PROVIDER },
        now,
      });
    }
  });
}

async function setAutomaticProvisioningPhase(
  input: Parameters<typeof advanceAutomaticDigitalOceanRunnerProvisioning>[0],
  phase: RunnerProvisioningPhase,
  endpointUrl?: string | null,
  providerFirewallId?: string | null,
): Promise<void> {
  const now = input.now();
  await input.connection.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runners)
      .set({
        provisioningStatus: phase,
        ...(endpointUrl ? { endpointUrl } : {}),
        ...(providerFirewallId ? { providerFirewallId } : {}),
        ...(phase === "waiting_for_runner" ? { status: "registering" } : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(runners.id, input.runnerId),
          eq(runners.userId, input.userId),
          eq(runners.provisioningOperationKey, input.operationKey),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });

    if (updated) {
      await recordProvisioningEvent(tx, {
        userId: input.userId,
        runnerId: input.runnerId,
        phase,
        status: "started",
        message: automaticProvisioningPhaseMessage(phase),
        metadata: { provider: DIGITALOCEAN_PROVIDER },
        now,
      });
    }
  });
}

async function markAutomaticProvisioningFailed(
  input: Parameters<typeof advanceAutomaticDigitalOceanRunnerProvisioning>[0],
  providerResourceId: string | null,
): Promise<void> {
  const now = input.now();
  await input.connection.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(runners)
      .set({
        status: "provision_failed",
        provisioningStatus: "failed",
        provisioningError: providerResourceId
          ? "Automatic provisioning failed and provider cleanup requires confirmation."
          : "Automatic provisioning failed safely.",
        provisioningCompletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runners.id, input.runnerId),
          eq(runners.userId, input.userId),
          eq(runners.provisioningOperationKey, input.operationKey),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });

    if (updated) {
      await recordProvisioningEvent(tx, {
        userId: input.userId,
        runnerId: input.runnerId,
        phase: "failed",
        status: "failed",
        message: "Automatic DigitalOcean runner provisioning failed safely.",
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          cleanupRequired: Boolean(providerResourceId),
        },
        now,
      });
    }
  });
}

function automaticProvisioningPhaseMessage(phase: RunnerProvisioningPhase): string {
  if (phase === "creating") {
    return "Automatic DigitalOcean resource creation is awaiting discovery.";
  }

  if (phase === "tagging") {
    return "Automatic DigitalOcean resource discovery or creation completed.";
  }

  if (phase === "firewall_configuring") {
    return "Automatic DigitalOcean resource tags were confirmed.";
  }

  if (phase === "bootstrapping") {
    return "Automatic DigitalOcean network policy was confirmed; endpoint discovery is pending.";
  }

  return "Automatic DigitalOcean runner registration is pending.";
}

async function failProvisioning(
  connection: DatabaseConnection,
  input: {
    userId: string;
    runnerId: string;
    phase: RunnerProvisioningPhase;
    reason: DigitalOceanProviderErrorReason;
    message: string;
    now: Date;
  },
): Promise<void> {
  await connection.db.transaction(async (tx) => {
    await tx
      .update(runners)
      .set({
        status: "provision_failed",
        provisioningStatus: "failed",
        provisioningError: input.message,
        provisioningCompletedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
    await recordProvisioningEvent(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: "failed",
      status: "failed",
      message: input.message,
      metadata: {
        provider: DIGITALOCEAN_PROVIDER,
        failedPhase: input.phase,
        reason: input.reason,
      },
      now: input.now,
    });
  });
}

async function cleanupFailedProvisioningResource(
  connection: DatabaseConnection,
  input: {
    userId: string;
    provider: DigitalOceanProvider;
    runnerId: string;
    providerResourceId: string;
    failedPhase: RunnerProvisioningPhase;
    tags: string[];
    now: () => Date;
    log: ProvisioningLog;
  },
): Promise<RunnerProvisioningDto> {
  await connection.db.transaction(async (tx) => {
    const cleaningAt = input.now();
    await tx
      .update(runners)
      .set({
        status: "deleting",
        provisioningStatus: "cleaning_up",
        updatedAt: cleaningAt,
      })
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
    await recordProvisioningEvent(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: "cleaning_up",
      status: "started",
      message: "Provisioning failed after Droplet creation; attempting owned resource cleanup.",
      metadata: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: input.providerResourceId,
        failedPhase: input.failedPhase,
        tags: input.tags,
      },
      now: cleaningAt,
    });
  });

  const cleanup = await input.provider.cleanupResource({
    providerResourceId: input.providerResourceId,
  });

  if (cleanup.ok) {
    input.log("cleanup_completed", {
      runnerId: input.runnerId,
      providerResourceId: input.providerResourceId,
      failedPhase: input.failedPhase,
    });

    await connection.db.transaction(async (tx) => {
      const deletedAt = input.now();
      await tx
        .update(runners)
        .set({
          status: "deleted",
          provisioningStatus: "deleted",
          provisioningError: null,
          provisioningCompletedAt: deletedAt,
          deletedAt,
          updatedAt: deletedAt,
        })
        .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
      await recordProvisioningEvent(tx, {
        userId: input.userId,
        runnerId: input.runnerId,
        phase: "deleted",
        status: "completed",
        message: "Failed DigitalOcean runner was cleaned up safely.",
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          providerResourceId: input.providerResourceId,
          failedPhase: input.failedPhase,
          tags: input.tags,
        },
        now: deletedAt,
      });
    });

    return getRunnerProvisioningDto(connection, input.userId, input.runnerId);
  }

  const message = manualCleanupMessage(input.providerResourceId);
  input.log(
    "cleanup_failed",
    {
      runnerId: input.runnerId,
      providerResourceId: input.providerResourceId,
      failedPhase: input.failedPhase,
      reason: cleanup.reason,
    },
    "error",
  );

  await connection.db.transaction(async (tx) => {
    const failedCleanupAt = input.now();
    await tx
      .update(runners)
      .set({
        status: "provision_failed",
        provisioningStatus: "failed",
        provisioningError: message,
        provisioningCompletedAt: failedCleanupAt,
        updatedAt: failedCleanupAt,
      })
      .where(and(eq(runners.id, input.runnerId), eq(runners.userId, input.userId)));
    await recordProvisioningEvent(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      phase: "cleaning_up",
      status: "failed",
      message,
      metadata: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: input.providerResourceId,
        failedPhase: input.failedPhase,
        cleanupReason: cleanup.reason,
        tags: input.tags,
      },
      now: failedCleanupAt,
    });
  });

  return getRunnerProvisioningDto(connection, input.userId, input.runnerId);
}

function manualCleanupMessage(providerResourceId: string): string {
  const safeResourceId = /^[A-Za-z0-9_.:-]{1,120}$/.test(providerResourceId)
    ? providerResourceId
    : "the recorded provider resource";

  return `Automatic cleanup could not confirm deletion for DigitalOcean Droplet ${safeResourceId}. In DigitalOcean, delete only that Droplet after confirming it has the plingpling runner tags, then create a new runner.`;
}

async function findActiveProvisioningRunner(
  tx: RunnerProvisioningTransaction,
  userId: string,
): Promise<{ id: string } | null> {
  const [runner] = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.userId, userId),
        eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
        inArray(runners.provisioningStatus, [
          "pending",
          "creating",
          "tagging",
          "firewall_configuring",
          "bootstrapping",
          "waiting_for_runner",
        ]),
        isNull(runners.deletedAt),
      ),
    )
    .orderBy(desc(runners.createdAt))
    .limit(1);

  return runner ?? null;
}

async function assertOwnedRunner(
  tx: RunnerProvisioningTransaction,
  userId: string,
  runnerId: string,
): Promise<void> {
  const [runner] = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)))
    .limit(1);

  if (!runner) {
    throw new Error("DigitalOcean provisioning runner was not found.");
  }
}

async function recordProvisioningEvent(
  tx: RunnerProvisioningTransaction,
  input: {
    userId: string;
    runnerId: string;
    phase: RunnerProvisioningPhase;
    status: RunnerProvisioningEventStatus;
    message: string;
    metadata: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await assertOwnedRunner(tx, input.userId, input.runnerId);

  await tx.insert(runnerProvisioningEvents).values({
    runnerId: input.runnerId,
    phase: input.phase,
    status: input.status,
    message: input.message,
    metadata: input.metadata,
    createdAt: input.now,
  });
}

async function getRunnerProvisioningDto(
  connection: DatabaseConnection,
  userId: string,
  runnerId: string,
): Promise<RunnerProvisioningDto> {
  return await connection.db.transaction((tx) => toRunnerProvisioningDto(tx, userId, runnerId));
}

async function toRunnerProvisioningDto(
  tx: RunnerProvisioningTransaction,
  userId: string,
  runnerId: string,
): Promise<RunnerProvisioningDto> {
  const [runner] = await tx
    .select({
      id: runners.id,
      name: runners.name,
      kind: runners.kind,
      status: runners.status,
      provider: runners.provider,
      providerResourceId: runners.providerResourceId,
      region: runners.region,
      sizeSlug: runners.sizeSlug,
      image: runners.image,
      provisioningStatus: runners.provisioningStatus,
      provisioningError: runners.provisioningError,
      provisioningStartedAt: runners.provisioningStartedAt,
      provisioningCompletedAt: runners.provisioningCompletedAt,
    })
    .from(runners)
    .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)))
    .limit(1);

  if (
    !runner ||
    runner.kind !== DIGITALOCEAN_RUNNER_KIND ||
    runner.provider !== DIGITALOCEAN_PROVIDER ||
    !runner.region ||
    !runner.sizeSlug ||
    !runner.image ||
    !runner.provisioningStatus ||
    !runner.provisioningStartedAt
  ) {
    throw new Error("DigitalOcean provisioning runner was not found.");
  }

  const events = await tx
    .select({
      phase: runnerProvisioningEvents.phase,
      status: runnerProvisioningEvents.status,
      message: runnerProvisioningEvents.message,
      metadata: runnerProvisioningEvents.metadata,
      createdAt: runnerProvisioningEvents.createdAt,
    })
    .from(runnerProvisioningEvents)
    .where(eq(runnerProvisioningEvents.runnerId, runnerId))
    .orderBy(asc(runnerProvisioningEvents.createdAt));

  return {
    id: runner.id,
    name: runner.name,
    kind: DIGITALOCEAN_RUNNER_KIND,
    status: runner.status,
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: runner.providerResourceId,
    region: runner.region,
    sizeSlug: runner.sizeSlug,
    image: runner.image,
    provisioning: {
      status: runner.provisioningStatus as RunnerProvisioningPhase,
      error: runner.provisioningError,
      startedAt: runner.provisioningStartedAt.toISOString(),
      completedAt: runner.provisioningCompletedAt
        ? runner.provisioningCompletedAt.toISOString()
        : null,
      phases: events.map((event) => ({
        phase: event.phase as RunnerProvisioningPhase,
        status: event.status as RunnerProvisioningEventStatus,
        message: event.message,
        metadata: event.metadata,
        createdAt: event.createdAt.toISOString(),
      })),
    },
  };
}

function createRunnerProvisioningLog(bindings: Record<string, unknown>): ProvisioningLog {
  const logger = runnerProvisioningLogger.child(bindings);

  return (event, metadata = {}, level = "info", error) => {
    if (process.env.NODE_ENV === "test") {
      return;
    }

    if (error !== undefined) {
      logger.error(event, error, metadata);
      return;
    }

    if (level === "error") {
      logger.errorEvent(event, metadata);
      return;
    }

    logger[level](event, metadata);
  };
}

function logRunnerProvisioning(
  event: string,
  metadata: Record<string, unknown> = {},
  level: ProvisioningLogLevel = "info",
  error?: unknown,
): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  if (error !== undefined) {
    runnerProvisioningLogger.error(event, error, metadata);
    return;
  }

  if (level === "error") {
    runnerProvisioningLogger.errorEvent(event, metadata);
    return;
  }

  runnerProvisioningLogger[level](event, metadata);
}
