import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV,
  RUNNER_BOOT_VALIDATION_MODE_ENV,
  RUNNER_RELEASE_APPROVED_DIGEST_ENV,
  RUNNER_RELEASE_BUNDLE_ENV,
} from "@/src/runner-service/boot-validation";
import {
  parseRunnerReleaseIdentity,
  type RunnerReleaseIdentity,
} from "@/src/runner-service/release-identity";
import {
  parseAgentDeploymentChoices,
  runnerBootValidationRequirementForAgentDeploymentChoices,
  runnerCompatibilityRequirementForAgentDeploymentChoices,
  type AgentDeploymentChoices,
} from "@/src/server/agents/agent-deployment-choices";
import { parseRunnerReleaseBundle } from "@/src/runner-service/release-attestation";
import {
  parseRunnerBootSnapshot,
  type RunnerBootSnapshot,
} from "@/src/runner-service/runner-contracts";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  agentDeployments,
  agents,
  runnerCredentials,
  runnerHeartbeats,
  runnerReplacements,
  runners,
} from "@/src/server/db/schema";
import {
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
} from "@/src/server/runners/digitalocean-provider";
import { hashRunnerSecret } from "@/src/server/runners/runner-auth-secrets";
import {
  assessRunnerCompatibility,
  isPersistedRunnerCompatible,
  type RunnerCompatibilityRequirement,
  readRunnerCompatibilityRequirement,
} from "@/src/server/runners/runner-compatibility";
import {
  markCloudRunnerFailedAfterAuthenticatedProbe,
  markCloudRunnerReadyAfterAuthenticatedProbe,
} from "@/src/server/runners/runner-provisioning-events";

export const RUNNER_HEARTBEAT_ONLINE_STATUS = "online";
export const RUNNER_HEARTBEAT_DEGRADED_STATUS = "degraded";
export const RUNNER_HEARTBEAT_OFFLINE_STATUS = "offline";
export const RUNNER_HEARTBEAT_STALE_THRESHOLD_MS = 90_000;
export const RUNNER_READINESS_PROBE_TIMEOUT_MS = 5_000;

const RUNNER_BEARER_TOKEN_ENV = "BRUNO_RUNNER_BEARER_TOKEN";
const DIGITALOCEAN_PROVIDER_MODE_ENV = "BRUNO_DIGITALOCEAN_PROVIDER_MODE";

const MAX_VERSION_LENGTH = 80;
const METRIC_LIMITS = {
  cpuPercent: { min: 0, max: 100 },
  memoryUsedMb: { min: 0, max: 16_777_216 },
  memoryTotalMb: { min: 0, max: 16_777_216 },
  diskUsedMb: { min: 0, max: 1_073_741_824 },
  diskTotalMb: { min: 0, max: 1_073_741_824 },
  runningAgents: { min: 0, max: 10_000 },
  maxAgents: { min: 0, max: 10_000 },
} as const;

type RunnerHeartbeatStatus =
  | typeof RUNNER_HEARTBEAT_ONLINE_STATUS
  | typeof RUNNER_HEARTBEAT_DEGRADED_STATUS;

type PersistedRunnerStatus =
  | "active"
  | "inactive"
  | "registering"
  | "online"
  | "offline"
  | "degraded"
  | "provisioning"
  | "provision_failed"
  | "deleting"
  | "deleted";

type RunnerHeartbeatMetadata = {
  version?: string;
  releaseEvidence: "missing" | "present";
  release?: RunnerReleaseIdentity;
  metrics?:
    | Record<keyof typeof METRIC_LIMITS, number>
    | Partial<Record<keyof typeof METRIC_LIMITS, number>>;
};

type RunnerHeartbeatValidation =
  | {
      ok: true;
      value: {
        runnerId: string;
        status: RunnerHeartbeatStatus;
        metadata: RunnerHeartbeatMetadata;
      };
    }
  | {
      ok: false;
      reason: "invalid_payload";
      issues: Array<{ field: string; message: string }>;
    };

type RunnerCredentialValidation =
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: "missing_credential" | "malformed_credential";
    };

export type RunnerHeartbeatReconciliationResult = {
  offlineCount: number;
  runnerIds: string[];
  cutoff: string;
};

export type RunnerHeartbeatTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type RunnerHeartbeatDatabase = PostgresJsDatabase<typeof schema> | RunnerHeartbeatTransaction;

export type LatestRunnerHeartbeat = {
  status: string;
  metadata: Record<string, unknown>;
  observedAt: Date;
};

export type RecordRunnerHeartbeatResult =
  | {
      ok: true;
      runner: {
        id: string;
        status: PersistedRunnerStatus;
        observedAt: string;
      };
    }
  | {
      ok: false;
      reason:
        | "missing_credential"
        | "malformed_credential"
        | "invalid_credential"
        | "wrong_runner"
        | "invalid_payload";
      issues?: Array<{ field: string; message: string }>;
    };

export type ConfirmCloudRunnerReadinessResult =
  | {
      outcome: "ready";
      transitioned: boolean;
    }
  | {
      outcome: "pending";
      reason:
        | "endpoint_invalid"
        | "endpoint_rejected"
        | "network_error"
        | "persistence_error"
        | "boot_evidence_incompatible"
        | "release_incompatible"
        | "response_invalid"
        | "runner_not_ready"
        | "token_not_configured";
    }
  | {
      outcome: "failed";
      reason: "boot_self_test_failed";
      failureReason: Exclude<RunnerBootSnapshot["failureReason"], null>;
      transitioned: boolean;
    }
  | {
      outcome: "not_applicable";
      reason: "already_ready" | "runner_not_eligible";
    };

export type ProbeRunnerEndpointReadinessResult =
  | {
      ok: true;
      protocol: "readiness_endpoint";
      snapshot: RunnerBootSnapshot;
      observedStartedAt: Date;
      observedCompletedAt: Date;
    }
  | {
      ok: false;
      reason: "runner_not_ready";
      snapshot: RunnerBootSnapshot;
      observedStartedAt: Date;
      observedCompletedAt: Date;
    }
  | {
      ok: false;
      reason:
        | "endpoint_invalid"
        | "endpoint_rejected"
        | "network_error"
        | "response_invalid"
        | "token_not_configured";
    };

export type RunnerBootValidationRequirement =
  | { mode: "full" }
  | {
      mode: "release_attested";
      releaseBundleDigest: string;
      snapshotBundleDigest: string;
      snapshotImageId: string;
    }
  | { mode: "unavailable" };

export class RunnerHeartbeatPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Runner heartbeat failed.");
    this.name = "RunnerHeartbeatPersistenceError";
    this.cause = cause;
  }
}

export async function recordRunnerHeartbeat(
  input: {
    authorizationHeader: string | null;
    payload: unknown;
  },
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
    compatibilityRequirement?: RunnerCompatibilityRequirement;
  } = {},
): Promise<RecordRunnerHeartbeatResult> {
  const credential = parseRunnerBearerCredential(input.authorizationHeader);

  if (!credential.ok) {
    return { ok: false, reason: credential.reason };
  }

  const payload = validateRunnerHeartbeatPayload(input.payload);

  if (!payload.ok) {
    return { ok: false, reason: payload.reason, issues: payload.issues };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const credentialHash = hashRunnerSecret(credential.value);
      const [row] = await tx
        .select({
          credentialId: runnerCredentials.id,
          credentialRunnerId: runnerCredentials.runnerId,
          credentialStatus: runnerCredentials.status,
          expiresAt: runnerCredentials.expiresAt,
          runnerId: runners.id,
          runnerKind: runners.kind,
          runnerProvider: runners.provider,
          runnerProvisioningStatus: runners.provisioningStatus,
          requiredRunnerImageDigest: runners.requiredRunnerImageDigest,
          observedRunnerImageDigest: runners.observedRunnerImageDigest,
          observedRunnerReleaseVersion: runners.observedRunnerReleaseVersion,
          observedRunnerBootContractVersion: runners.observedRunnerBootContractVersion,
          compatibilityState: runners.compatibilityState,
        })
        .from(runnerCredentials)
        .innerJoin(runners, eq(runners.id, runnerCredentials.runnerId))
        .where(and(eq(runnerCredentials.credentialHash, credentialHash), isNull(runners.deletedAt)))
        .limit(1);

      if (row?.credentialStatus !== "active" || isExpired(row.expiresAt, now)) {
        return { ok: false, reason: "invalid_credential" } as const;
      }

      if (
        row.credentialRunnerId !== payload.value.runnerId ||
        row.runnerId !== payload.value.runnerId
      ) {
        return { ok: false, reason: "wrong_runner" } as const;
      }

      const pinnedChoices = await readPinnedAgentDeploymentChoicesForRunner(
        tx,
        payload.value.runnerId,
      );
      const compatibility = assessRunnerCompatibility({
        kind: row.runnerKind,
        provider: row.runnerProvider,
        requiredImageDigest: row.requiredRunnerImageDigest,
        observedRelease: payload.value.metadata.release ?? null,
        requirement:
          admittedRunnerCompatibilityRequirement(row) ??
          dependencies.compatibilityRequirement ??
          compatibilityRequirementForDeploymentAssociation(pinnedChoices),
        now,
      });

      await tx.insert(runnerHeartbeats).values({
        runnerId: payload.value.runnerId,
        status: payload.value.status,
        metadata: payload.value.metadata,
        observedAt: now,
        createdAt: now,
      });

      await tx
        .update(runnerCredentials)
        .set({
          lastUsedAt: now,
          updatedAt: now,
        })
        .where(eq(runnerCredentials.id, row.credentialId));

      const [updatedRunner] = await tx
        .update(runners)
        .set({
          status: sql<string>`case
            when ${runners.provisioningStatus} in ('failed', 'cleaning_up', 'deleted')
              or ${runners.status} in ('provision_failed', 'deleting', 'deleted')
            then ${runners.status}
            else ${payload.value.status}
          end`,
          requiredRunnerImageDigest: compatibility.requiredImageDigest,
          observedRunnerImageDigest: compatibility.observedRelease?.imageDigest ?? null,
          observedRunnerReleaseVersion: compatibility.observedRelease?.version ?? null,
          observedRunnerBootContractVersion:
            compatibility.observedRelease?.bootContractVersion ?? null,
          compatibilityState: compatibility.state,
          compatibilityVerifiedAt: compatibility.verifiedAt,
          updatedAt: now,
        })
        .where(eq(runners.id, payload.value.runnerId))
        .returning({ status: sql<PersistedRunnerStatus>`${runners.status}` });

      if (!updatedRunner) {
        throw new Error("Authenticated runner disappeared during heartbeat persistence.");
      }

      return {
        ok: true,
        runner: {
          id: payload.value.runnerId,
          status: updatedRunner.status,
          observedAt: now.toISOString(),
        },
      } as const;
    });
  } catch (error) {
    throw new RunnerHeartbeatPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function admittedRunnerCompatibilityRequirement(input: {
  runnerProvisioningStatus: string | null;
  requiredRunnerImageDigest: string | null;
  observedRunnerImageDigest: string | null;
  observedRunnerReleaseVersion: string | null;
  observedRunnerBootContractVersion: string | null;
  compatibilityState: string;
}): RunnerCompatibilityRequirement | null {
  if (
    input.runnerProvisioningStatus !== "ready" ||
    input.compatibilityState !== "compatible" ||
    input.requiredRunnerImageDigest === null ||
    input.observedRunnerImageDigest !== input.requiredRunnerImageDigest ||
    input.observedRunnerReleaseVersion === null ||
    input.observedRunnerBootContractVersion === null
  ) {
    return null;
  }

  return {
    mode: "hosted",
    release: {
      version: input.observedRunnerReleaseVersion,
      imageDigest: input.requiredRunnerImageDigest,
      bootContractVersion: input.observedRunnerBootContractVersion,
    },
  };
}

export async function confirmCloudRunnerReadiness(
  runnerId: string,
  dependencies: {
    allowInsecureLoopback?: boolean;
    bootValidationRequirement?: RunnerBootValidationRequirement;
    compatibilityRequirement?: RunnerCompatibilityRequirement;
    createConnection?: () => DatabaseConnection;
    fetch?: typeof fetch;
    now?: () => Date;
    runnerBearerToken?: string | null;
    timeoutMs?: number;
  } = {},
): Promise<ConfirmCloudRunnerReadinessResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [runner] = await connection.db
      .select({
        endpointUrl: runners.endpointUrl,
        kind: runners.kind,
        provider: runners.provider,
        provisioningStatus: runners.provisioningStatus,
        requiredRunnerImageDigest: runners.requiredRunnerImageDigest,
        observedRunnerImageDigest: runners.observedRunnerImageDigest,
        observedRunnerReleaseVersion: runners.observedRunnerReleaseVersion,
        observedRunnerBootContractVersion: runners.observedRunnerBootContractVersion,
        compatibilityState: runners.compatibilityState,
        compatibilityVerifiedAt: runners.compatibilityVerifiedAt,
        status: runners.status,
      })
      .from(runners)
      .where(and(eq(runners.id, runnerId), isNull(runners.deletedAt)))
      .limit(1);

    if (runner?.provisioningStatus === "ready") {
      return { outcome: "not_applicable", reason: "already_ready" };
    }

    if (
      !runner ||
      runner.kind !== DIGITALOCEAN_RUNNER_KIND ||
      runner.provider !== DIGITALOCEAN_PROVIDER ||
      runner.status !== RUNNER_HEARTBEAT_ONLINE_STATUS ||
      runner.provisioningStatus !== "waiting_for_runner"
    ) {
      return { outcome: "not_applicable", reason: "runner_not_eligible" };
    }

    const pinnedChoices = await readPinnedAgentDeploymentChoicesForRunner(connection.db, runnerId);

    if (pinnedChoices.kind === "associated" && pinnedChoices.choices === null) {
      return { outcome: "pending", reason: "boot_evidence_incompatible" };
    }

    const runnerBearerToken =
      dependencies.runnerBearerToken === undefined
        ? process.env[RUNNER_BEARER_TOKEN_ENV]
        : dependencies.runnerBearerToken;

    const allowInsecureLoopback =
      dependencies.allowInsecureLoopback ??
      process.env[DIGITALOCEAN_PROVIDER_MODE_ENV] === "local_docker";
    const probe = await probeRunnerEndpointReadiness({
      endpointUrl: runner.endpointUrl,
      runnerBearerToken,
      allowInsecureLoopback,
      ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
      ...(dependencies.now ? { now: dependencies.now } : {}),
      ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
    });

    if (!probe.ok) {
      const failureReason =
        probe.reason === "runner_not_ready" ? probe.snapshot.failureReason : null;
      if (
        probe.reason === "runner_not_ready" &&
        probe.snapshot.status === "failed" &&
        failureReason !== null
      ) {
        const bootSnapshot = probe.snapshot;
        const now = dependencies.now?.() ?? new Date();
        const transitioned = await connection.db.transaction((tx) =>
          markCloudRunnerFailedAfterAuthenticatedProbe(tx, {
            runnerId,
            now,
            bootSnapshot,
            readinessProbeStartedAt: probe.observedStartedAt,
            readinessProbeCompletedAt: probe.observedCompletedAt,
          }),
        );
        return {
          outcome: "failed",
          reason: "boot_self_test_failed",
          failureReason,
          transitioned,
        };
      }
      return { outcome: "pending", reason: probe.reason };
    }

    if (
      !runnerBootSnapshotMatchesRequirement(
        probe.snapshot,
        dependencies.bootValidationRequirement ??
          bootValidationRequirementForDeploymentAssociation(pinnedChoices),
      )
    ) {
      return { outcome: "pending", reason: "boot_evidence_incompatible" };
    }

    if (
      !isPersistedRunnerCompatible(
        runner,
        dependencies.compatibilityRequirement ??
          compatibilityRequirementForDeploymentAssociation(pinnedChoices),
      )
    ) {
      return { outcome: "pending", reason: "release_incompatible" };
    }

    const now = dependencies.now?.() ?? new Date();
    const transitioned = await connection.db.transaction((tx) =>
      markCloudRunnerReadyAfterAuthenticatedProbe(tx, {
        runnerId,
        now,
        bootSnapshot: probe.snapshot,
        readinessProbeStartedAt: probe.observedStartedAt,
        readinessProbeCompletedAt: probe.observedCompletedAt,
      }),
    );

    return { outcome: "ready", transitioned };
  } catch {
    return { outcome: "pending", reason: "persistence_error" };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function readPinnedAgentDeploymentChoicesForRunner(
  db: RunnerHeartbeatDatabase,
  runnerId: string,
): Promise<DeploymentChoiceAssociation> {
  const [row] = await db.execute<{
    deploymentChoices: unknown;
    safetyQuarantinedAt: Date | string | null;
    stage: string;
  }>(sql`
    select ${agentDeployments.deploymentChoices} as "deploymentChoices"
      , ${agentDeployments.safetyQuarantinedAt} as "safetyQuarantinedAt"
      , ${agentDeployments.stage} as "stage"
    from ${agentDeployments}
    where (
        exists (
          select 1 from ${agents}
          where ${agents.id} = ${agentDeployments.agentId}
            and ${agents.userId} = ${agentDeployments.userId}
            and ${agents.runnerId} = ${runnerId}
            and ${agents.deletedAt} is null
        )
        or exists (
          select 1 from ${runnerReplacements}
          where ${runnerReplacements.targetRunnerId} = ${runnerId}
            and ${runnerReplacements.triggerDeploymentId} = ${agentDeployments.id}
            and ${runnerReplacements.state} not in ('complete', 'failed')
        )
        or exists (
          select 1 from ${runners}
          where ${runners.id} = ${runnerId}
            and ${runners.provisioningOperationKey} =
              'bruno-deploy-' || replace(${agentDeployments.id}::text, '-', '')
        )
      )
    order by
      case when ${agentDeployments.stage} in ('ready', 'failed') then 1 else 0 end,
      ${agentDeployments.createdAt} desc,
      ${agentDeployments.id} desc
    limit 1
  `);

  if (!row) return { kind: "none" };
  return {
    kind: "associated",
    choices:
      row.safetyQuarantinedAt === null && row.stage !== "failed"
        ? parseAgentDeploymentChoices(row.deploymentChoices)
        : null,
  };
}

type DeploymentChoiceAssociation =
  | { kind: "none" }
  | { kind: "associated"; choices: AgentDeploymentChoices | null };

function compatibilityRequirementForDeploymentAssociation(
  association: DeploymentChoiceAssociation,
): RunnerCompatibilityRequirement {
  if (association.kind === "none") return readRunnerCompatibilityRequirement();
  return association.choices
    ? runnerCompatibilityRequirementForAgentDeploymentChoices(association.choices)
    : { mode: "unavailable", release: null };
}

function bootValidationRequirementForDeploymentAssociation(
  association: DeploymentChoiceAssociation,
): RunnerBootValidationRequirement {
  if (association.kind === "none") return readRunnerBootValidationRequirement();
  const choices = association.choices;
  if (!choices || choices.provider.mode === "unavailable") return { mode: "unavailable" };
  return runnerBootValidationRequirementForAgentDeploymentChoices(choices);
}

export function runnerBootSnapshotMatchesRequirement(
  snapshot: RunnerBootSnapshot,
  requirement: RunnerBootValidationRequirement,
): boolean {
  if (snapshot.status !== "ready" || requirement.mode === "unavailable") return false;
  if (requirement.mode === "full") {
    return snapshot.validationMode === "full" && snapshot.evidence === null;
  }
  return (
    snapshot.validationMode === "release_attested" &&
    snapshot.evidence?.releaseBundleDigest === requirement.releaseBundleDigest &&
    snapshot.evidence.snapshotBundleDigest === requirement.snapshotBundleDigest &&
    snapshot.evidence.snapshotImageId === requirement.snapshotImageId
  );
}

export function readRunnerBootValidationRequirement(
  env: Record<string, string | undefined> = process.env,
): RunnerBootValidationRequirement {
  const mode = env[RUNNER_BOOT_VALIDATION_MODE_ENV]?.trim() || "full";
  if (mode === "full") return { mode };
  if (mode !== "release_attested") return { mode: "unavailable" };

  const bundleBytes = env[RUNNER_RELEASE_BUNDLE_ENV]?.trim();
  const releaseBundleDigest = env[RUNNER_RELEASE_APPROVED_DIGEST_ENV]?.trim();
  const snapshotBundleDigest = env[RUNNER_APPROVED_SNAPSHOT_DIGEST_ENV]?.trim();
  if (!bundleBytes || !releaseBundleDigest || !snapshotBundleDigest) {
    return { mode: "unavailable" };
  }
  const release = parseRunnerReleaseBundle(bundleBytes);
  if (
    !release.ok ||
    release.digest !== releaseBundleDigest ||
    release.bundle.manifest.snapshot.bundleDigest !== snapshotBundleDigest
  ) {
    return { mode: "unavailable" };
  }
  return {
    mode,
    releaseBundleDigest,
    snapshotBundleDigest,
    snapshotImageId: release.bundle.manifest.snapshot.imageId,
  };
}

export async function probeRunnerEndpointReadiness(input: {
  endpointUrl: string | null;
  runnerBearerToken: string | null | undefined;
  allowInsecureLoopback?: boolean;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
}): Promise<ProbeRunnerEndpointReadinessResult> {
  const runnerBearerToken = input.runnerBearerToken?.trim();

  if (!runnerBearerToken) {
    return { ok: false, reason: "token_not_configured" };
  }

  const readinessUrl = toReadinessProbeUrl(input.endpointUrl, input.allowInsecureLoopback ?? false);

  if (!readinessUrl) {
    return { ok: false, reason: "endpoint_invalid" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? RUNNER_READINESS_PROBE_TIMEOUT_MS,
  );
  let response: Response;
  const observedStartedAt = input.now?.() ?? new Date();

  try {
    response = await (input.fetch ?? fetch)(readinessUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${runnerBearerToken}`,
      },
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    return { ok: false, reason: "network_error" };
  } finally {
    clearTimeout(timeout);
  }

  let payload: unknown;

  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: response.ok ? "response_invalid" : "endpoint_rejected" };
  }
  const observedCompletedAt = input.now?.() ?? new Date();

  const snapshot = parseRunnerBootSnapshot(payload);
  if (!response.ok) {
    if (response.status === 503 && snapshot && snapshot.status !== "ready") {
      return {
        ok: false,
        reason: "runner_not_ready",
        snapshot,
        observedStartedAt,
        observedCompletedAt,
      };
    }
    if (response.status === 404 && isLegacyAuthenticatedNotFoundPayload(payload)) {
      return { ok: false, reason: "response_invalid" };
    }
    return { ok: false, reason: "endpoint_rejected" };
  }

  return snapshot?.status === "ready"
    ? {
        ok: true,
        protocol: "readiness_endpoint",
        snapshot,
        observedStartedAt,
        observedCompletedAt,
      }
    : { ok: false, reason: "response_invalid" };
}

function isLegacyAuthenticatedNotFoundPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") {
    return false;
  }

  const body = payload as Record<string, unknown>;
  const error =
    body.error && typeof body.error === "object" ? (body.error as Record<string, unknown>) : null;

  return (
    body.ok === false &&
    error?.code === "not_found" &&
    error.message === "Runner route was not found."
  );
}

function toReadinessProbeUrl(
  endpointUrl: string | null,
  allowInsecureLoopback: boolean,
): URL | null {
  if (!endpointUrl) {
    return null;
  }

  try {
    const parsed = new URL(endpointUrl);
    const isAllowedLoopback =
      allowInsecureLoopback && parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);

    if (
      (parsed.protocol !== "https:" && !isAllowedLoopback) ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }

    return new URL("/runner/v1/readiness", parsed.origin);
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "host.docker.internal" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

export async function reconcileStaleRunnerHeartbeats(
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
    staleThresholdMs?: number;
  } = {},
): Promise<RunnerHeartbeatReconciliationResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction((tx) =>
      reconcileStaleRunnerHeartbeatsInTransaction(tx, {
        now,
        ...(dependencies.staleThresholdMs === undefined
          ? {}
          : { staleThresholdMs: dependencies.staleThresholdMs }),
      }),
    );
  } catch (error) {
    throw new RunnerHeartbeatPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function reconcileStaleRunnerHeartbeatsInTransaction(
  tx: RunnerHeartbeatTransaction,
  input: { now: Date; staleThresholdMs?: number; userId?: string; runnerId?: string },
): Promise<RunnerHeartbeatReconciliationResult> {
  const staleThresholdMs = input.staleThresholdMs ?? RUNNER_HEARTBEAT_STALE_THRESHOLD_MS;
  const cutoff = new Date(input.now.getTime() - staleThresholdMs);
  const runnerFilters = [
    inArray(runners.status, [RUNNER_HEARTBEAT_ONLINE_STATUS, RUNNER_HEARTBEAT_DEGRADED_STATUS]),
    isNull(runners.deletedAt),
  ];

  if (input.userId) {
    runnerFilters.push(eq(runners.userId, input.userId));
  }

  if (input.runnerId) {
    runnerFilters.push(eq(runners.id, input.runnerId));
  }

  const candidateRunners = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(and(...runnerFilters));
  const latestHeartbeats = await loadLatestRunnerHeartbeatMap(
    tx,
    candidateRunners.map((candidate) => candidate.id),
  );
  const staleRunnerIds = candidateRunners.flatMap((candidate) => {
    const latestHeartbeat = latestHeartbeats.get(candidate.id);
    return !latestHeartbeat || latestHeartbeat.observedAt < cutoff ? [candidate.id] : [];
  });

  if (staleRunnerIds.length > 0) {
    await tx
      .update(runners)
      .set({
        status: RUNNER_HEARTBEAT_OFFLINE_STATUS,
        updatedAt: input.now,
      })
      .where(and(inArray(runners.id, staleRunnerIds), isNull(runners.deletedAt)));
  }

  return {
    offlineCount: staleRunnerIds.length,
    runnerIds: staleRunnerIds,
    cutoff: cutoff.toISOString(),
  };
}

export async function loadLatestRunnerHeartbeatMap(
  tx: RunnerHeartbeatTransaction,
  runnerIds: readonly string[],
): Promise<Map<string, LatestRunnerHeartbeat>> {
  if (runnerIds.length === 0) {
    return new Map();
  }

  const rows = await tx
    .selectDistinctOn([runnerHeartbeats.runnerId], {
      runnerId: runnerHeartbeats.runnerId,
      status: runnerHeartbeats.status,
      metadata: runnerHeartbeats.metadata,
      observedAt: runnerHeartbeats.observedAt,
    })
    .from(runnerHeartbeats)
    .where(inArray(runnerHeartbeats.runnerId, [...runnerIds]))
    .orderBy(
      runnerHeartbeats.runnerId,
      desc(runnerHeartbeats.observedAt),
      desc(runnerHeartbeats.id),
    );

  return new Map(rows.map(({ runnerId, ...heartbeat }) => [runnerId, heartbeat]));
}

export function validateRunnerHeartbeatPayload(payload: unknown): RunnerHeartbeatValidation {
  const issues: Array<{ field: string; message: string }> = [];

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      reason: "invalid_payload",
      issues: [{ field: "body", message: "Request body must be an object." }],
    };
  }

  const body = payload as Record<string, unknown>;
  const runnerId = typeof body.runnerId === "string" ? body.runnerId.trim() : "";

  if (!isUuid(runnerId)) {
    issues.push({ field: "runnerId", message: "Runner ID must be a valid UUID." });
  }

  const parsedStatus = parseHeartbeatStatus(body.status);

  if (!parsedStatus) {
    issues.push({
      field: "status",
      message: "Status must be online or degraded when provided.",
    });
  }

  const version = sanitizeVersion(body.version);
  const metrics = sanitizeMetrics(body.metrics);
  const release = body.release === undefined ? null : parseRunnerReleaseIdentity(body.release);
  const metadata: RunnerHeartbeatMetadata = {
    releaseEvidence: release ? "present" : "missing",
  };

  if (body.release !== undefined && !release) {
    issues.push({
      field: "release",
      message: "Release identity must contain canonical bounded fields.",
    });
  }

  if (version) {
    metadata.version = version;
  }

  if (Object.keys(metrics).length > 0) {
    metadata.metrics = metrics;
  }

  if (release) {
    metadata.release = release;
  }

  if (issues.length > 0) {
    return { ok: false, reason: "invalid_payload", issues };
  }

  return {
    ok: true,
    value: {
      runnerId,
      status: parsedStatus ?? RUNNER_HEARTBEAT_ONLINE_STATUS,
      metadata,
    },
  };
}

function parseRunnerBearerCredential(
  authorizationHeader: string | null,
): RunnerCredentialValidation {
  if (!authorizationHeader) {
    return { ok: false, reason: "missing_credential" };
  }

  const trimmedHeader = authorizationHeader.trim();
  const match = /^Bearer\s+(.+)$/i.exec(trimmedHeader);

  if (!match) {
    return { ok: false, reason: "malformed_credential" };
  }

  const credential = match[1]?.trim();

  if (!credential || /\s/.test(credential)) {
    return { ok: false, reason: "malformed_credential" };
  }

  return { ok: true, value: credential };
}

function parseHeartbeatStatus(value: unknown): RunnerHeartbeatStatus | null {
  if (value === undefined || value === null || value === RUNNER_HEARTBEAT_ONLINE_STATUS) {
    return RUNNER_HEARTBEAT_ONLINE_STATUS;
  }

  if (value === RUNNER_HEARTBEAT_DEGRADED_STATUS) {
    return RUNNER_HEARTBEAT_DEGRADED_STATUS;
  }

  return null;
}

function sanitizeVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmedValue = value.trim().replace(/[^\w .:/+-]/g, "");

  return trimmedValue ? trimmedValue.slice(0, MAX_VERSION_LENGTH) : undefined;
}

function sanitizeMetrics(value: unknown): Partial<Record<keyof typeof METRIC_LIMITS, number>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const metrics = value as Record<string, unknown>;
  const sanitizedMetrics: Partial<Record<keyof typeof METRIC_LIMITS, number>> = {};

  for (const key of Object.keys(METRIC_LIMITS) as Array<keyof typeof METRIC_LIMITS>) {
    const rawValue = metrics[key];

    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
      continue;
    }

    const limit = METRIC_LIMITS[key];
    sanitizedMetrics[key] = Math.min(Math.max(rawValue, limit.min), limit.max);
  }

  return sanitizedMetrics;
}

function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt <= now;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
