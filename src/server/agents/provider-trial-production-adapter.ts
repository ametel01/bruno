import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import type { AssistantChoice } from "@/src/server/agents/assistant-profiles";
import { reconcileTargetAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { getAgentDeploymentByIdempotencyKeyForUser } from "@/src/server/agents/agent-deployments";
import { createAgentForUser } from "@/src/server/agents/create-agent";
import { deleteAgentForUser } from "@/src/server/agents/lifecycle";
import { providerTrialDeploymentIdempotencyKey } from "@/src/server/agents/provider-trial-cohort";
import type { ProviderTrialDriverDependencies } from "@/src/server/agents/provider-trial-driver";
import { PROVIDER_TRIAL_APPROVED_SCOPE } from "@/src/server/agents/provider-trial-operator-config";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentDeployments,
  agentSecrets,
  agents,
  providerTrialSlots,
  runnerCredentials,
  runners,
} from "@/src/server/db/schema";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
import type {
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
} from "@/src/server/runners/digitalocean-provider";
import {
  createConfiguredDigitalOceanProvider,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";

type TrialFixture = {
  assistant: AssistantChoice;
  modelApiKey: string;
  telegramBotToken: string;
  telegramUserId: string;
};

type CreateReadyDeploymentResult =
  | {
      state: "committed";
      deploymentId: string;
      activeProviderResources: number;
    }
  | { state: "rejected" | "validation_failed" };

type CreateReadyDeployment = (input: {
  ownerUserId: string;
  name: string;
  idempotencyKey: string;
  fixture: TrialFixture;
  identity: { origin: "operator_trial"; environment: "non_production" };
  signal: AbortSignal;
}) => Promise<CreateReadyDeploymentResult>;

type FindDeployment = (input: {
  ownerUserId: string;
  idempotencyKey: string;
}) => Promise<
  | { state: "found"; deploymentId: string; activeProviderResources: number }
  | { state: "absent" | "conflict" | "unknown" }
>;

type ObserveDeployment = (input: {
  ownerUserId: string;
  idempotencyKey: string;
  deploymentId: string;
  signal: AbortSignal;
}) => Promise<{ state: "ready" | "failed" | "pending" | "conflict" | "unknown" }>;

type CleanupCohort = (input: {
  ownerUserId: string;
  cohortId: string;
  signal: AbortSignal;
}) => Promise<{ ok: boolean; authoritative: boolean; remainingResourceIds: string[] }>;

export type ProviderTrialProductionAdapterOptions = {
  ownerUserId: string;
  fixture: TrialFixture;
  env?: Record<string, string | undefined>;
  createConnection?: () => DatabaseConnection;
  createReadyDeployment?: CreateReadyDeployment;
  findDeployment?: FindDeployment;
  observeDeployment?: ObserveDeployment;
  cleanupCohort?: CleanupCohort;
  now?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
};

export function createProviderTrialProductionDriverDependencies(
  options: ProviderTrialProductionAdapterOptions,
): ProviderTrialDriverDependencies {
  const createReadyDeployment =
    options.createReadyDeployment ?? createDefaultReadyDeployment(options);
  const findDeployment = options.findDeployment ?? createDefaultFindDeployment(options);
  const observeDeployment = options.observeDeployment ?? createDefaultObserveDeployment(options);
  const cleanupCohort = options.cleanupCohort ?? createDefaultCleanupCohort(options);
  const now = options.now ?? (() => new Date());
  const wait =
    options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  return {
    async executeSlot(attempt, context) {
      if (
        context.signal.aborted ||
        context.maxProviderResources !== PROVIDER_TRIAL_APPROVED_SCOPE.maxProviderResources ||
        context.maxCostCents !== PROVIDER_TRIAL_APPROVED_SCOPE.maxSlotCostCents ||
        context.authorizationScope.region !== PROVIDER_TRIAL_APPROVED_SCOPE.region ||
        context.authorizationScope.runnerSizeSlug !== PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug
      ) {
        return {
          outcome: "safety_pause",
          safeCode: "safety_failure",
          costCents: 0,
          activeProviderResources: 0,
        };
      }

      const result = await createReadyDeployment({
        ownerUserId: options.ownerUserId,
        name: `Provider Trial ${attempt.slotNumber.toString().padStart(2, "0")}`,
        idempotencyKey: context.idempotencyKey,
        fixture: options.fixture,
        identity: { origin: "operator_trial", environment: "non_production" },
        signal: context.signal,
      });

      if (result.state !== "committed") {
        return {
          outcome: "pre_commit_failure",
          safeCode:
            result.state === "validation_failed" ? "request_validation_failed" : "request_rejected",
          costCents: 0,
          activeProviderResources: 0,
        };
      }

      if (result.activeProviderResources > context.maxProviderResources) {
        return {
          outcome: "safety_pause",
          safeCode: "safety_failure",
          costCents: context.maxCostCents,
          activeProviderResources: result.activeProviderResources,
        };
      }

      return {
        outcome: "committed",
        deploymentId: result.deploymentId,
        costCents: context.maxCostCents,
        activeProviderResources: result.activeProviderResources,
      };
    },
    async reconcileRequest(_attempt, context) {
      const result = await findDeployment({
        ownerUserId: options.ownerUserId,
        idempotencyKey: context.idempotencyKey,
      });
      if (result.state === "absent") {
        return {
          outcome: "pre_commit_failure",
          safeCode: "request_failed",
          costCents: 0,
          activeProviderResources: 0,
        };
      }
      if (result.state !== "found") return { outcome: "request_outcome_unknown" };
      return {
        outcome: "committed",
        deploymentId: result.deploymentId,
        costCents: context.maxCostCents,
        activeProviderResources: result.activeProviderResources,
      };
    },
    async observeCommittedSlot(attempt, context) {
      const idempotencyKey = providerTrialDeploymentIdempotencyKey(attempt.requestAttemptId);
      const found = await findDeployment({ ownerUserId: options.ownerUserId, idempotencyKey });
      if (found.state !== "found") return "safety_failure";
      while (!context.signal.aborted && now().getTime() <= Date.parse(context.deadlineAt)) {
        const observation = await observeDeployment({
          ownerUserId: options.ownerUserId,
          idempotencyKey,
          deploymentId: found.deploymentId,
          signal: context.signal,
        });
        if (observation.state === "ready" || observation.state === "failed") {
          return "observe_deployment";
        }
        if (observation.state === "conflict") return "safety_failure";
        if (observation.state === "unknown") return "safety_failure";
        await wait(1_000);
      }
      return "timed_out";
    },
    async cleanup(context) {
      return await cleanupCohort({
        ownerUserId: options.ownerUserId,
        cohortId: context.cohortId,
        signal: context.signal,
      });
    },
  };
}

function createDefaultReadyDeployment(
  options: ProviderTrialProductionAdapterOptions,
): CreateReadyDeployment {
  const env = options.env ?? process.env;
  const connectionDependency = options.createConnection
    ? { createConnection: options.createConnection }
    : {};

  return async (input) => {
    if (input.signal.aborted) return { state: "rejected" };
    const response = await createAgentForUser(
      input.ownerUserId,
      {
        name: input.name,
        templateKey: "research_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: input.idempotencyKey,
        assistant: input.fixture.assistant,
        modelApiKey: input.fixture.modelApiKey,
        telegramBotToken: input.fixture.telegramBotToken,
        telegramAllowedUserIds: [input.fixture.telegramUserId],
      },
      {
        env: { ...env, BRUNO_READY_AGENT_CREATION_ENABLED: "true" },
        ...connectionDependency,
        readyDeploymentIdentity: input.identity,
      },
    );
    if (!("deployment" in response)) return { state: "rejected" };
    return {
      state: "committed",
      deploymentId: response.deployment.id,
      activeProviderResources: response.agent.runnerId ? 1 : 0,
    };
  };
}

function createDefaultFindDeployment(
  options: ProviderTrialProductionAdapterOptions,
): FindDeployment {
  const createConnection = options.createConnection ?? createDatabaseConnection;
  return async (input) => {
    const connection = createConnection();
    try {
      const deployment = await getAgentDeploymentByIdempotencyKeyForUser({
        db: connection.db,
        userId: input.ownerUserId,
        idempotencyKey: input.idempotencyKey,
      });
      if (!deployment) return { state: "absent" };
      const [resource] = await connection.db
        .select({ providerResourceId: runners.providerResourceId })
        .from(agentDeployments)
        .innerJoin(agents, eq(agents.id, agentDeployments.agentId))
        .leftJoin(runners, eq(runners.id, agents.runnerId))
        .where(
          and(
            eq(agentDeployments.id, deployment.id),
            eq(agentDeployments.userId, input.ownerUserId),
          ),
        )
        .limit(1);
      return {
        state: "found",
        deploymentId: deployment.id,
        activeProviderResources: resource?.providerResourceId ? 1 : 0,
      };
    } catch {
      return { state: "unknown" };
    } finally {
      await connection.close();
    }
  };
}

function createDefaultObserveDeployment(
  options: ProviderTrialProductionAdapterOptions,
): ObserveDeployment {
  const createConnection = options.createConnection ?? createDatabaseConnection;
  const connectionDependency = options.createConnection
    ? { createConnection: options.createConnection }
    : {};
  return async (input) => {
    if (input.signal.aborted) return { state: "unknown" };
    try {
      await reconcileTargetAgentDeployment(input.deploymentId, connectionDependency);
      const connection = createConnection();
      try {
        const deployment = await getAgentDeploymentByIdempotencyKeyForUser({
          db: connection.db,
          userId: input.ownerUserId,
          idempotencyKey: input.idempotencyKey,
        });
        if (!deployment || deployment.id !== input.deploymentId) return { state: "conflict" };
        return deployment.stage === "ready" || deployment.stage === "failed"
          ? { state: deployment.stage }
          : { state: "pending" };
      } finally {
        await connection.close();
      }
    } catch {
      return { state: "unknown" };
    }
  };
}

function createDefaultCleanupCohort(options: ProviderTrialProductionAdapterOptions): CleanupCohort {
  const createConnection = options.createConnection ?? createDatabaseConnection;
  const connectionDependency = options.createConnection
    ? { createConnection: options.createConnection }
    : {};
  const env = options.env ?? process.env;

  return async (input) => {
    const connection = createConnection();
    try {
      const resources = await readCohortResources(connection, input.cohortId);
      if (
        resources.some(
          (resource) =>
            resource.userId !== input.ownerUserId || resource.origin !== "operator_trial",
        )
      ) {
        return unsafeCleanup("identity");
      }

      const provider = resolveOwnedSetProvider(env);
      for (const resource of resources) {
        if (input.signal.aborted) return unsafeCleanup("deadline");
        if (resource.agentDeletedAt === null) {
          const deleted = await deleteAgentForUser(input.ownerUserId, resource.agentId, {
            ...connectionDependency,
          });
          if (!deleted.ok) return unsafeCleanup(`slot:${resource.slotNumber}:workload`);
        }

        if (resource.runnerId !== null) {
          const expectation = toProviderTrialOwnedSetExpectation(resource);
          if (!expectation || !provider) {
            return unsafeCleanup(`slot:${resource.slotNumber}:provider`);
          }
          const before = await provider.observeOwnedSet(expectation, { signal: input.signal });
          if (!before.ok) return unsafeCleanup(`slot:${resource.slotNumber}:provider`);
          if (before.value.firewall === "present") {
            const deleted = await provider.deleteFirewall(expectation, { signal: input.signal });
            if (!deleted.ok) return unsafeCleanup(`slot:${resource.slotNumber}:firewall`);
          }
          const afterFirewall = await provider.observeOwnedSet(expectation, {
            signal: input.signal,
          });
          if (!afterFirewall.ok || afterFirewall.value.firewall !== "absent") {
            return unsafeCleanup(`slot:${resource.slotNumber}:firewall`);
          }
          if (afterFirewall.value.droplet === "present") {
            const deleted = await provider.deleteDroplet(expectation, { signal: input.signal });
            if (!deleted.ok) return unsafeCleanup(`slot:${resource.slotNumber}:droplet`);
          }
          const absent = await provider.observeOwnedSet(expectation, { signal: input.signal });
          if (!absent.ok || absent.value.state !== "absent") {
            return unsafeCleanup(`slot:${resource.slotNumber}:provider`);
          }
          await revokeAndDeleteRunner(connection, input.ownerUserId, resource.runnerId);
        }
      }

      const remaining = await readRemainingLogicalResources(
        connection,
        input.cohortId,
        input.ownerUserId,
      );
      return {
        ok: remaining.length === 0,
        authoritative: true,
        remainingResourceIds: remaining,
      };
    } catch {
      return unsafeCleanup("observation");
    } finally {
      await connection.close();
    }
  };
}

type CohortResource = {
  slotNumber: number;
  origin: string | null;
  userId: string;
  agentId: string;
  agentDeletedAt: Date | null;
  runnerId: string | null;
  runnerName: string | null;
  runnerKind: string | null;
  runnerProvider: string | null;
  runnerRegion: string | null;
  runnerSizeSlug: string | null;
  operationTag: string | null;
  providerResourceId: string | null;
  providerFirewallId: string | null;
};

async function readCohortResources(
  connection: DatabaseConnection,
  cohortId: string,
): Promise<CohortResource[]> {
  return await connection.db
    .select({
      slotNumber: providerTrialSlots.slotNumber,
      origin: agentDeployments.origin,
      userId: agentDeployments.userId,
      agentId: agents.id,
      agentDeletedAt: agents.deletedAt,
      runnerId: runners.id,
      runnerName: runners.name,
      runnerKind: runners.kind,
      runnerProvider: runners.provider,
      runnerRegion: runners.region,
      runnerSizeSlug: runners.sizeSlug,
      operationTag: runners.provisioningOperationKey,
      providerResourceId: runners.providerResourceId,
      providerFirewallId: runners.providerFirewallId,
    })
    .from(providerTrialSlots)
    .innerJoin(agentDeployments, eq(agentDeployments.id, providerTrialSlots.deploymentId))
    .innerJoin(agents, eq(agents.id, agentDeployments.agentId))
    .leftJoin(runners, eq(runners.id, agents.runnerId))
    .where(eq(providerTrialSlots.cohortId, cohortId))
    .orderBy(providerTrialSlots.slotNumber);
}

export function toProviderTrialOwnedSetExpectation(
  resource: CohortResource,
): DigitalOceanOwnedSetExpectation | null {
  if (
    resource.runnerKind !== "digitalocean" ||
    resource.runnerProvider !== "digitalocean" ||
    !resource.runnerRegion ||
    !resource.runnerSizeSlug ||
    !resource.operationTag ||
    !resource.providerResourceId ||
    !resource.providerFirewallId
  ) {
    return null;
  }
  return {
    operationTag: resource.operationTag,
    providerResourceId: resource.providerResourceId,
    providerFirewallId: resource.providerFirewallId,
    expectedName: resource.operationTag,
    expectedRegion: resource.runnerRegion,
    expectedSizeSlug: resource.runnerSizeSlug,
    expectedFirewallName: digitalOceanRunnerFirewallName(resource.providerResourceId),
  };
}

function resolveOwnedSetProvider(
  env: Record<string, string | undefined>,
): DigitalOceanOwnedSetProvider | null {
  const config = readDigitalOceanProviderConfig(env);
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

async function revokeAndDeleteRunner(
  connection: DatabaseConnection,
  userId: string,
  runnerId: string,
): Promise<void> {
  const now = new Date();
  await connection.db.transaction(async (tx) => {
    await tx
      .update(runnerCredentials)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(and(eq(runnerCredentials.runnerId, runnerId), eq(runnerCredentials.status, "active")));
    await tx
      .update(runners)
      .set({
        status: "deleted",
        provisioningStatus: "deleted",
        provisioningError: null,
        provisioningCompletedAt: now,
        deletedAt: now,
        updatedAt: now,
      })
      .where(and(eq(runners.id, runnerId), eq(runners.userId, userId), isNull(runners.deletedAt)));
  });
}

async function readRemainingLogicalResources(
  connection: DatabaseConnection,
  cohortId: string,
  ownerUserId: string,
): Promise<string[]> {
  const rows = await connection.db.execute<{ slotNumber: number; kind: string }>(sql`
    select s.slot_number as "slotNumber", remaining.kind
    from ${providerTrialSlots} s
    join ${agentDeployments} d on d.id = s.deployment_id and d.user_id = ${ownerUserId}
    join ${agents} a on a.id = d.agent_id and a.user_id = d.user_id
    left join ${runners} r on r.id = a.runner_id and r.user_id = d.user_id
    cross join lateral (
      select 'workload' as kind where a.deleted_at is null
      union all
      select 'secret' where exists (
        select 1 from ${agentSecrets} sec where sec.agent_id = a.id and sec.revoked_at is null
      )
      union all
      select 'runner' where r.id is not null and r.deleted_at is null
    ) remaining
    where s.cohort_id = ${cohortId}
    order by s.slot_number, remaining.kind
  `);
  return rows.map((row) => `slot:${row.slotNumber}:${row.kind}`);
}

function unsafeCleanup(locator: string) {
  return { ok: false, authoritative: false, remainingResourceIds: [locator] };
}
