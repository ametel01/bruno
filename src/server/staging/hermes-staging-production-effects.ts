import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import {
  attestManagedHermesImageIdentity,
  isRunnerStatusExactReady,
  type ParsedRunnerStatusResponse,
  RUNNER_STATUS_CONTRACT_VERSION,
} from "@/src/runner-service/runner-contracts";
import {
  type AgentDeploymentReconcileResult,
  reconcileTargetAgentDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import { getAgentDeploymentByIdempotencyKeyForUser } from "@/src/server/agents/agent-deployments";
import {
  type AssistantChoice,
  getAssistantProfile,
  isAssistantChoice,
  validateAssistantApiKey,
} from "@/src/server/agents/assistant-profiles";
import { reconcileTargetAgentRuntime } from "@/src/server/agents/agent-runtime-reconciler";
import {
  parseAgentSecretKeyring,
  readRequiredDecryptedActiveAgentSecretsForUser,
  revokeActiveAgentSecretsInTransaction,
} from "@/src/server/agents/agent-secrets";
import { createAgentForUser, validateCreateAgentPayload } from "@/src/server/agents/create-agent";
import {
  deleteAgentForUser,
  restartAgentForUser,
  stopAgentForUser,
} from "@/src/server/agents/lifecycle";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentRuntimeReconciliations,
  agents,
  runnerCredentials,
  runners,
} from "@/src/server/db/schema";
import {
  readDigitalOceanProviderConfig,
  readHermesStagingAcceptanceConfig,
  readHermesWorkloadImage,
  readReadyAgentCreationFlag,
} from "@/src/server/env";
import { listAgentEventFeedForUser } from "@/src/server/events/agent-events";
import { listAgentLogsForUser } from "@/src/server/logs/agent-logs";
import type {
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
} from "@/src/server/runners/digitalocean-provider";
import { ManualRunnerAdapter } from "@/src/server/runners/manual-runner-adapter";
import type { ManualRunnerRecord } from "@/src/server/runners/manual-runner-persistence";
import {
  createConfiguredDigitalOceanProvider,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";
import type {
  HermesStagingAcceptanceEffectContext,
  HermesStagingAcceptanceEffectExecution,
  HermesStagingAcceptanceEffectExecutor,
} from "@/src/server/staging/hermes-staging-acceptance-effects";
import {
  HERMES_STAGING_DEPLOYMENT_STAGES,
  type HermesStagingAcceptanceEffectKind,
  type HermesStagingDeploymentStage,
} from "@/src/server/staging/hermes-staging-acceptance-state";
import { attestHermesStagingPublishedImage } from "@/src/server/staging/hermes-staging-image-attestor";
import {
  checkHermesStagingOwnerIsolation,
  observeHermesAgentSecretCounts,
  observeHermesDeploymentStageHistory,
  observeHermesOpenUsagePeriod,
  observeHermesResourceAbsence,
  observeHermesRunnerCredentialCount,
  observeHermesStopStability,
} from "@/src/server/staging/hermes-staging-product-observer";

const LIVE_SENTINEL = "send-telegram-and-spend-digitalocean-staging";
const BUDGET_SENTINEL = "authorize-basic-4usd-digitalocean-staging";
const CANONICAL_IMAGE_PATTERN = /^ghcr\.io\/ametel01\/agentbay-hermes@(sha256:[0-9a-f]{64})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCATOR_PATTERN = /^[A-Za-z0-9_.:-]{1,120}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const MAX_DIAGNOSTIC_PAGES = 100;
const DIAGNOSTIC_PAGE_SIZE = 100;

type Confirmation = "confirmed" | "failed" | "unknown";
type Mutation = "accepted" | "failed" | "unknown";
type Absence = "absent" | "present" | "unknown";

type CorrelatedResource = {
  agentId: string;
  deploymentId: string;
  runnerId: string | null;
  providerResourceId: string | null;
  providerFirewallId: string | null;
};

type StrictRuntimeObservation =
  | {
      state: "exact_ready";
      imageDigest: string;
      acceptedAt: Date | null;
      operationAction: "start" | "restart";
    }
  | { state: "not_ready" | "mismatch" | "unknown" };

type RestartObservation = "completed" | "not_applied" | "conflict" | "unknown";
type StopIntentObservation = "desired_stopped" | "desired_running" | "conflict" | "unknown";

export type HermesStagingProductionEffectPorts = {
  checkPreflightOwner(context: HermesStagingAcceptanceEffectContext): Promise<Confirmation>;
  attestPublishedImage(
    context: HermesStagingAcceptanceEffectContext,
    canonicalRef: string,
    signal: AbortSignal,
  ): Promise<
    | { state: "confirmed"; releaseDigest: string; amd64ManifestDigest: string }
    | { state: "failed" | "unknown" }
  >;
  createReadyAgent(
    context: HermesStagingAcceptanceEffectContext,
    input: ReadyAgentFixture,
    signal: AbortSignal,
  ): Promise<{ state: Mutation; resource?: CorrelatedResource }>;
  observeAgentCreation(
    context: HermesStagingAcceptanceEffectContext,
  ): Promise<{ state: "found" | "absent" | "conflict" | "unknown"; resource?: CorrelatedResource }>;
  advanceDeployment(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<
    | { state: "observed"; stage: HermesStagingDeploymentStage; resource: CorrelatedResource }
    | { state: "failed" | "unknown" }
  >;
  observeStrictRuntime(
    context: HermesStagingAcceptanceEffectContext,
    canonicalRef: string,
    signal: AbortSignal,
  ): Promise<StrictRuntimeObservation>;
  restartAgent(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Mutation>;
  observeRestart(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<RestartObservation>;
  auditDiagnostics(
    context: HermesStagingAcceptanceEffectContext,
    secrets: readonly string[],
    signal: AbortSignal,
  ): Promise<"safe" | "unsafe" | "unknown">;
  stopAgent(context: HermesStagingAcceptanceEffectContext, signal: AbortSignal): Promise<Mutation>;
  observeStopIntent(context: HermesStagingAcceptanceEffectContext): Promise<StopIntentObservation>;
  observeStopStability(
    context: HermesStagingAcceptanceEffectContext,
  ): Promise<"stopped" | "active" | "unknown">;
  cleanupWorkload(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Mutation>;
  observeWorkloadAbsence(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Absence>;
  cleanupSecrets(context: HermesStagingAcceptanceEffectContext): Promise<Mutation>;
  observeSecretsAbsence(context: HermesStagingAcceptanceEffectContext): Promise<Absence>;
  cleanupFirewall(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Mutation>;
  observeFirewallAbsence(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Absence>;
  cleanupDroplet(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Mutation>;
  observeDropletAbsence(
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<Absence>;
  cleanupRunner(context: HermesStagingAcceptanceEffectContext): Promise<Mutation>;
  observeRunnerAbsence(context: HermesStagingAcceptanceEffectContext): Promise<Absence>;
};

type ReadyAgentFixture = {
  name: string;
  assistant: AssistantChoice;
  modelApiKey: string;
  telegramBotToken: string;
  telegramAllowedUserId: string;
};

export type ProductionHermesStagingAcceptanceEffectOptions = {
  env?: Record<string, string | undefined>;
  now?: () => Date;
  createConnection?: () => DatabaseConnection;
  ports?: Partial<HermesStagingProductionEffectPorts>;
};

/**
 * The only production adapter for the durable staging acceptance workflow.
 * Each call dispatches at most one mutation/network boundary. All ambiguity is
 * represented as `unknown`; it is never upgraded to successful evidence.
 */
export function createProductionHermesStagingAcceptanceEffectExecutor(
  options: ProductionHermesStagingAcceptanceEffectOptions = {},
): HermesStagingAcceptanceEffectExecutor {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const ports = {
    ...createDefaultPorts({
      env,
      now,
      ...(options.createConnection ? { createConnection: options.createConnection } : {}),
    }),
    ...options.ports,
  };

  return {
    async execute(effect, context, signal) {
      if (signal.aborted) return unknownExecution(effect);

      try {
        return await executeEffect({ effect, context, signal, env, now, ports });
      } catch {
        return unknownExecution(effect);
      }
    },
  };
}

async function executeEffect(input: {
  effect: HermesStagingAcceptanceEffectKind;
  context: HermesStagingAcceptanceEffectContext;
  signal: AbortSignal;
  env: Record<string, string | undefined>;
  now: () => Date;
  ports: HermesStagingProductionEffectPorts;
}): Promise<HermesStagingAcceptanceEffectExecution> {
  const { effect, context, signal, env, now, ports } = input;
  const config = readFixtureConfig(env, context);

  switch (effect) {
    case "preflight": {
      if (!config.ok) return result(effect, "failed");
      return result(effect, await ports.checkPreflightOwner(context));
    }
    case "attest_published_image": {
      if (!config.ok) return result(effect, "failed");
      const outcome = await ports.attestPublishedImage(context, config.canonicalRef, signal);
      return outcome.state === "confirmed" &&
        outcome.releaseDigest === context.expectedImageDigest &&
        outcome.amd64ManifestDigest === context.expectedImageDigest
        ? {
            result: { effect, outcome: "confirmed" },
            evidence: {
              observedImageDigest: context.expectedImageDigest,
              publishedImageVerifiedAt: now(),
            },
          }
        : result(effect, outcome.state === "unknown" ? "unknown" : "failed");
    }
    case "create_ready_agent": {
      if (!config.ok) return result(effect, "failed");
      const created = await ports.createReadyAgent(context, config.fixture, signal);
      return resourceMutationExecution(effect, created, now());
    }
    case "observe_agent_creation": {
      const observed = await ports.observeAgentCreation(context);
      return observed.state === "found" && observed.resource
        ? {
            result: { effect, outcome: "found" },
            evidence: resourceEvidence(observed.resource),
          }
        : result(effect, observed.state);
    }
    case "observe_next_deployment_stage": {
      const observed = await ports.advanceDeployment(context, signal);
      return observed.state === "observed"
        ? {
            result: { effect, outcome: "observed", stage: observed.stage },
            evidence: {
              ...resourceEvidence(observed.resource),
              ...(observed.stage === "ready" ? { agentReadyVerifiedAt: now() } : {}),
            },
          }
        : result(effect, observed.state);
    }
    case "verify_strict_host_image": {
      if (!config.ok) return result(effect, "mismatch");
      const observed = await ports.observeStrictRuntime(context, config.canonicalRef, signal);
      return observed.state === "exact_ready"
        ? {
            result: { effect, outcome: "exact_ready" },
            evidence: {
              observedImageDigest: observed.imageDigest,
              hostImageVerifiedAt: now(),
            },
          }
        : result(effect, observed.state);
    }
    case "issue_initial_human_challenge":
    case "issue_post_restart_human_challenge":
      return issueChallenge(effect, context, now());
    case "observe_initial_human_challenge":
    case "observe_post_restart_human_challenge":
      return observeChallenge(effect, context);
    case "restart_agent": {
      const requestedAt = now();
      const outcome = await ports.restartAgent(context, signal);
      return outcome === "accepted"
        ? {
            result: { effect, outcome },
            evidence: { restartRequestedAt: requestedAt },
          }
        : result(effect, outcome);
    }
    case "observe_agent_restart": {
      const outcome = await ports.observeRestart(context, signal);
      return outcome === "completed"
        ? {
            result: { effect, outcome },
            evidence: { restartVerifiedAt: now() },
          }
        : result(effect, outcome);
    }
    case "verify_restarted_image_and_telegram": {
      if (!config.ok || context.restartRequestedAt === null) return result(effect, "mismatch");
      const observed = await ports.observeStrictRuntime(context, config.canonicalRef, signal);
      if (
        observed.state === "exact_ready" &&
        observed.operationAction === "restart" &&
        observed.acceptedAt !== null &&
        observed.acceptedAt.getTime() >= context.restartRequestedAt.getTime()
      ) {
        return {
          result: { effect, outcome: "exact_ready" },
          evidence: {
            restartVerifiedAt: now(),
            restartedRuntimeVerifiedAt: now(),
            observedImageDigest: observed.imageDigest,
          },
        };
      }
      return result(effect, observed.state === "exact_ready" ? "mismatch" : observed.state);
    }
    case "audit_safe_diagnostics": {
      if (!config.ok) return result(effect, "unknown");
      const outcome = await ports.auditDiagnostics(context, config.secretValues, signal);
      return outcome === "safe"
        ? {
            result: { effect, outcome },
            evidence: { diagnosticsRedactedConfirmedAt: now() },
          }
        : result(effect, outcome);
    }
    case "stop_agent_db_first": {
      const outcome = await ports.stopAgent(context, signal);
      return result(effect, outcome);
    }
    case "observe_stop_intent":
      return result(effect, await ports.observeStopIntent(context));
    case "observe_stop_stability": {
      const outcome = await ports.observeStopStability(context);
      return outcome === "stopped"
        ? { result: { effect, outcome }, evidence: { stopVerifiedAt: now() } }
        : result(effect, outcome);
    }
    case "verify_manual_rollback": {
      const outcome = verifyManualRollback(env);
      return outcome === "passed"
        ? { result: { effect, outcome }, evidence: { rollbackVerifiedAt: now() } }
        : result(effect, outcome);
    }
    case "cleanup_workload":
      return cleanupMutationExecution(effect, await ports.cleanupWorkload(context, signal));
    case "observe_workload_absence":
      return absenceExecution(effect, await ports.observeWorkloadAbsence(context, signal), now());
    case "cleanup_secrets":
      return cleanupMutationExecution(effect, await ports.cleanupSecrets(context));
    case "observe_secrets_absence":
      return absenceExecution(effect, await ports.observeSecretsAbsence(context), now());
    case "cleanup_firewall":
      return cleanupMutationExecution(effect, await ports.cleanupFirewall(context, signal));
    case "observe_firewall_absence":
      return absenceExecution(effect, await ports.observeFirewallAbsence(context, signal), now());
    case "cleanup_droplet":
      return cleanupMutationExecution(effect, await ports.cleanupDroplet(context, signal));
    case "observe_droplet_absence":
      return absenceExecution(effect, await ports.observeDropletAbsence(context, signal), now());
    case "cleanup_runner":
      return cleanupMutationExecution(effect, await ports.cleanupRunner(context));
    case "observe_runner_absence":
      return absenceExecution(effect, await ports.observeRunnerAbsence(context), now());
  }
}

function createDefaultPorts(input: {
  env: Record<string, string | undefined>;
  now: () => Date;
  createConnection?: () => DatabaseConnection;
}): HermesStagingProductionEffectPorts {
  const createConnection = input.createConnection ?? createDatabaseConnection;

  return {
    checkPreflightOwner: async (context) =>
      withConnection(createConnection, async (connection) => {
        const observation = await checkHermesStagingOwnerIsolation(
          connection.db,
          context.ownerUserId,
        );
        return observation.isolated ? "confirmed" : "failed";
      }),
    attestPublishedImage: async (context, canonicalRef, signal) => {
      const attestation = await attestHermesStagingPublishedImage({
        canonicalRef,
        sourceRevision: context.expectedSourceRevision,
        workflowRunId: Number(context.expectedPublishWorkflowRunId),
        signal,
      });
      return attestation.kind === "confirmed"
        ? {
            state: "confirmed",
            releaseDigest: attestation.releaseDigest,
            amd64ManifestDigest: attestation.amd64ManifestDigest,
          }
        : attestation.kind === "mismatch"
          ? { state: "failed" }
          : { state: "unknown" };
    },
    createReadyAgent: async (context, fixture) => {
      const response = await createAgentForUser(
        context.ownerUserId,
        {
          name: fixture.name,
          templateKey: "research_agent",
          runnerId: null,
          launchMode: "ready",
          idempotencyKey: context.idempotencyKey,
          assistant: fixture.assistant,
          modelApiKey: fixture.modelApiKey,
          telegramBotToken: fixture.telegramBotToken,
          telegramAllowedUserIds: [fixture.telegramAllowedUserId],
        },
        {
          env: { ...input.env, AGENTBAY_READY_AGENT_CREATION_ENABLED: "true" },
          createConnection,
          now: input.now,
        },
      );
      if (!("deployment" in response)) return { state: "failed" };
      return {
        state: "accepted",
        resource: {
          agentId: response.agent.id,
          deploymentId: response.deployment.id,
          runnerId: response.agent.runnerId,
          providerResourceId: null,
          providerFirewallId: null,
        },
      };
    },
    observeAgentCreation: async (context) =>
      withConnection(createConnection, (connection) =>
        discoverCreatedResource(connection, context),
      ),
    advanceDeployment: async (context, signal) => {
      if (signal.aborted) return { state: "unknown" };
      const reconciled = await reconcileTargetAgentDeployment(context.deploymentId ?? "", {
        createConnection,
        now: input.now,
      });
      if (signal.aborted) return { state: "unknown" };
      return withConnection(createConnection, (connection) =>
        mapDeploymentProgress(connection, context, reconciled),
      );
    },
    observeStrictRuntime: async (context, canonicalRef, signal) =>
      withConnection(createConnection, async (connection) => {
        const runner = await readExactRunner(connection, context);
        if (!runner || !context.agentId || signal.aborted) return { state: "unknown" };
        const status = await new ManualRunnerAdapter(runner, {
          createConnection,
          env: input.env,
          now: input.now,
          signal,
          timeoutMs: 45_000,
        }).status(context.agentId);
        if (!status.ok || !("snapshot" in status)) return { state: "unknown" };
        const response: ParsedRunnerStatusResponse = {
          ok: true,
          contractVersion: status.contractVersion,
          agentId: context.agentId,
          action: "status",
          snapshot: status.snapshot,
        };
        const attested = attestManagedHermesImageIdentity(response, canonicalRef);
        if (!attested.ok) {
          return {
            state: ["configured_image_mismatch", "repo_digest_mismatch"].includes(attested.reason)
              ? "mismatch"
              : attested.reason === "status_not_ready"
                ? "not_ready"
                : "unknown",
          };
        }
        if (
          status.contractVersion !== RUNNER_STATUS_CONTRACT_VERSION ||
          !isRunnerStatusExactReady(response) ||
          status.snapshot.operation === null ||
          status.snapshot.revision.requested !== status.snapshot.operation.target.configRevision ||
          status.snapshot.revision.containerLabel !==
            status.snapshot.operation.target.configRevision ||
          status.snapshot.revision.projectionMarker !==
            status.snapshot.operation.target.configRevision ||
          status.snapshot.gateway.state !== "running" ||
          !status.snapshot.apiServer.required ||
          status.snapshot.apiServer.state !== "connected" ||
          !status.snapshot.telegram.required ||
          status.snapshot.telegram.state !== "connected"
        ) {
          return { state: "not_ready" };
        }
        const acceptedAt = status.snapshot.operation?.acceptedAt;
        return {
          state: "exact_ready",
          imageDigest: attested.digest,
          acceptedAt: acceptedAt ? new Date(acceptedAt) : null,
          operationAction: status.snapshot.operation.action,
        };
      }),
    restartAgent: async (context, signal) => {
      if (!context.agentId || signal.aborted) return "failed";
      const response = await restartAgentForUser(context.ownerUserId, context.agentId, {
        createConnection,
        now: input.now,
      });
      return response.ok ? "accepted" : response.reason === "invalid_status" ? "failed" : "unknown";
    },
    observeRestart: async (context, signal) => {
      if (!context.agentId || !context.restartRequestedAt || signal.aborted) return "unknown";
      await reconcileTargetAgentRuntime(context.agentId, { createConnection, now: input.now });
      return withConnection(createConnection, (connection) =>
        readRestartObservation(connection, context),
      );
    },
    auditDiagnostics: async (context, secrets, signal) =>
      withConnection(createConnection, (connection) =>
        auditAllDiagnostics(connection, context, secrets, input.env, signal),
      ),
    stopAgent: async (context, signal) => {
      if (!context.agentId || signal.aborted) return "failed";
      const response = await stopAgentForUser(context.ownerUserId, context.agentId, {
        createConnection,
        now: input.now,
      });
      return response.ok ? "accepted" : response.reason === "invalid_status" ? "failed" : "unknown";
    },
    observeStopIntent: async (context) =>
      withConnection(createConnection, async (connection) => {
        if (!context.agentId) return "conflict";
        const observed = await observeHermesStopStability(connection.db, {
          userId: context.ownerUserId,
          agentId: context.agentId,
        });
        if (observed.state !== "observed") return "conflict";
        return observed.desiredStatus === "stopped" ? "desired_stopped" : "desired_running";
      }),
    observeStopStability: async (context) =>
      withConnection(createConnection, async (connection) => {
        if (!context.agentId) return "unknown";
        const observed = await observeHermesStopStability(connection.db, {
          userId: context.ownerUserId,
          agentId: context.agentId,
        });
        return observed.state !== "observed"
          ? "unknown"
          : observed.stableStopped
            ? "stopped"
            : "active";
      }),
    cleanupWorkload: async (context, signal) => {
      if (!context.agentId || signal.aborted) return "failed";
      const deleted = await deleteAgentForUser(context.ownerUserId, context.agentId, {
        createConnection,
        now: input.now,
      });
      return deleted.ok
        ? "accepted"
        : deleted.reason === "agent_not_found"
          ? "unknown"
          : deleted.reason === "invalid_status"
            ? "failed"
            : "unknown";
    },
    observeWorkloadAbsence: async (context, signal) =>
      withConnection(createConnection, async (connection) => {
        if (!hasCoreIds(context)) return "unknown";
        const observed = await observeHermesResourceAbsence(connection.db, {
          userId: context.ownerUserId,
          agentId: context.agentId,
          runnerId: context.runnerId,
        });
        const usage = await observeHermesOpenUsagePeriod(connection.db, {
          userId: context.ownerUserId,
          agentId: context.agentId,
        });
        if (observed.state !== "observed") return "unknown";
        if (observed.agent === "active" || observed.workload !== "recorded_absent")
          return "present";
        if (usage.state === "observed" && usage.openPeriod !== "absent") return "present";
        if (usage.state !== "observed" && observed.agent !== "deleted") return "unknown";
        const remote = await observeRemoteWorkloadAbsence(
          connection,
          createConnection,
          input.env,
          input.now,
          context,
          signal,
        );
        return remote;
      }),
    cleanupSecrets: async (context) =>
      withConnection(createConnection, async (connection) => {
        const agentId = context.agentId;
        if (!agentId) return "failed";
        const owned = await readOwnedAgent(connection, context.ownerUserId, agentId);
        if (!owned) return "failed";
        await connection.db.transaction((tx) =>
          revokeActiveAgentSecretsInTransaction(tx, { agentId, now: input.now() }),
        );
        return "accepted";
      }),
    observeSecretsAbsence: async (context) =>
      withConnection(createConnection, async (connection) => {
        if (!context.agentId) return "unknown";
        const observed = await observeHermesAgentSecretCounts(connection.db, {
          userId: context.ownerUserId,
          agentId: context.agentId,
        });
        return observed.state !== "observed"
          ? "unknown"
          : observed.allRevoked
            ? "absent"
            : "present";
      }),
    cleanupFirewall: async (context, signal) =>
      deleteProviderResource(createConnection, input.env, context, "firewall", signal),
    observeFirewallAbsence: async (context, signal) =>
      observeProviderAbsence(createConnection, input.env, context, "firewall", signal),
    cleanupDroplet: async (context, signal) =>
      deleteProviderResource(createConnection, input.env, context, "droplet", signal),
    observeDropletAbsence: async (context, signal) =>
      observeProviderAbsence(createConnection, input.env, context, "droplet", signal),
    cleanupRunner: async (context) =>
      withConnection(createConnection, (connection) =>
        revokeAndSoftDeleteExactRunner(connection, context, input.now()),
      ),
    observeRunnerAbsence: async (context) =>
      withConnection(createConnection, async (connection) => {
        if (!hasCoreIds(context)) return "unknown";
        const [credentials, resources, usage] = await Promise.all([
          observeHermesRunnerCredentialCount(connection.db, {
            userId: context.ownerUserId,
            runnerId: context.runnerId,
          }),
          observeHermesResourceAbsence(connection.db, {
            userId: context.ownerUserId,
            agentId: context.agentId,
            runnerId: context.runnerId,
          }),
          observeHermesOpenUsagePeriod(connection.db, {
            userId: context.ownerUserId,
            agentId: context.agentId,
          }),
        ]);
        return credentials.state === "observed" &&
          credentials.allRevoked &&
          resources.state === "observed" &&
          resources.allAbsent &&
          usage.state === "observed" &&
          usage.openPeriod === "absent"
          ? "absent"
          : "present";
      }),
  };
}

function readFixtureConfig(
  env: Record<string, string | undefined>,
  context: HermesStagingAcceptanceEffectContext,
):
  | {
      ok: true;
      canonicalRef: string;
      fixture: ReadyAgentFixture;
      secretValues: string[];
    }
  | { ok: false } {
  const canonicalRef = env.AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF;
  const imageMatch = canonicalRef ? CANONICAL_IMAGE_PATTERN.exec(canonicalRef) : null;
  const assistant = env.AGENTBAY_HERMES_STAGING_ASSISTANT;
  const openAiApiKey = env.AGENTBAY_HERMES_STAGING_OPENAI_API_KEY;
  const anthropicApiKey = env.AGENTBAY_HERMES_STAGING_ANTHROPIC_API_KEY;
  const assistantProfile = isAssistantChoice(assistant) ? getAssistantProfile(assistant) : null;
  const modelApiKey = assistant === "claude" ? anthropicApiKey : openAiApiKey;
  const telegramBotToken = env.AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN;
  const telegramAllowedUserId = env.AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID;
  const telegramChatId = env.AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID;
  const acceptanceBearer = env.AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET;
  const runnerBearer = env.AGENTBAY_RUNNER_BEARER_TOKEN;
  const providerToken = env.AGENTBAY_DIGITALOCEAN_TOKEN;
  let workloadImage: string;

  try {
    workloadImage = readHermesWorkloadImage(env);
  } catch {
    return { ok: false };
  }

  if (
    env.AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED !== "true" ||
    env.AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION !== BUDGET_SENTINEL ||
    env.AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION !== LIVE_SENTINEL ||
    !imageMatch ||
    imageMatch[1] !== context.expectedImageDigest ||
    workloadImage !== canonicalRef ||
    !UUID_PATTERN.test(context.ownerUserId) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/.test(context.idempotencyKey) ||
    !SOURCE_REVISION_PATTERN.test(context.expectedSourceRevision) ||
    !/^[1-9][0-9]{0,15}$/.test(context.expectedPublishWorkflowRunId) ||
    !assistantProfile ||
    !modelApiKey ||
    !validateAssistantApiKey(assistantProfile, modelApiKey).ok ||
    (assistant === "chatgpt" ? Boolean(anthropicApiKey) : Boolean(openAiApiKey)) ||
    !telegramBotToken ||
    !/^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{20,}$/.test(telegramBotToken) ||
    !telegramAllowedUserId ||
    !/^[1-9][0-9]{0,19}$/.test(telegramAllowedUserId) ||
    !telegramChatId ||
    !/^-?[1-9][0-9]{0,19}$/.test(telegramChatId) ||
    !isOpaqueSecret(acceptanceBearer) ||
    !isOpaqueSecret(runnerBearer) ||
    !providerToken ||
    providerToken.trim() !== providerToken ||
    providerToken.length < 32 ||
    new Set([acceptanceBearer, runnerBearer, providerToken, modelApiKey, telegramBotToken]).size !==
      5
  ) {
    return { ok: false };
  }

  try {
    const staging = readHermesStagingAcceptanceConfig(env);
    if (!staging.ok || !staging.enabled) return { ok: false };
    parseAgentSecretKeyring(env);
    const provider = readDigitalOceanProviderConfig(env);
    if (provider?.providerMode !== "digitalocean") return { ok: false };
  } catch {
    return { ok: false };
  }

  return {
    ok: true,
    canonicalRef,
    fixture: {
      name: `Hermes staging ${context.runId.slice(0, 8)}`,
      assistant: assistantProfile.assistant,
      modelApiKey,
      telegramBotToken,
      telegramAllowedUserId,
    },
    secretValues: [
      acceptanceBearer,
      runnerBearer,
      providerToken,
      modelApiKey,
      telegramBotToken,
      telegramAllowedUserId,
      telegramChatId,
    ],
  };
}

function verifyManualRollback(env: Record<string, string | undefined>): "passed" | "failed" {
  const disabled = readReadyAgentCreationFlag({
    ...env,
    AGENTBAY_READY_AGENT_CREATION_ENABLED: "false",
  });
  const stoppedPayload = validateCreateAgentPayload({
    name: "Hermes rollback fixture",
    templateKey: "research_agent",
    launchMode: "stopped",
  });
  const readyPayload = validateCreateAgentPayload({
    name: "Hermes rollback fixture",
    templateKey: "research_agent",
    launchMode: "ready",
    idempotencyKey: "rollback-proof-fixture",
    assistant: "chatgpt",
    modelApiKey: `sk-${"a".repeat(24)}`,
    telegramBotToken: `123456:${"a".repeat(20)}`,
    telegramAllowedUserIds: ["123456"],
  });

  return disabled.ok && !disabled.enabled && stoppedPayload.ok && readyPayload.ok
    ? "passed"
    : "failed";
}

async function discoverCreatedResource(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
): Promise<{
  state: "found" | "absent" | "conflict" | "unknown";
  resource?: CorrelatedResource;
}> {
  const deployment = await getAgentDeploymentByIdempotencyKeyForUser({
    db: connection.db,
    userId: context.ownerUserId,
    idempotencyKey: context.idempotencyKey,
  });
  if (!deployment) return { state: "absent" };
  if (
    (context.agentId !== null && context.agentId !== deployment.agentId) ||
    (context.deploymentId !== null && context.deploymentId !== deployment.id)
  ) {
    return { state: "conflict" };
  }
  const resource = await readCorrelatedResource(connection, {
    ...context,
    agentId: deployment.agentId,
    deploymentId: deployment.id,
  });
  return resource ? { state: "found", resource } : { state: "conflict" };
}

async function mapDeploymentProgress(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
  reconciled: AgentDeploymentReconcileResult,
): Promise<
  | { state: "observed"; stage: HermesStagingDeploymentStage; resource: CorrelatedResource }
  | { state: "failed" | "unknown" }
> {
  if (!context.agentId || !context.deploymentId) return { state: "unknown" };
  if (reconciled.outcome === "failed") return { state: "failed" };

  const history = await observeHermesDeploymentStageHistory(connection.db, {
    userId: context.ownerUserId,
    agentId: context.agentId,
    deploymentId: context.deploymentId,
  });
  if (history.state === "invalid") return { state: "failed" };

  const lastIndex = HERMES_STAGING_DEPLOYMENT_STAGES.indexOf(history.lastStage);
  const nextIndex = context.deploymentStageIndex + 1;
  if (nextIndex < 0 || nextIndex > lastIndex) return { state: "unknown" };
  const stage = HERMES_STAGING_DEPLOYMENT_STAGES[nextIndex];
  if (!stage) return { state: "failed" };
  const resource = await readCorrelatedResource(connection, context);
  return resource ? { state: "observed", stage, resource } : { state: "failed" };
}

async function readCorrelatedResource(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
): Promise<CorrelatedResource | null> {
  if (!context.agentId || !context.deploymentId) return null;
  const [row] = await connection.db
    .select({
      agentId: agents.id,
      agentUserId: agents.userId,
      agentRunnerId: agents.runnerId,
      agentDeletedAt: agents.deletedAt,
      deploymentId: agentDeployments.id,
      deploymentUserId: agentDeployments.userId,
      runnerId: runners.id,
      runnerUserId: runners.userId,
      runnerDeletedAt: runners.deletedAt,
      runnerKind: runners.kind,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
    })
    .from(agents)
    .innerJoin(agentDeployments, eq(agentDeployments.agentId, agents.id))
    .leftJoin(runners, eq(runners.id, agents.runnerId))
    .where(
      and(
        eq(agents.id, context.agentId),
        eq(agents.userId, context.ownerUserId),
        eq(agentDeployments.id, context.deploymentId),
        eq(agentDeployments.userId, context.ownerUserId),
      ),
    )
    .limit(1);

  if (
    !row ||
    row.agentDeletedAt !== null ||
    row.agentUserId !== context.ownerUserId ||
    row.deploymentUserId !== context.ownerUserId ||
    (row.runnerId !== null &&
      (row.runnerUserId !== context.ownerUserId ||
        row.runnerDeletedAt !== null ||
        row.runnerKind !== "digitalocean")) ||
    (context.runnerId !== null && row.runnerId !== context.runnerId) ||
    (context.providerResourceId !== null &&
      row.providerResourceId !== context.providerResourceId) ||
    (context.providerFirewallId !== null && row.providerFirewallId !== context.providerFirewallId)
  ) {
    return null;
  }

  return {
    agentId: row.agentId,
    deploymentId: row.deploymentId,
    runnerId: row.agentRunnerId,
    providerResourceId: row.providerResourceId,
    providerFirewallId: row.providerFirewallId,
  };
}

async function readExactRunner(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
): Promise<ManualRunnerRecord | null> {
  if (!context.runnerId || !context.agentId) return null;
  const [row] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      name: runners.name,
      kind: runners.kind,
      endpointUrl: runners.endpointUrl,
      status: runners.status,
      createdAt: runners.createdAt,
      updatedAt: runners.updatedAt,
      deletedAt: runners.deletedAt,
      assignedRunnerId: agents.runnerId,
    })
    .from(runners)
    .innerJoin(agents, and(eq(agents.runnerId, runners.id), eq(agents.id, context.agentId)))
    .where(
      and(
        eq(runners.id, context.runnerId),
        eq(runners.userId, context.ownerUserId),
        eq(agents.userId, context.ownerUserId),
        isNull(runners.deletedAt),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  if (
    !row?.endpointUrl ||
    row.kind !== "digitalocean" ||
    !["active", "online"].includes(row.status) ||
    row.assignedRunnerId !== context.runnerId
  ) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: row.kind,
    endpointUrl: row.endpointUrl,
    status: row.status as "active" | "online",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: null,
  };
}

async function readRestartObservation(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
): Promise<RestartObservation> {
  if (!context.agentId || !context.restartRequestedAt) return "unknown";
  const [row] = await connection.db
    .select({
      userId: agents.userId,
      runnerId: agents.runnerId,
      desiredStatus: agents.desiredStatus,
      status: agents.status,
      deletedAt: agents.deletedAt,
      runtimeState: agentRuntimeReconciliations.state,
      lastObservedAt: agentRuntimeReconciliations.lastObservedAt,
      lastReadyAt: agentRuntimeReconciliations.lastReadyAt,
      updatedAt: agentRuntimeReconciliations.updatedAt,
    })
    .from(agents)
    .leftJoin(
      agentRuntimeReconciliations,
      and(
        eq(agentRuntimeReconciliations.agentId, agents.id),
        eq(agentRuntimeReconciliations.userId, context.ownerUserId),
      ),
    )
    .where(eq(agents.id, context.agentId))
    .limit(1);

  if (
    !row ||
    row.userId !== context.ownerUserId ||
    row.deletedAt !== null ||
    row.runnerId !== context.runnerId
  ) {
    return "conflict";
  }
  if (row.desiredStatus !== "running") return "conflict";
  if (
    row.status === "running" &&
    row.lastReadyAt !== null &&
    row.lastObservedAt !== null &&
    row.lastReadyAt >= context.restartRequestedAt &&
    row.lastObservedAt >= context.restartRequestedAt &&
    row.updatedAt !== null &&
    row.updatedAt >= context.restartRequestedAt
  ) {
    return "completed";
  }
  return row.runtimeState ? "not_applied" : "unknown";
}

async function auditAllDiagnostics(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
  configuredSecrets: readonly string[],
  env: Record<string, string | undefined>,
  signal: AbortSignal,
): Promise<"safe" | "unsafe" | "unknown"> {
  if (!context.agentId || !context.runnerId || signal.aborted) return "unknown";
  const assistant = env.AGENTBAY_HERMES_STAGING_ASSISTANT;
  if (!isAssistantChoice(assistant)) return "unknown";
  const modelSecretKind = getAssistantProfile(assistant).secretKind;

  const decrypted = await readRequiredDecryptedActiveAgentSecretsForUser(
    context.ownerUserId,
    context.agentId,
    {
      createConnection: () => connection,
      env,
      kinds: [modelSecretKind, "telegram_bot_token", "telegram_allowed_users", "api_server_key"],
    },
  );
  if (!decrypted.ok) return "unknown";

  const runner = await readExactRunner(connection, context);
  if (!runner) return "unknown";
  await new ManualRunnerAdapter(runner, {
    createConnection: () => connection,
    env,
    signal,
    timeoutMs: 45_000,
  }).streamLogs({ agentId: context.agentId, limit: DIAGNOSTIC_PAGE_SIZE });
  if (signal.aborted) return "unknown";

  const sensitiveValues = [
    ...configuredSecrets,
    ...Object.values(decrypted.secrets),
    runner.endpointUrl,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  let after: number | null = null;
  let logsComplete = false;
  for (let pageIndex = 0; pageIndex < MAX_DIAGNOSTIC_PAGES; pageIndex += 1) {
    const page = await listAgentLogsForUser({
      db: connection.db,
      userId: context.ownerUserId,
      agentId: context.agentId,
      after,
      limit: DIAGNOSTIC_PAGE_SIZE,
    });
    if (hasHermesStagingDiagnosticLeak(page.logs, sensitiveValues)) return "unsafe";
    if (page.logs.length < DIAGNOSTIC_PAGE_SIZE) {
      logsComplete = true;
      break;
    }
    if (page.nextAfter === null || page.nextAfter === after) return "unknown";
    after = page.nextAfter;
  }
  if (!logsComplete) return "unknown";

  let cursor: string | null = null;
  let eventsComplete = false;
  for (let pageIndex = 0; pageIndex < MAX_DIAGNOSTIC_PAGES; pageIndex += 1) {
    const page = await listAgentEventFeedForUser({
      db: connection.db,
      userId: context.ownerUserId,
      agentId: context.agentId,
      cursor,
      limit: DIAGNOSTIC_PAGE_SIZE,
    });
    if (!page.ok) return "unknown";
    if (hasHermesStagingDiagnosticLeak(page.page.events, sensitiveValues)) return "unsafe";
    if (page.page.nextCursor === null) {
      eventsComplete = true;
      break;
    }
    if (page.page.nextCursor === cursor) return "unknown";
    cursor = page.page.nextCursor;
  }

  return eventsComplete ? "safe" : "unknown";
}

export function hasHermesStagingDiagnosticLeak(
  value: unknown,
  sensitiveValues: readonly string[],
): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return true;
  }
  if (Buffer.byteLength(serialized, "utf8") > 8 * 1024 * 1024) return true;
  if (sensitiveValues.some((secret) => secret.length >= 4 && serialized.includes(secret))) {
    return true;
  }
  return (
    /https?:\/\/(?:localhost|127\.0\.0\.1|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
      serialized,
    ) ||
    /\b(?:droplet|firewall|provider)[_-]?(?:response|body)\b/i.test(serialized) ||
    /\b(?:authorization|api[_-]?key|bot[_-]?token|bearer)\b\s*[:=]\s*["']?(?!\[redacted\])/i.test(
      serialized,
    )
  );
}

async function readProviderExpectation(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
): Promise<DigitalOceanOwnedSetExpectation | null> {
  if (
    !context.runnerId ||
    !context.providerResourceId ||
    !context.providerFirewallId ||
    !LOCATOR_PATTERN.test(context.providerResourceId) ||
    !LOCATOR_PATTERN.test(context.providerFirewallId)
  ) {
    return null;
  }
  const [row] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      name: runners.name,
      kind: runners.kind,
      provider: runners.provider,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
      region: runners.region,
      sizeSlug: runners.sizeSlug,
      operationTag: runners.provisioningOperationKey,
    })
    .from(runners)
    .where(and(eq(runners.id, context.runnerId), eq(runners.userId, context.ownerUserId)))
    .limit(1);

  if (
    row?.kind !== "digitalocean" ||
    row.provider !== "digitalocean" ||
    row.providerResourceId !== context.providerResourceId ||
    row.providerFirewallId !== context.providerFirewallId ||
    !row.region ||
    !row.sizeSlug ||
    !row.operationTag ||
    !LOCATOR_PATTERN.test(row.operationTag)
  ) {
    return null;
  }
  return {
    operationTag: row.operationTag,
    providerResourceId: context.providerResourceId,
    providerFirewallId: context.providerFirewallId,
    expectedName: row.name,
    expectedRegion: row.region,
    expectedSizeSlug: row.sizeSlug,
    expectedFirewallName: digitalOceanRunnerFirewallName(context.providerResourceId),
  };
}

async function resolveOwnedSetProvider(
  env: Record<string, string | undefined>,
): Promise<DigitalOceanOwnedSetProvider | null> {
  let config: ReturnType<typeof readDigitalOceanProviderConfig>;
  try {
    config = readDigitalOceanProviderConfig(env);
  } catch {
    return null;
  }
  if (config?.providerMode !== "digitalocean") return null;
  const provider = createConfiguredDigitalOceanProvider(
    config,
  ) as Partial<DigitalOceanOwnedSetProvider>;
  return typeof provider.observeOwnedSet === "function" &&
    typeof provider.deleteFirewall === "function" &&
    typeof provider.deleteDroplet === "function"
    ? (provider as DigitalOceanOwnedSetProvider)
    : null;
}

async function deleteProviderResource(
  createConnection: () => DatabaseConnection,
  env: Record<string, string | undefined>,
  context: HermesStagingAcceptanceEffectContext,
  resource: "firewall" | "droplet",
  signal: AbortSignal,
): Promise<Mutation> {
  if (signal.aborted) return "unknown";
  const expectation = await withConnection(createConnection, (connection) =>
    readProviderExpectation(connection, context),
  );
  const provider = await resolveOwnedSetProvider(env);
  if (!expectation || !provider) return "failed";
  const deleted =
    resource === "firewall"
      ? await provider.deleteFirewall(expectation, { signal })
      : await provider.deleteDroplet(expectation, { signal });
  if (signal.aborted) return "unknown";
  return deleted.ok
    ? "accepted"
    : deleted.reason === "ownership_ambiguous" || deleted.reason === "cleanup_order_violation"
      ? "failed"
      : "unknown";
}

async function observeProviderAbsence(
  createConnection: () => DatabaseConnection,
  env: Record<string, string | undefined>,
  context: HermesStagingAcceptanceEffectContext,
  resource: "firewall" | "droplet",
  signal: AbortSignal,
): Promise<Absence> {
  if (signal.aborted) return "unknown";
  const expectation = await withConnection(createConnection, (connection) =>
    readProviderExpectation(connection, context),
  );
  const provider = await resolveOwnedSetProvider(env);
  if (!expectation || !provider) return "unknown";
  const observed = await provider.observeOwnedSet(expectation, { signal });
  if (!observed.ok || signal.aborted) return "unknown";
  const presence = resource === "firewall" ? observed.value.firewall : observed.value.droplet;
  return presence === "absent" ? "absent" : "present";
}

async function revokeAndSoftDeleteExactRunner(
  connection: DatabaseConnection,
  context: HermesStagingAcceptanceEffectContext,
  now: Date,
): Promise<Mutation> {
  const runnerId = context.runnerId;
  if (!runnerId) return "failed";
  return connection.db.transaction(async (tx) => {
    const [runner] = await tx
      .select({
        id: runners.id,
        userId: runners.userId,
        providerResourceId: runners.providerResourceId,
        providerFirewallId: runners.providerFirewallId,
        deletedAt: runners.deletedAt,
      })
      .from(runners)
      .where(eq(runners.id, runnerId))
      .limit(1)
      .for("update");
    if (!runner || runner.userId !== context.ownerUserId) return "failed";
    if (
      runner.providerResourceId !== context.providerResourceId ||
      runner.providerFirewallId !== context.providerFirewallId
    ) {
      return "failed";
    }
    if (runner.deletedAt !== null) return "accepted";

    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(runnerCredentials.runnerId, runnerId), eq(runnerCredentials.status, "active")));
    const [deleted] = await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        provisioningError: null,
        provisioningCompletedAt: now,
        deletedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(runners.id, runnerId),
          eq(runners.userId, context.ownerUserId),
          isNull(runners.deletedAt),
        ),
      )
      .returning({ id: runners.id });
    return deleted ? "accepted" : "unknown";
  });
}

async function observeRemoteWorkloadAbsence(
  connection: DatabaseConnection,
  createConnection: () => DatabaseConnection,
  env: Record<string, string | undefined>,
  now: () => Date,
  context: HermesStagingAcceptanceEffectContext,
  signal: AbortSignal,
): Promise<Absence> {
  if (!context.agentId || !context.runnerId || signal.aborted) return "unknown";
  const [row] = await connection.db
    .select({
      id: runners.id,
      userId: runners.userId,
      name: runners.name,
      kind: runners.kind,
      endpointUrl: runners.endpointUrl,
      status: runners.status,
      createdAt: runners.createdAt,
      updatedAt: runners.updatedAt,
      deletedAt: runners.deletedAt,
    })
    .from(runners)
    .where(and(eq(runners.id, context.runnerId), eq(runners.userId, context.ownerUserId)))
    .limit(1);
  if (
    !row?.endpointUrl ||
    row.deletedAt !== null ||
    row.kind !== "digitalocean" ||
    !["active", "online"].includes(row.status)
  ) {
    return "unknown";
  }
  const runner: ManualRunnerRecord = {
    id: row.id,
    userId: row.userId,
    name: row.name,
    kind: "digitalocean",
    endpointUrl: row.endpointUrl,
    status: row.status as "active" | "online",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    deletedAt: null,
  };
  const status = await new ManualRunnerAdapter(runner, {
    createConnection,
    env,
    now,
    signal,
    timeoutMs: 45_000,
  }).status(context.agentId);
  if (!status.ok || !("snapshot" in status) || signal.aborted) return "unknown";
  return status.snapshot.container.state === "absent" &&
    ["idle", "stopped", "cancelled"].includes(status.snapshot.phase)
    ? "absent"
    : "present";
}

async function readOwnedAgent(
  connection: DatabaseConnection,
  userId: string,
  agentId: string,
): Promise<boolean> {
  const [row] = await connection.db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.userId, userId)))
    .limit(1);
  return Boolean(row);
}

function hasCoreIds(
  context: HermesStagingAcceptanceEffectContext,
): context is HermesStagingAcceptanceEffectContext & { agentId: string; runnerId: string } {
  return context.agentId !== null && context.runnerId !== null;
}

async function withConnection<T>(
  createConnection: () => DatabaseConnection,
  operation: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = createConnection();
  try {
    return await operation(connection);
  } finally {
    await connection.close();
  }
}

function isOpaqueSecret(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9._~+/=-]{32,256}$/.test(value);
}

function resourceEvidence(resource: CorrelatedResource) {
  return {
    agentId: resource.agentId,
    deploymentId: resource.deploymentId,
    ...(resource.runnerId ? { runnerId: resource.runnerId } : {}),
    ...(resource.providerResourceId ? { providerResourceId: resource.providerResourceId } : {}),
    ...(resource.providerFirewallId ? { providerFirewallId: resource.providerFirewallId } : {}),
  };
}

function resourceMutationExecution(
  effect: "create_ready_agent",
  mutation: { state: Mutation; resource?: CorrelatedResource },
  _now: Date,
): HermesStagingAcceptanceEffectExecution {
  return mutation.state === "accepted" && mutation.resource
    ? {
        result: { effect, outcome: "accepted" },
        evidence: resourceEvidence(mutation.resource),
      }
    : result(effect, mutation.state === "accepted" ? "unknown" : mutation.state);
}

function issueChallenge(
  effect: "issue_initial_human_challenge" | "issue_post_restart_human_challenge",
  context: HermesStagingAcceptanceEffectContext,
  now: Date,
): HermesStagingAcceptanceEffectExecution {
  const expectedPurpose = effect === "issue_initial_human_challenge" ? "initial" : "post_restart";
  const challenge = context.challenge;
  return challenge &&
    challenge.purpose === expectedPurpose &&
    /^sha256:[0-9a-f]{64}$/.test(challenge.digest) &&
    challenge.expiresAt.getTime() > now.getTime()
    ? {
        result: {
          effect,
          outcome: "issued",
          challengeDigest: challenge.digest,
          expiresAtMs: challenge.expiresAt.getTime(),
        },
      }
    : result(effect, "unknown");
}

function observeChallenge(
  effect: "observe_initial_human_challenge" | "observe_post_restart_human_challenge",
  context: HermesStagingAcceptanceEffectContext,
): HermesStagingAcceptanceEffectExecution {
  const expectedPurpose = effect === "observe_initial_human_challenge" ? "initial" : "post_restart";
  const challenge = context.challenge;
  return challenge &&
    challenge.purpose === expectedPurpose &&
    /^sha256:[0-9a-f]{64}$/.test(challenge.digest)
    ? {
        result: {
          effect,
          outcome: "found",
          challengeDigest: challenge.digest,
          expiresAtMs: challenge.expiresAt.getTime(),
        },
      }
    : result(effect, "missing");
}

function cleanupMutationExecution(
  effect:
    | "cleanup_workload"
    | "cleanup_secrets"
    | "cleanup_firewall"
    | "cleanup_droplet"
    | "cleanup_runner",
  outcome: Mutation,
): HermesStagingAcceptanceEffectExecution {
  return result(effect, outcome);
}

function absenceExecution(
  effect:
    | "observe_workload_absence"
    | "observe_secrets_absence"
    | "observe_firewall_absence"
    | "observe_droplet_absence"
    | "observe_runner_absence",
  outcome: Absence,
  now: Date,
): HermesStagingAcceptanceEffectExecution {
  if (outcome !== "absent") return result(effect, outcome);
  const evidence =
    effect === "observe_workload_absence"
      ? { workloadCleanupConfirmedAt: now }
      : effect === "observe_secrets_absence"
        ? { secretsCleanupConfirmedAt: now }
        : effect === "observe_firewall_absence"
          ? { firewallCleanupConfirmedAt: now }
          : effect === "observe_droplet_absence"
            ? { dropletCleanupConfirmedAt: now }
            : { runnerCleanupConfirmedAt: now };
  return { result: { effect, outcome }, evidence } as HermesStagingAcceptanceEffectExecution;
}

function result(
  effect: HermesStagingAcceptanceEffectKind,
  outcome: string,
): HermesStagingAcceptanceEffectExecution {
  return { result: { effect, outcome } as never };
}

function unknownExecution(
  effect: HermesStagingAcceptanceEffectKind,
): HermesStagingAcceptanceEffectExecution {
  switch (effect) {
    case "issue_initial_human_challenge":
    case "issue_post_restart_human_challenge":
    case "observe_initial_human_challenge":
    case "observe_post_restart_human_challenge":
      return result(effect, "unknown");
    case "observe_agent_creation":
      return result(effect, "unknown");
    case "observe_next_deployment_stage":
      return result(effect, "unknown");
    case "verify_strict_host_image":
    case "verify_restarted_image_and_telegram":
      return result(effect, "unknown");
    case "audit_safe_diagnostics":
      return result(effect, "unknown");
    case "observe_stop_intent":
      return result(effect, "unknown");
    case "observe_stop_stability":
      return result(effect, "unknown");
    case "verify_manual_rollback":
      return result(effect, "unknown");
    case "observe_workload_absence":
    case "observe_secrets_absence":
    case "observe_firewall_absence":
    case "observe_droplet_absence":
    case "observe_runner_absence":
      return result(effect, "unknown");
    case "preflight":
    case "attest_published_image":
      return result(effect, "unknown");
    default:
      return result(effect, "unknown");
  }
}
