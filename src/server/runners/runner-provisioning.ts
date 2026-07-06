import "server-only";

import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import { getServerEnv, readDigitalOceanProviderConfig } from "@/src/server/env";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import {
  buildCloudRunnerBootstrapForRunner,
  redactCloudRunnerBootstrapOutput,
  type CloudRunnerBootstrapContent,
} from "@/src/server/runners/cloud-runner-bootstrap";
import {
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
  DigitalOceanApiProvider,
  type DigitalOceanProvider,
  type DigitalOceanProviderErrorReason,
  type DigitalOceanProviderResult,
  type DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";
import {
  createRunnerRegistrationToken,
  type GeneratedRunnerSecret,
} from "@/src/server/runners/runner-auth-secrets";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";

const DEFAULT_CLOUD_RUNNER_NAME = "AgentBay Cloud Runner";
const DEFAULT_FIREWALL_NAME = "agentbay-runners";
const CLOUD_REGISTRATION_TOKEN_TTL_MS = 60 * 60 * 1000;
const PUBLIC_ENDPOINT_POLL_ATTEMPTS = 20;
const PUBLIC_ENDPOINT_POLL_INTERVAL_MS = 3_000;
const LOW_MEMORY_DIGITALOCEAN_SIZE_SLUGS = new Set(["s-1vcpu-512mb-10gb"]);
const MAX_RUNNER_NAME_LENGTH = 80;

type RunnerProvisioningTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

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
  dependencies: {
    createConnection?: () => DatabaseConnection;
    provider?: DigitalOceanProvider;
    readConfig?: () => DigitalOceanProviderConfig | null;
    createRegistrationToken?: () => GeneratedRunnerSecret;
    publicEndpointPollAttempts?: number;
    publicEndpointPollIntervalMs?: number;
    now?: () => Date;
  } = {},
): Promise<CreateRunnerProvisioningResult> {
  const validated = validateCreateRunnerProvisioningPayload(payload);

  if (!validated.ok) {
    logRunnerProvisioning("validation_failed", { issueCount: validated.issues.length });
    return { ok: false, reason: "validation_failed", issues: validated.issues };
  }

  logRunnerProvisioning("request_received", {
    provider: validated.value.provider,
    name: validated.value.name,
  });

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const firewallNamePrefix = DEFAULT_FIREWALL_NAME;

  try {
    const duplicate = await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);
      const duplicateRunner = await findActiveProvisioningRunner(tx, userId);

      return duplicateRunner ? await toRunnerProvisioningDto(tx, duplicateRunner.id) : null;
    });

    if (duplicate) {
      logRunnerProvisioning("duplicate_reused", {
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

    const config = dependencies.readConfig?.() ?? readDigitalOceanProviderConfig();

    if (!config) {
      logRunnerProvisioning("provider_not_configured", {});
      return { ok: false, reason: "provider_not_configured" };
    }

    logRunnerProvisioning("provider_config_loaded", {
      region: config.region,
      sizeSlug: config.sizeSlug,
      image: config.image,
      tagCount: config.tags.length,
      hasRunnerBearerToken: Boolean(config.runnerBearerToken),
    });

    const provider = dependencies.provider ?? new DigitalOceanApiProvider({ token: config.token });
    const createRegistrationTokenDependency =
      dependencies.createRegistrationToken ?? createRunnerRegistrationToken;

    const initialized = await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);
      const duplicateRunner = await findActiveProvisioningRunner(tx, userId);

      if (duplicateRunner) {
        logRunnerProvisioning("duplicate_reused_after_lock", { runnerId: duplicateRunner.id });
        return {
          duplicate: true,
          runner: await toRunnerProvisioningDto(tx, duplicateRunner.id),
        };
      }

      const createdAt = now();
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
          provisioningStatus: "pending",
          provisioningStartedAt: createdAt,
          createdAt,
          updatedAt: createdAt,
        })
        .returning({ id: runners.id });

      if (!runner) {
        throw new Error("Provisioning runner insert returned no rows.");
      }

      logRunnerProvisioning("runner_row_created", {
        runnerId: runner.id,
        region: config.region,
        sizeSlug: config.sizeSlug,
        image: config.image,
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
        runnerId: runner.id,
        phase: "pending",
        status: "started",
        message: "DigitalOcean runner provisioning was accepted.",
        metadata: {
          provider: DIGITALOCEAN_PROVIDER,
          region: config.region,
          sizeSlug: config.sizeSlug,
          image: config.image,
          tags: config.tags,
          firewallNamePrefix,
        },
        now: createdAt,
      });

      return {
        duplicate: false,
        registrationToken: registrationToken.value,
        runner: await toRunnerProvisioningDto(tx, runner.id),
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
    const bootstrap = await buildProvisioningBootstrap({
      connection,
      runnerId,
      runnerName: initialized.runner.name,
      registrationToken: initialized.registrationToken,
      commandBearerToken: config.runnerBearerToken,
      sizeSlug: initialized.runner.sizeSlug,
      now,
    });
    const resource = await runProviderStep(connection, {
      provider,
      runnerId,
      phase: "creating",
      startedMessage: "Creating DigitalOcean Droplet.",
      completedMessage: "DigitalOcean Droplet was created.",
      safeFailureMessage:
        "DigitalOcean Droplet could not be created. Check provider quota, image, region, and token permissions.",
      failureReason: "create_failed",
      now,
      execute: () =>
        provider.createRunner({
          name: initialized.runner.name,
          region: config.region,
          sizeSlug: config.sizeSlug,
          image: config.image,
          tags: config.tags,
          firewallName: firewallNamePrefix,
          userData: bootstrap.userData,
        }),
    });

    if (!resource.ok) {
      logRunnerProvisioning("provider_create_failed", {
        runnerId,
        reason: resource.reason,
      });

      return {
        ok: true,
        duplicate: false,
        runner: await getRunnerProvisioningDto(connection, runnerId),
      };
    }

    logRunnerProvisioning("provider_create_completed", {
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
      logRunnerProvisioning("public_endpoint_resolution_failed", {
        runnerId,
        providerResourceId: resource.value.providerResourceId,
        reason: publicEndpoint.reason,
      });

      await failProvisioning(connection, {
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
        runner: await getRunnerProvisioningDto(connection, runnerId),
      };
    }

    logRunnerProvisioning("public_endpoint_resolved", {
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
      .where(eq(runners.id, runnerId));

    const tagging = await runProviderStep(connection, {
      provider,
      runnerId,
      phase: "tagging",
      startedMessage: "Applying DigitalOcean runner tags.",
      completedMessage: "DigitalOcean runner tags were applied.",
      safeFailureMessage:
        "DigitalOcean tags could not be applied. Check tag permissions and Droplet state.",
      failureReason: "tag_failed",
      now,
      execute: () =>
        provider.tagResource({
          providerResourceId: resource.value.providerResourceId,
          tags: config.tags,
        }),
    });

    if (!tagging.ok) {
      return {
        ok: true,
        duplicate: false,
        runner: await cleanupFailedProvisioningResource(connection, {
          provider,
          runnerId,
          providerResourceId: resource.value.providerResourceId,
          failedPhase: "tagging",
          tags: config.tags,
          now,
        }),
      };
    }

    const afterTagging = await getRunnerProvisioningDto(connection, runnerId);

    if (afterTagging.provisioning.status === "failed") {
      return {
        ok: true,
        duplicate: false,
        runner: afterTagging,
      };
    }

    const firewallName = toRunnerFirewallName(resource.value.providerResourceId);
    const firewall = await runProviderStep(connection, {
      provider,
      runnerId,
      phase: "firewall_configuring",
      startedMessage: "Applying DigitalOcean firewall intent.",
      completedMessage: "DigitalOcean firewall intent was recorded.",
      safeFailureMessage:
        "DigitalOcean firewall intent could not be applied. Check firewall permissions and Droplet state.",
      failureReason: "firewall_failed",
      firewallName,
      now,
      execute: () =>
        provider.applyFirewall({
          providerResourceId: resource.value.providerResourceId,
          firewallName,
        }),
    });

    if (!firewall.ok) {
      return {
        ok: true,
        duplicate: false,
        runner: await cleanupFailedProvisioningResource(connection, {
          provider,
          runnerId,
          providerResourceId: resource.value.providerResourceId,
          failedPhase: "firewall_configuring",
          tags: config.tags,
          now,
        }),
      };
    }

    const afterFirewall = await getRunnerProvisioningDto(connection, runnerId);

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
        .where(eq(runners.id, runnerId));
      await recordProvisioningEvent(tx, {
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

    return {
      ok: true,
      duplicate: false,
      runner: await getRunnerProvisioningDto(connection, runnerId),
    };
  } catch (error) {
    throw new RunnerProvisioningPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function runProviderStep(
  connection: DatabaseConnection,
  input: {
    provider: DigitalOceanProvider;
    runnerId: string;
    phase: Extract<RunnerProvisioningPhase, "creating" | "tagging" | "firewall_configuring">;
    startedMessage: string;
    completedMessage: string;
    safeFailureMessage: string;
    failureReason: DigitalOceanProviderErrorReason;
    firewallName?: string;
    now: () => Date;
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
      .where(eq(runners.id, input.runnerId));
    await recordProvisioningEvent(tx, {
      runnerId: input.runnerId,
      phase: input.phase,
      status: "started",
      message: input.startedMessage,
      metadata: { provider: DIGITALOCEAN_PROVIDER },
      now: startedAt,
    });
  });

  let result: DigitalOceanProviderResult<DigitalOceanResource>;

  try {
    result = await input.execute();
  } catch {
    result = {
      ok: false,
      reason: input.failureReason,
      message: input.safeFailureMessage,
    };
  }

  if (!result.ok) {
    logRunnerProvisioning("provider_step_failed", {
      runnerId: input.runnerId,
      phase: input.phase,
      reason: result.reason,
    });

    await failProvisioning(connection, {
      runnerId: input.runnerId,
      phase: input.phase,
      reason: result.reason,
      message: input.safeFailureMessage,
      now: input.now(),
    });

    return result;
  }

  await connection.db.transaction(async (tx) => {
    const completedAt = input.now();
    await tx
      .update(runners)
      .set({
        providerResourceId: result.value.providerResourceId,
        region: result.value.region,
        sizeSlug: result.value.sizeSlug,
        image: result.value.image,
        updatedAt: completedAt,
      })
      .where(eq(runners.id, input.runnerId));
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

async function buildProvisioningBootstrap(input: {
  connection: DatabaseConnection;
  runnerId: string;
  runnerName: string;
  registrationToken: string;
  commandBearerToken: string;
  sizeSlug: string;
  now: () => Date;
}): Promise<CloudRunnerBootstrapContent> {
  const appBaseUrl = getServerEnv().NEXT_PUBLIC_APP_URL;

  try {
    return await buildCloudRunnerBootstrapForRunner({
      runnerId: input.runnerId,
      appBaseUrl,
      registrationToken: input.registrationToken,
      commandBearerToken: input.commandBearerToken,
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

function toRunnerFirewallName(providerResourceId: string): string {
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

async function failProvisioning(
  connection: DatabaseConnection,
  input: {
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
      .where(eq(runners.id, input.runnerId));
    await recordProvisioningEvent(tx, {
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
    provider: DigitalOceanProvider;
    runnerId: string;
    providerResourceId: string;
    failedPhase: RunnerProvisioningPhase;
    tags: string[];
    now: () => Date;
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
      .where(eq(runners.id, input.runnerId));
    await recordProvisioningEvent(tx, {
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
    logRunnerProvisioning("cleanup_completed", {
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
        .where(eq(runners.id, input.runnerId));
      await recordProvisioningEvent(tx, {
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

    return getRunnerProvisioningDto(connection, input.runnerId);
  }

  const message = manualCleanupMessage(input.providerResourceId);
  logRunnerProvisioning("cleanup_failed", {
    runnerId: input.runnerId,
    providerResourceId: input.providerResourceId,
    failedPhase: input.failedPhase,
    reason: cleanup.reason,
  });

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
      .where(eq(runners.id, input.runnerId));
    await recordProvisioningEvent(tx, {
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

  return getRunnerProvisioningDto(connection, input.runnerId);
}

function manualCleanupMessage(providerResourceId: string): string {
  const safeResourceId = /^[A-Za-z0-9_.:-]{1,120}$/.test(providerResourceId)
    ? providerResourceId
    : "the recorded provider resource";

  return `Automatic cleanup could not confirm deletion for DigitalOcean Droplet ${safeResourceId}. In DigitalOcean, delete only that Droplet after confirming it has the AgentBay runner tags, then create a new runner.`;
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

async function recordProvisioningEvent(
  tx: RunnerProvisioningTransaction,
  input: {
    runnerId: string;
    phase: RunnerProvisioningPhase;
    status: RunnerProvisioningEventStatus;
    message: string;
    metadata: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
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
  runnerId: string,
): Promise<RunnerProvisioningDto> {
  return await connection.db.transaction((tx) => toRunnerProvisioningDto(tx, runnerId));
}

async function toRunnerProvisioningDto(
  tx: RunnerProvisioningTransaction,
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
    .where(eq(runners.id, runnerId))
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

function logRunnerProvisioning(event: string, metadata: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "test") {
    return;
  }

  console.info("[agentbay] runner.provisioning", { event, ...metadata });
}
