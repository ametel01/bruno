import "server-only";

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runners } from "@/src/server/db/schema";
import { readDigitalOceanProviderConfig, type DigitalOceanProviderConfig } from "@/src/server/env";
import {
  type DigitalOceanProvider,
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
} from "@/src/server/runners/digitalocean-provider";
import { probeRunnerEndpointReadiness } from "@/src/server/runners/runner-heartbeat";
import { createConfiguredDigitalOceanProvider } from "@/src/server/runners/runner-provisioning";
import { markCloudRunnerExternallyDeleted } from "@/src/server/runners/runner-provisioning-events";
import {
  isPersistedRunnerCompatible,
  readRunnerCompatibilityRequirement,
  type RunnerCompatibilityRequirement,
} from "@/src/server/runners/runner-compatibility";

export type RunnerPlacementVerificationResult =
  | {
      ok: true;
      runner: {
        id: string;
        kind: string;
        provisioningStatus: string | null;
      };
    }
  | {
      ok: false;
      action: "reject_candidate";
      reason:
        | "endpoint_invalid"
        | "endpoint_rejected"
        | "network_error"
        | "provider_resource_missing"
        | "release_incompatible"
        | "response_invalid"
        | "runner_not_eligible"
        | "token_not_configured";
      transitioned: boolean;
    }
  | {
      ok: false;
      action: "fail_closed";
      reason: "provider_check_failed" | "provider_not_configured";
      transitioned: false;
    };

export type RunnerPlacementVerificationDependencies = {
  compatibilityRequirement?: RunnerCompatibilityRequirement;
  createProvider?: (config: DigitalOceanProviderConfig) => DigitalOceanProvider;
  fetch?: typeof fetch;
  now?: () => Date;
  provider?: DigitalOceanProvider;
  readConfig?: () => DigitalOceanProviderConfig | null;
  timeoutMs?: number;
};

export async function verifyRunnerPlacementCandidate(
  connection: DatabaseConnection,
  input: { runnerId: string; userId: string },
  dependencies: RunnerPlacementVerificationDependencies = {},
): Promise<RunnerPlacementVerificationResult> {
  const [runner] = await connection.db
    .select({
      endpointUrl: runners.endpointUrl,
      id: runners.id,
      kind: runners.kind,
      provider: runners.provider,
      providerResourceId: runners.providerResourceId,
      provisioningStatus: runners.provisioningStatus,
      status: runners.status,
      requiredRunnerImageDigest: runners.requiredRunnerImageDigest,
      observedRunnerImageDigest: runners.observedRunnerImageDigest,
      observedRunnerReleaseVersion: runners.observedRunnerReleaseVersion,
      observedRunnerBootContractVersion: runners.observedRunnerBootContractVersion,
      compatibilityState: runners.compatibilityState,
      compatibilityVerifiedAt: runners.compatibilityVerifiedAt,
      updatedAt: runners.updatedAt,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (runner?.status !== "online" || !runner.endpointUrl) {
    return rejected("runner_not_eligible", false);
  }

  const compatibilityRequirement =
    dependencies.compatibilityRequirement ?? readRunnerCompatibilityRequirement();

  if (!isPersistedRunnerCompatible(runner, compatibilityRequirement)) {
    return rejected("release_incompatible", false);
  }

  if (runner.kind !== DIGITALOCEAN_RUNNER_KIND) {
    return {
      ok: true,
      runner: {
        id: runner.id,
        kind: runner.kind,
        provisioningStatus: runner.provisioningStatus,
      },
    };
  }

  if (
    runner.provider !== DIGITALOCEAN_PROVIDER ||
    runner.provisioningStatus !== "ready" ||
    !runner.providerResourceId
  ) {
    return rejected("runner_not_eligible", false);
  }

  let config: DigitalOceanProviderConfig | null;

  try {
    config = dependencies.readConfig ? dependencies.readConfig() : readDigitalOceanProviderConfig();
  } catch {
    return failedClosed("provider_not_configured");
  }

  if (!config) {
    return failedClosed("provider_not_configured");
  }

  if (config.providerMode !== "local_docker") {
    const provider =
      dependencies.provider ??
      dependencies.createProvider?.(config) ??
      createConfiguredDigitalOceanProvider(config);
    let resource: Awaited<ReturnType<DigitalOceanProvider["readResource"]>>;

    try {
      resource = await provider.readResource({
        providerResourceId: runner.providerResourceId,
      });
    } catch {
      return failedClosed("provider_check_failed");
    }

    if (!resource.ok || resource.value.deletedAt !== null) {
      if (!resource.ok && resource.reason !== "resource_not_found") {
        return failedClosed("provider_check_failed");
      }

      const transitioned = await connection.db.transaction((tx) =>
        markCloudRunnerExternallyDeleted(tx, {
          runnerId: runner.id,
          userId: input.userId,
          providerResourceId: runner.providerResourceId as string,
          now: dependencies.now?.() ?? new Date(),
        }),
      );

      return rejected("provider_resource_missing", transitioned);
    }
  }

  const endpointProbe = await probeRunnerEndpointReadiness({
    endpointUrl: runner.endpointUrl,
    runnerBearerToken: config.runnerBearerToken,
    allowInsecureLoopback: config.providerMode === "local_docker",
    ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
    ...(dependencies.timeoutMs === undefined ? {} : { timeoutMs: dependencies.timeoutMs }),
  });

  if (!endpointProbe.ok) {
    const now = dependencies.now?.() ?? new Date();
    const transitionedRows = await connection.db
      .update(runners)
      .set({ status: "offline", updatedAt: now })
      .where(
        and(
          eq(runners.id, runner.id),
          eq(runners.userId, input.userId),
          eq(runners.status, "online"),
          eq(runners.provisioningStatus, "ready"),
          eq(runners.updatedAt, runner.updatedAt),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });

    return rejected(endpointProbe.reason, transitionedRows.length > 0);
  }

  const [verifiedRunner] = await connection.db
    .select({
      kind: runners.kind,
      provider: runners.provider,
      requiredRunnerImageDigest: runners.requiredRunnerImageDigest,
      observedRunnerImageDigest: runners.observedRunnerImageDigest,
      observedRunnerReleaseVersion: runners.observedRunnerReleaseVersion,
      observedRunnerBootContractVersion: runners.observedRunnerBootContractVersion,
      compatibilityState: runners.compatibilityState,
      compatibilityVerifiedAt: runners.compatibilityVerifiedAt,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, runner.id),
        eq(runners.userId, input.userId),
        eq(runners.status, "online"),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (!verifiedRunner || !isPersistedRunnerCompatible(verifiedRunner, compatibilityRequirement)) {
    return rejected("release_incompatible", false);
  }

  return {
    ok: true,
    runner: {
      id: runner.id,
      kind: runner.kind,
      provisioningStatus: runner.provisioningStatus,
    },
  };
}

export async function reconcileExternallyDeletedDigitalOceanRunners(
  dependencies: RunnerPlacementVerificationDependencies & {
    createConnection?: () => DatabaseConnection;
  } = {},
): Promise<{
  checkedCount: number;
  deletedCount: number;
  deletedRunnerIds: string[];
  providerCheckFailedRunnerIds: string[];
}> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    let config: DigitalOceanProviderConfig | null;

    try {
      config = dependencies.readConfig
        ? dependencies.readConfig()
        : readDigitalOceanProviderConfig();
    } catch {
      return {
        checkedCount: 0,
        deletedCount: 0,
        deletedRunnerIds: [],
        providerCheckFailedRunnerIds: [],
      };
    }

    if (!config || config.providerMode === "local_docker") {
      return {
        checkedCount: 0,
        deletedCount: 0,
        deletedRunnerIds: [],
        providerCheckFailedRunnerIds: [],
      };
    }

    const provider =
      dependencies.provider ??
      dependencies.createProvider?.(config) ??
      createConfiguredDigitalOceanProvider(config);
    const activeRunners = await connection.db
      .select({
        id: runners.id,
        providerResourceId: runners.providerResourceId,
        userId: runners.userId,
      })
      .from(runners)
      .where(
        and(
          eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
          eq(runners.provider, DIGITALOCEAN_PROVIDER),
          isNotNull(runners.providerResourceId),
          isNull(runners.deletedAt),
        ),
      );
    const deletedRunnerIds: string[] = [];
    const providerCheckFailedRunnerIds: string[] = [];

    for (const runner of activeRunners) {
      if (!runner.providerResourceId) {
        continue;
      }

      let resource: Awaited<ReturnType<DigitalOceanProvider["readResource"]>>;

      try {
        resource = await provider.readResource({
          providerResourceId: runner.providerResourceId,
        });
      } catch {
        providerCheckFailedRunnerIds.push(runner.id);
        continue;
      }

      if (resource.ok && resource.value.deletedAt === null) {
        continue;
      }

      if (!resource.ok && resource.reason !== "resource_not_found") {
        providerCheckFailedRunnerIds.push(runner.id);
        continue;
      }

      const transitioned = await connection.db.transaction((tx) =>
        markCloudRunnerExternallyDeleted(tx, {
          runnerId: runner.id,
          userId: runner.userId,
          providerResourceId: runner.providerResourceId as string,
          now: dependencies.now?.() ?? new Date(),
        }),
      );

      if (transitioned) {
        deletedRunnerIds.push(runner.id);
      }
    }

    return {
      checkedCount: activeRunners.length,
      deletedCount: deletedRunnerIds.length,
      deletedRunnerIds,
      providerCheckFailedRunnerIds,
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function rejected(
  reason: Extract<RunnerPlacementVerificationResult, { action: "reject_candidate" }>["reason"],
  transitioned: boolean,
): Extract<RunnerPlacementVerificationResult, { action: "reject_candidate" }> {
  return { ok: false, action: "reject_candidate", reason, transitioned };
}

function failedClosed(
  reason: "provider_check_failed" | "provider_not_configured",
): Extract<RunnerPlacementVerificationResult, { action: "fail_closed" }> {
  return { ok: false, action: "fail_closed", reason, transitioned: false };
}
