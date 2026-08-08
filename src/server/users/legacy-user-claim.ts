import { asc, eq, isNull, sql } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  agentApprovals,
  agentConfigs,
  agentEvents,
  agentLogs,
  agentUsagePeriods,
  agents,
  backups,
  dockerRunnerContainers,
  localRunnerProcesses,
  runnerCredentials,
  runnerHeartbeats,
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";
import {
  type ApplicationUserTransaction,
  assertClerkUserId,
  lockClerkUserId,
} from "@/src/server/users/application-user";

export type LegacyUserOwnedCounts = {
  users: number;
  runners: number;
  runnerProvisioningEvents: number;
  runnerRegistrationTokens: number;
  runnerCredentials: number;
  runnerHeartbeats: number;
  agents: number;
  agentUsagePeriods: number;
  backups: number;
  agentConfigs: number;
  agentEvents: number;
  localRunnerProcesses: number;
  dockerRunnerContainers: number;
  agentLogs: number;
  agentApprovals: number;
};

export type LegacyUserClaimResult =
  | {
      ok: true;
      status: "preview" | "claimed" | "already_claimed";
      dryRun: boolean;
      counts: LegacyUserOwnedCounts;
    }
  | {
      ok: false;
      status: "ambiguous" | "conflict" | "no_legacy_user";
      dryRun: boolean;
      candidateCount: number;
    };

export type ClaimLegacyUserDependencies = {
  createConnection?: () => DatabaseConnection;
};

type LegacyCountRow = {
  users: number;
  runners: number;
  runner_provisioning_events: number;
  runner_registration_tokens: number;
  runner_credentials: number;
  runner_heartbeats: number;
  agents: number;
  agent_usage_periods: number;
  backups: number;
  agent_configs: number;
  agent_events: number;
  local_runner_processes: number;
  docker_runner_containers: number;
  agent_logs: number;
  agent_approvals: number;
};

export async function claimLegacyUser(
  input: {
    clerkUserId: string;
    apply?: boolean;
  },
  dependencies: ClaimLegacyUserDependencies = {},
): Promise<LegacyUserClaimResult> {
  assertClerkUserId(input.clerkUserId);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction((tx) =>
      claimLegacyUserInTransaction(tx, {
        clerkUserId: input.clerkUserId,
        apply: input.apply === true,
      }),
    );
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function claimLegacyUserInTransaction(
  tx: ApplicationUserTransaction,
  input: {
    clerkUserId: string;
    apply: boolean;
  },
): Promise<LegacyUserClaimResult> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bruno:legacy-user-claim'))`);
  await lockClerkUserId(tx, input.clerkUserId);

  const [[mappedUser], legacyCandidates] = await Promise.all([
    tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.clerkUserId, input.clerkUserId))
      .limit(1)
      .for("update"),
    tx
      .select({ id: users.id })
      .from(users)
      .where(isNull(users.clerkUserId))
      .orderBy(asc(users.createdAt), asc(users.id))
      .for("update"),
  ]);

  if (mappedUser) {
    if (legacyCandidates.length > 0) {
      return {
        ok: false,
        status: "conflict",
        dryRun: !input.apply,
        candidateCount: legacyCandidates.length,
      };
    }

    return {
      ok: true,
      status: "already_claimed",
      dryRun: !input.apply,
      counts: await countLegacyUserOwnedRows(tx, mappedUser.id),
    };
  }

  if (legacyCandidates.length === 0) {
    return {
      ok: false,
      status: "no_legacy_user",
      dryRun: !input.apply,
      candidateCount: 0,
    };
  }

  if (legacyCandidates.length > 1) {
    return {
      ok: false,
      status: "ambiguous",
      dryRun: !input.apply,
      candidateCount: legacyCandidates.length,
    };
  }

  const legacyUser = legacyCandidates[0];

  if (!legacyUser) {
    throw new Error("Legacy user candidate unexpectedly missing.");
  }

  const counts = await countLegacyUserOwnedRows(tx, legacyUser.id);

  if (!input.apply) {
    return {
      ok: true,
      status: "preview",
      dryRun: true,
      counts,
    };
  }

  const [claimedUser] = await tx
    .update(users)
    .set({
      clerkUserId: input.clerkUserId,
      updatedAt: new Date(),
    })
    .where(eq(users.id, legacyUser.id))
    .returning({ id: users.id });

  if (!claimedUser) {
    throw new Error("Legacy user claim update returned no rows.");
  }

  return {
    ok: true,
    status: "claimed",
    dryRun: false,
    counts,
  };
}

async function countLegacyUserOwnedRows(
  tx: ApplicationUserTransaction,
  userId: string,
): Promise<LegacyUserOwnedCounts> {
  const [row] = await tx.execute<LegacyCountRow>(sql`
    select
      1::int as users,
      (select count(*)::int from ${runners} where ${runners.userId} = ${userId}) as runners,
      (
        select count(*)::int
        from ${runnerProvisioningEvents}
        inner join ${runners} on ${runners.id} = ${runnerProvisioningEvents.runnerId}
        where ${runners.userId} = ${userId}
      ) as runner_provisioning_events,
      (
        select count(*)::int
        from ${runnerRegistrationTokens}
        where ${runnerRegistrationTokens.userId} = ${userId}
      ) as runner_registration_tokens,
      (
        select count(*)::int
        from ${runnerCredentials}
        inner join ${runners} on ${runners.id} = ${runnerCredentials.runnerId}
        where ${runners.userId} = ${userId}
      ) as runner_credentials,
      (
        select count(*)::int
        from ${runnerHeartbeats}
        inner join ${runners} on ${runners.id} = ${runnerHeartbeats.runnerId}
        where ${runners.userId} = ${userId}
      ) as runner_heartbeats,
      (select count(*)::int from ${agents} where ${agents.userId} = ${userId}) as agents,
      (
        select count(*)::int
        from ${agentUsagePeriods}
        inner join ${agents} on ${agents.id} = ${agentUsagePeriods.agentId}
        where ${agents.userId} = ${userId}
      ) as agent_usage_periods,
      (
        select count(*)::int
        from ${backups}
        inner join ${agents} on ${agents.id} = ${backups.agentId}
        where ${agents.userId} = ${userId}
      ) as backups,
      (
        select count(*)::int
        from ${agentConfigs}
        inner join ${agents} on ${agents.id} = ${agentConfigs.agentId}
        where ${agents.userId} = ${userId}
      ) as agent_configs,
      (
        select count(*)::int
        from ${agentEvents}
        inner join ${agents} on ${agents.id} = ${agentEvents.agentId}
        where ${agents.userId} = ${userId}
      ) as agent_events,
      (
        select count(*)::int
        from ${localRunnerProcesses}
        inner join ${agents} on ${agents.id} = ${localRunnerProcesses.agentId}
        where ${agents.userId} = ${userId}
      ) as local_runner_processes,
      (
        select count(*)::int
        from ${dockerRunnerContainers}
        inner join ${agents} on ${agents.id} = ${dockerRunnerContainers.agentId}
        where ${agents.userId} = ${userId}
      ) as docker_runner_containers,
      (
        select count(*)::int
        from ${agentLogs}
        inner join ${agents} on ${agents.id} = ${agentLogs.agentId}
        where ${agents.userId} = ${userId}
      ) as agent_logs,
      (
        select count(*)::int
        from ${agentApprovals}
        inner join ${agents} on ${agents.id} = ${agentApprovals.agentId}
        where ${agents.userId} = ${userId}
      ) as agent_approvals
  `);

  if (!row) {
    throw new Error("Legacy user count query returned no rows.");
  }

  return {
    users: row.users,
    runners: row.runners,
    runnerProvisioningEvents: row.runner_provisioning_events,
    runnerRegistrationTokens: row.runner_registration_tokens,
    runnerCredentials: row.runner_credentials,
    runnerHeartbeats: row.runner_heartbeats,
    agents: row.agents,
    agentUsagePeriods: row.agent_usage_periods,
    backups: row.backups,
    agentConfigs: row.agent_configs,
    agentEvents: row.agent_events,
    localRunnerProcesses: row.local_runner_processes,
    dockerRunnerContainers: row.docker_runner_containers,
    agentLogs: row.agent_logs,
    agentApprovals: row.agent_approvals,
  };
}
