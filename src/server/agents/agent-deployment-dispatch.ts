import "server-only";

import { Client, Receiver } from "@upstash/qstash";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentDeploymentWakeups, agentDeployments } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { type DeploymentDispatchConfig, readDeploymentDispatchConfig } from "@/src/server/env";

type DeploymentDispatchTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type DeploymentDispatchDatabase =
  | PostgresJsDatabase<typeof schema>
  | DeploymentDispatchTransaction;

export type DeploymentWakeupPayload = {
  deploymentId: string;
  generation: number;
  dueAt: string;
};

type DeploymentWakeupRow = DeploymentWakeupPayload & {
  id: string;
};

type PublishableWakeupRow = DeploymentWakeupRow & {
  publishLeaseOwner: string;
  publishLeaseExpiresAt: Date | string;
};

export type ExhaustedDeploymentWakeupEvidence = {
  wakeupId: string;
  deploymentId: string;
  generation: number;
  dueAt: string;
  state: "exhausted" | "terminal";
  publishAttemptCount: number;
  safeReason: string;
  exhaustedAt: string;
};

type ExhaustedDeploymentWakeupEvidenceRow = Omit<
  ExhaustedDeploymentWakeupEvidence,
  "dueAt" | "exhaustedAt"
> & {
  dueAt: Date | string;
  exhaustedAt: Date | string;
};

export type DeploymentWakeupPublisher = {
  publish(input: {
    payload: DeploymentWakeupPayload;
    dueAt: Date;
    callbackUrl: string;
  }): Promise<{ messageId: string }>;
};

export type DeploymentWakeupDispatchDependencies = {
  createConnection?: () => DatabaseConnection;
  readConfig?: () => DeploymentDispatchConfig;
  publisher?: DeploymentWakeupPublisher;
  now?: () => Date;
  randomUUID?: () => string;
};

const MAX_WAKEUP_BODY_BYTES = 4096;
const PUBLISH_LEASE_MS = 30_000;
const SAFE_PUBLISH_REJECTION_CODE = "publish_rejected";
const SAFE_PUBLISH_AUTHENTICATION_REJECTION_CODE = "publish_authentication_rejected";
const SAFE_PUBLISH_PAYLOAD_REJECTION_CODE = "publish_payload_rejected";
const SAFE_PUBLISH_ATTEMPTS_EXHAUSTED_CODE = "publish_attempts_exhausted";
const SAFE_DELIVERY_REJECTION_CODE = "delivery_rejected";
const WAKEUP_ROUTE_PATH = "/api/internal/agent-deployments/wakeup";
const UPSTASH_SIGNATURE_HEADER = "Upstash-Signature";
const UPSTASH_REGION_HEADER = "Upstash-Region";

export class AgentDeploymentDispatchError extends Error {
  constructor(cause?: unknown) {
    super("Agent deployment dispatch failed.");
    this.name = "AgentDeploymentDispatchError";
    this.cause = cause;
  }
}

export function deploymentWakeupCallbackUrl(
  config: Extract<DeploymentDispatchConfig, { mode: "qstash" }>,
): string {
  return new URL(WAKEUP_ROUTE_PATH, config.callbackBaseUrl).toString();
}

export async function readBoundedDeploymentWakeupBody(
  request: Request,
): Promise<
  { ok: true; body: string } | { ok: false; reason: "body_too_large" | "body_unreadable" }
> {
  const reader = request.body?.getReader();

  if (!reader) {
    return { ok: true, body: "" };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const read = await reader.read();

      if (read.done) break;

      total += read.value.byteLength;
      if (total > MAX_WAKEUP_BODY_BYTES) {
        return { ok: false, reason: "body_too_large" };
      }
      chunks.push(read.value);
    }
  } catch {
    return { ok: false, reason: "body_unreadable" };
  }

  return { ok: true, body: Buffer.concat(chunks).toString("utf8") };
}

export async function verifyDeploymentWakeupSignature(input: {
  body: string;
  signatureHeader: string | null;
  callbackUrl: string;
  upstashRegionHeader?: string | null;
  currentSigningKey: string;
  nextSigningKey: string;
}): Promise<boolean> {
  const signature = input.signatureHeader;

  if (!signature || signature.trim() !== signature || signature.length > 4096) {
    return false;
  }

  try {
    return await new Receiver({
      currentSigningKey: input.currentSigningKey,
      nextSigningKey: input.nextSigningKey,
      devMode: false,
    }).verify({
      signature,
      body: input.body,
      url: input.callbackUrl,
      clockTolerance: 5,
      ...(input.upstashRegionHeader ? { upstashRegion: input.upstashRegionHeader } : {}),
    });
  } catch {
    return false;
  }
}

export function parseDeploymentWakeupPayload(
  body: string,
): { ok: true; payload: DeploymentWakeupPayload } | { ok: false; reason: "payload_invalid" } {
  try {
    const parsed = JSON.parse(body) as unknown;

    if (typeof parsed !== "object" || parsed === null) {
      return { ok: false, reason: "payload_invalid" };
    }

    const deploymentId = "deploymentId" in parsed ? parsed.deploymentId : undefined;
    const generation = "generation" in parsed ? parsed.generation : undefined;
    const dueAt = "dueAt" in parsed ? parsed.dueAt : undefined;

    if (
      typeof deploymentId !== "string" ||
      !isUuid(deploymentId) ||
      typeof generation !== "number" ||
      !Number.isInteger(generation) ||
      generation < 1 ||
      generation > Number.MAX_SAFE_INTEGER ||
      typeof dueAt !== "string" ||
      !isValidIsoTimestamp(dueAt)
    ) {
      return { ok: false, reason: "payload_invalid" };
    }

    return { ok: true, payload: { deploymentId, generation, dueAt } };
  } catch {
    return { ok: false, reason: "payload_invalid" };
  }
}

export async function replaceDeploymentWakeupInTransaction(
  db: DeploymentDispatchTransaction,
  input: {
    deploymentId: string;
    dueAt: Date | null;
    now: Date;
    safeErrorCode?: string | null;
  },
): Promise<DeploymentWakeupPayload | null> {
  assertTransactionHandle(db);

  if (!isUuid(input.deploymentId) || Number.isNaN(input.now.getTime())) {
    throw new AgentDeploymentDispatchError(new Error("Invalid deployment wakeup input."));
  }

  const nowIso = input.now.toISOString();

  if (input.dueAt === null) {
    await db.execute(sql`
      update ${agentDeploymentWakeups}
      set state = 'terminal',
          publish_lease_owner = null,
          publish_lease_expires_at = null,
          updated_at = ${nowIso}
      where ${agentDeploymentWakeups.deploymentId} = ${input.deploymentId}
        and ${agentDeploymentWakeups.state} in ('pending', 'publishing', 'published', 'failed')
    `);
    return null;
  }

  if (Number.isNaN(input.dueAt.getTime())) {
    throw new AgentDeploymentDispatchError(new Error("Invalid deployment wakeup due time."));
  }

  const dueAtIso = input.dueAt.toISOString();
  const safeErrorCode =
    input.safeErrorCode && /^[a-z0-9_.:-]{1,64}$/.test(input.safeErrorCode)
      ? input.safeErrorCode
      : null;

  const [inserted] = await db.execute<DeploymentWakeupRow>(sql`
    with locked_deployment as (
      select ${agentDeployments.id} as id
      from ${agentDeployments}
      where ${agentDeployments.id} = ${input.deploymentId}
      for update
    ), terminalized as (
      update ${agentDeploymentWakeups}
      set state = 'terminal',
          publish_lease_owner = null,
          publish_lease_expires_at = null,
          updated_at = ${nowIso}
      where ${agentDeploymentWakeups.deploymentId} = ${input.deploymentId}
        and ${agentDeploymentWakeups.state} in ('pending', 'publishing', 'published', 'failed')
      returning 1
    ), next_generation as (
      select coalesce(max(${agentDeploymentWakeups.generation}), 0) + 1 as generation
      from ${agentDeploymentWakeups}
      where ${agentDeploymentWakeups.deploymentId} = ${input.deploymentId}
    )
    insert into ${agentDeploymentWakeups} (
      deployment_id,
      generation,
      due_at,
      state,
      safe_error_code,
      created_at,
      updated_at
    )
    select
      locked_deployment.id,
      next_generation.generation,
      ${dueAtIso},
      'pending',
      ${safeErrorCode},
      ${nowIso},
      ${nowIso}
    from locked_deployment, next_generation
    where not exists (
      select 1
      from ${agentDeploymentWakeups}
      where ${agentDeploymentWakeups.deploymentId} = locked_deployment.id
        and ${agentDeploymentWakeups.state} = 'exhausted'
    )
    returning
      id,
      deployment_id as "deploymentId",
      generation,
      due_at as "dueAt"
  `);

  return inserted
    ? {
        deploymentId: inserted.deploymentId,
        generation: inserted.generation,
        dueAt: toIso(inserted.dueAt),
      }
    : null;
}

export async function publishDeploymentWakeupAfterCommit(
  payload: DeploymentWakeupPayload,
  dependencies: DeploymentWakeupDispatchDependencies = {},
): Promise<"published" | "cron_mode" | "unavailable"> {
  const config = (dependencies.readConfig ?? readDeploymentDispatchConfig)();
  if (!config.ok) return "unavailable";
  if (config.mode === "cron") return "cron_mode";

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const leaseOwner = `publish:${dependencies.randomUUID?.() ?? randomUUID()}`;
  const publisher =
    dependencies.publisher ?? createQstashDeploymentWakeupPublisher({ token: config.token });

  try {
    const claimed = await connection.db.transaction((tx) =>
      claimDeploymentWakeupForPublish(tx, {
        payload,
        leaseOwner,
        now,
        maxPublishAttempts: config.maxPublishAttempts,
      }),
    );

    if (!claimed) return "unavailable";

    try {
      const published = await publisher.publish({
        payload,
        dueAt: new Date(payload.dueAt),
        callbackUrl: deploymentWakeupCallbackUrl(config),
      });
      await connection.db.transaction(async (tx) => {
        await lockDeploymentForWakeupCompletion(tx, claimed);
        await markDeploymentWakeupPublished(tx, {
          wakeupId: claimed.id,
          leaseOwner,
          messageId: published.messageId,
          now: dependencies.now?.() ?? new Date(),
        });
      });
      return "published";
    } catch (error) {
      const failure = classifyDeploymentWakeupPublishFailure(error);
      await connection.db.transaction(async (tx) => {
        await lockDeploymentForWakeupCompletion(tx, claimed);
        await markDeploymentWakeupPublishFailed(tx, {
          wakeupId: claimed.id,
          leaseOwner,
          now: dependencies.now?.() ?? new Date(),
          safeErrorCode: failure.safeErrorCode,
          exhaustImmediately: failure.exhaustImmediately,
          maxPublishAttempts: config.maxPublishAttempts,
        });
      });
      return "unavailable";
    }
  } catch (error) {
    throw new AgentDeploymentDispatchError(error);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function publishLatestDeploymentWakeupAfterCommit(
  deploymentId: string,
  dependencies: DeploymentWakeupDispatchDependencies = {},
): Promise<"published" | "cron_mode" | "unavailable"> {
  if (!isUuid(deploymentId)) return "unavailable";

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [latest] = await connection.db.execute<DeploymentWakeupPayload>(sql`
      select
        deployment_id as "deploymentId",
        generation,
        due_at as "dueAt"
      from ${agentDeploymentWakeups}
      where ${agentDeploymentWakeups.deploymentId} = ${deploymentId}
        and ${agentDeploymentWakeups.state} in ('pending', 'failed')
      order by ${agentDeploymentWakeups.generation} desc
      limit 1
    `);

    if (!latest) return "unavailable";
    return await publishDeploymentWakeupAfterCommit(
      {
        deploymentId: latest.deploymentId,
        generation: latest.generation,
        dueAt: toIso(latest.dueAt),
      },
      dependencies,
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function sweepDeploymentWakeupOutbox(
  dependencies: DeploymentWakeupDispatchDependencies = {},
): Promise<{ published: number }> {
  const config = (dependencies.readConfig ?? readDeploymentDispatchConfig)();
  if (!config.ok || config.mode === "cron") {
    return { published: 0 };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const leaseOwner = `publish:${dependencies.randomUUID?.() ?? randomUUID()}`;
  const publisher =
    dependencies.publisher ?? createQstashDeploymentWakeupPublisher({ token: config.token });

  try {
    const claimed = await connection.db.transaction((tx) =>
      claimNextDeploymentWakeupForPublish(tx, {
        leaseOwner,
        now,
        maxPublishAttempts: config.maxPublishAttempts,
      }),
    );
    if (!claimed) return { published: 0 };

    try {
      const published = await publisher.publish({
        payload: {
          deploymentId: claimed.deploymentId,
          generation: claimed.generation,
          dueAt: claimed.dueAt,
        },
        dueAt: new Date(claimed.dueAt),
        callbackUrl: deploymentWakeupCallbackUrl(config),
      });
      await connection.db.transaction(async (tx) => {
        await lockDeploymentForWakeupCompletion(tx, claimed);
        await markDeploymentWakeupPublished(tx, {
          wakeupId: claimed.id,
          leaseOwner,
          messageId: published.messageId,
          now: dependencies.now?.() ?? new Date(),
        });
      });
      return { published: 1 };
    } catch (error) {
      const failure = classifyDeploymentWakeupPublishFailure(error);
      await connection.db.transaction(async (tx) => {
        await lockDeploymentForWakeupCompletion(tx, claimed);
        await markDeploymentWakeupPublishFailed(tx, {
          wakeupId: claimed.id,
          leaseOwner,
          now: dependencies.now?.() ?? new Date(),
          safeErrorCode: failure.safeErrorCode,
          exhaustImmediately: failure.exhaustImmediately,
          maxPublishAttempts: config.maxPublishAttempts,
        });
      });
      return { published: 0 };
    }
  } catch (error) {
    throw new AgentDeploymentDispatchError(error);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function claimDeploymentWakeupDelivery(
  db: DeploymentDispatchDatabase,
  input: {
    payload: DeploymentWakeupPayload;
    now: Date;
  },
): Promise<
  | { ok: true; deploymentId: string }
  | { ok: false; reason: "early" | "stale" | "already_claimed" | "terminal" }
> {
  if (new Date(input.payload.dueAt).getTime() > input.now.getTime()) {
    return { ok: false, reason: "early" };
  }

  const nowIso = input.now.toISOString();
  const [claimed] = await db.execute<{ deploymentId: string }>(sql`
    with latest_generation as (
      select max(${agentDeploymentWakeups.generation}) as generation
      from ${agentDeploymentWakeups}
      where ${agentDeploymentWakeups.deploymentId} = ${input.payload.deploymentId}
    ), claimed_wakeup as (
      update ${agentDeploymentWakeups}
      set state = 'claimed',
          claimed_at = ${nowIso},
          publish_lease_owner = null,
          publish_lease_expires_at = null,
          updated_at = ${nowIso}
      where ${agentDeploymentWakeups.deploymentId} = ${input.payload.deploymentId}
        and ${agentDeploymentWakeups.generation} = ${input.payload.generation}
        and ${agentDeploymentWakeups.dueAt} = ${input.payload.dueAt}
        and ${agentDeploymentWakeups.state} in ('pending', 'published', 'failed')
        and ${agentDeploymentWakeups.dueAt} <= ${nowIso}
        and ${agentDeploymentWakeups.generation} = (select generation from latest_generation)
      returning ${agentDeploymentWakeups.deploymentId} as "deploymentId"
    )
    select claimed_wakeup."deploymentId"
    from claimed_wakeup
    inner join ${agentDeployments}
      on ${agentDeployments.id} = claimed_wakeup."deploymentId"
    where ${agentDeployments.stage} not in ('ready', 'failed')
  `);

  if (claimed) {
    return { ok: true, deploymentId: claimed.deploymentId };
  }

  const [current] = await db.execute<{
    state: string;
    generation: number;
    stage: string | null;
  }>(sql`
    select
      ${agentDeploymentWakeups.state} as state,
      ${agentDeploymentWakeups.generation} as generation,
      ${agentDeployments.stage} as stage
    from ${agentDeploymentWakeups}
    left join ${agentDeployments}
      on ${agentDeployments.id} = ${agentDeploymentWakeups.deploymentId}
    where ${agentDeploymentWakeups.deploymentId} = ${input.payload.deploymentId}
      and ${agentDeploymentWakeups.generation} = ${input.payload.generation}
    limit 1
  `);

  if (!current) return { ok: false, reason: "stale" };
  if (
    current.stage === "ready" ||
    current.stage === "failed" ||
    current.state === "terminal" ||
    current.state === "exhausted"
  ) {
    return { ok: false, reason: "terminal" };
  }
  if (current.state === "claimed") return { ok: false, reason: "already_claimed" };
  return { ok: false, reason: "stale" };
}

export async function listExhaustedDeploymentWakeups(
  db: DeploymentDispatchDatabase,
  input: { limit?: number } = {},
): Promise<ExhaustedDeploymentWakeupEvidence[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new AgentDeploymentDispatchError(new Error("Invalid exhausted wakeup list limit."));
  }

  const rows = await db.execute<ExhaustedDeploymentWakeupEvidenceRow>(sql`
    select
      ${agentDeploymentWakeups.id} as "wakeupId",
      ${agentDeploymentWakeups.deploymentId} as "deploymentId",
      ${agentDeploymentWakeups.generation} as generation,
      ${agentDeploymentWakeups.dueAt} as "dueAt",
      ${agentDeploymentWakeups.state} as state,
      ${agentDeploymentWakeups.publishAttemptCount} as "publishAttemptCount",
      ${agentDeploymentWakeups.safeErrorCode} as "safeReason",
      ${agentDeploymentWakeups.exhaustedAt} as "exhaustedAt"
    from ${agentDeploymentWakeups}
    where ${agentDeploymentWakeups.exhaustedAt} is not null
    order by ${agentDeploymentWakeups.exhaustedAt} desc,
      ${agentDeploymentWakeups.deploymentId},
      ${agentDeploymentWakeups.generation} desc
    limit ${limit}
  `);

  return rows.map(toExhaustedDeploymentWakeupEvidence);
}

export async function inspectExhaustedDeploymentWakeup(
  db: DeploymentDispatchDatabase,
  wakeupId: string,
): Promise<ExhaustedDeploymentWakeupEvidence | null> {
  if (!isUuid(wakeupId)) return null;

  const [row] = await db.execute<ExhaustedDeploymentWakeupEvidenceRow>(sql`
    select
      ${agentDeploymentWakeups.id} as "wakeupId",
      ${agentDeploymentWakeups.deploymentId} as "deploymentId",
      ${agentDeploymentWakeups.generation} as generation,
      ${agentDeploymentWakeups.dueAt} as "dueAt",
      ${agentDeploymentWakeups.state} as state,
      ${agentDeploymentWakeups.publishAttemptCount} as "publishAttemptCount",
      ${agentDeploymentWakeups.safeErrorCode} as "safeReason",
      ${agentDeploymentWakeups.exhaustedAt} as "exhaustedAt"
    from ${agentDeploymentWakeups}
    where ${agentDeploymentWakeups.id} = ${wakeupId}
      and ${agentDeploymentWakeups.exhaustedAt} is not null
    limit 1
  `);

  return row ? toExhaustedDeploymentWakeupEvidence(row) : null;
}

export async function replayExhaustedDeploymentWakeupInTransaction(
  db: DeploymentDispatchTransaction,
  input: { wakeupId: string; now: Date },
): Promise<
  | { ok: true; exhaustedWakeupId: string; wakeup: DeploymentWakeupPayload }
  | {
      ok: false;
      reason: "not_found" | "not_exhausted" | "deployment_terminal" | "superseded";
    }
> {
  assertTransactionHandle(db);
  if (!isUuid(input.wakeupId) || Number.isNaN(input.now.getTime())) {
    return { ok: false, reason: "not_found" };
  }

  const [locked] = await db.execute<{
    deploymentId: string;
    generation: number;
    maxGeneration: number;
    state: string;
    stage: string;
  }>(sql`
    select
      ${agentDeploymentWakeups.deploymentId} as "deploymentId",
      ${agentDeploymentWakeups.generation} as generation,
      (
        select max(candidate.generation)
        from agent_deployment_wakeups candidate
        where candidate.deployment_id = ${agentDeploymentWakeups.deploymentId}
      ) as "maxGeneration",
      ${agentDeploymentWakeups.state} as state,
      ${agentDeployments.stage} as stage
    from ${agentDeploymentWakeups}
    inner join ${agentDeployments}
      on ${agentDeployments.id} = ${agentDeploymentWakeups.deploymentId}
    where ${agentDeploymentWakeups.id} = ${input.wakeupId}
    for update of ${agentDeploymentWakeups}, ${agentDeployments}
  `);

  if (!locked) return { ok: false, reason: "not_found" };
  if (locked.state !== "exhausted") return { ok: false, reason: "not_exhausted" };
  if (locked.stage === "ready" || locked.stage === "failed") {
    return { ok: false, reason: "deployment_terminal" };
  }
  if (locked.generation !== locked.maxGeneration) {
    return { ok: false, reason: "superseded" };
  }

  const nowIso = input.now.toISOString();
  const [terminalized] = await db.execute<{ id: string }>(sql`
    update ${agentDeploymentWakeups}
    set state = 'terminal',
        updated_at = ${nowIso}
    where ${agentDeploymentWakeups.id} = ${input.wakeupId}
      and ${agentDeploymentWakeups.state} = 'exhausted'
    returning ${agentDeploymentWakeups.id} as id
  `);
  if (!terminalized) return { ok: false, reason: "not_exhausted" };

  const [inserted] = await db.execute<DeploymentWakeupRow>(sql`
    insert into ${agentDeploymentWakeups} (
      deployment_id,
      generation,
      due_at,
      state,
      created_at,
      updated_at
    ) values (
      ${locked.deploymentId},
      ${locked.generation + 1},
      ${nowIso},
      'pending',
      ${nowIso},
      ${nowIso}
    )
    returning
      id,
      deployment_id as "deploymentId",
      generation,
      due_at as "dueAt"
  `);
  if (!inserted) {
    throw new AgentDeploymentDispatchError(new Error("Wakeup replay insert returned no row."));
  }

  return {
    ok: true,
    exhaustedWakeupId: terminalized.id,
    wakeup: {
      deploymentId: inserted.deploymentId,
      generation: inserted.generation,
      dueAt: toIso(inserted.dueAt),
    },
  };
}

export function createQstashDeploymentWakeupPublisher(input: {
  token: string;
}): DeploymentWakeupPublisher {
  const client = new Client({ token: input.token, devMode: false });

  return {
    async publish({ payload, dueAt, callbackUrl }) {
      const notBefore = Math.max(Math.floor(dueAt.getTime() / 1000), Math.floor(Date.now() / 1000));
      const published = await client.publishJSON({
        url: callbackUrl,
        body: payload,
        method: "POST",
        notBefore,
        retries: 3,
        deduplicationId: `${payload.deploymentId}:${payload.generation}`,
        redact: { body: true, header: true },
      });

      return { messageId: published.messageId };
    },
  };
}

async function claimDeploymentWakeupForPublish(
  db: DeploymentDispatchDatabase,
  input: {
    payload: DeploymentWakeupPayload;
    leaseOwner: string;
    now: Date;
    maxPublishAttempts: number;
  },
): Promise<PublishableWakeupRow | null> {
  const leaseExpiresAt = new Date(input.now.getTime() + PUBLISH_LEASE_MS).toISOString();
  const nowIso = input.now.toISOString();
  const [claimed] = await db.execute<PublishableWakeupRow>(sql`
    with exhausted_at_bound as (
      update ${agentDeploymentWakeups}
      set state = 'exhausted',
          safe_error_code = ${SAFE_PUBLISH_ATTEMPTS_EXHAUSTED_CODE},
          exhausted_at = ${nowIso},
          publish_lease_owner = null,
          publish_lease_expires_at = null,
          updated_at = ${nowIso}
      where ${agentDeploymentWakeups.deploymentId} = ${input.payload.deploymentId}
        and ${agentDeploymentWakeups.generation} = ${input.payload.generation}
        and ${agentDeploymentWakeups.dueAt} = ${input.payload.dueAt}
        and ${agentDeploymentWakeups.state} in ('pending', 'failed')
        and ${agentDeploymentWakeups.publishAttemptCount} >= ${input.maxPublishAttempts}
      returning ${agentDeploymentWakeups.id}
    )
    update ${agentDeploymentWakeups}
    set state = 'publishing',
        publish_attempt_count = ${agentDeploymentWakeups.publishAttemptCount} + 1,
        publish_lease_owner = ${input.leaseOwner},
        publish_lease_expires_at = ${leaseExpiresAt},
        safe_error_code = null,
        updated_at = ${nowIso}
    where ${agentDeploymentWakeups.deploymentId} = ${input.payload.deploymentId}
      and ${agentDeploymentWakeups.generation} = ${input.payload.generation}
      and ${agentDeploymentWakeups.dueAt} = ${input.payload.dueAt}
      and ${agentDeploymentWakeups.state} in ('pending', 'failed')
      and ${agentDeploymentWakeups.publishAttemptCount} < ${input.maxPublishAttempts}
    returning
      id,
      deployment_id as "deploymentId",
      generation,
      due_at as "dueAt",
      publish_lease_owner as "publishLeaseOwner",
      publish_lease_expires_at as "publishLeaseExpiresAt"
  `);

  return claimed
    ? {
        ...claimed,
        dueAt: toIso(claimed.dueAt),
      }
    : null;
}

async function claimNextDeploymentWakeupForPublish(
  db: DeploymentDispatchDatabase,
  input: {
    leaseOwner: string;
    now: Date;
    maxPublishAttempts: number;
  },
): Promise<PublishableWakeupRow | null> {
  const leaseExpiresAt = new Date(input.now.getTime() + PUBLISH_LEASE_MS).toISOString();
  const nowIso = input.now.toISOString();
  const [claimed] = await db.execute<PublishableWakeupRow>(sql`
    with exhausted_at_bound as (
      update ${agentDeploymentWakeups}
      set state = 'exhausted',
          safe_error_code = ${SAFE_PUBLISH_ATTEMPTS_EXHAUSTED_CODE},
          exhausted_at = ${nowIso},
          publish_lease_owner = null,
          publish_lease_expires_at = null,
          updated_at = ${nowIso}
      where ${agentDeploymentWakeups.publishAttemptCount} >= ${input.maxPublishAttempts}
        and (
          ${agentDeploymentWakeups.state} in ('pending', 'failed')
          or (
            ${agentDeploymentWakeups.state} = 'publishing'
            and ${agentDeploymentWakeups.publishLeaseExpiresAt} <= ${nowIso}
          )
        )
      returning ${agentDeploymentWakeups.id}
    ), next_wakeup as (
      select ${agentDeploymentWakeups.id} as id
      from ${agentDeploymentWakeups}
      where (
          ${agentDeploymentWakeups.state} in ('pending', 'failed')
          or (
            ${agentDeploymentWakeups.state} = 'publishing'
            and ${agentDeploymentWakeups.publishLeaseExpiresAt} <= ${nowIso}
          )
        )
        and ${agentDeploymentWakeups.publishAttemptCount} < ${input.maxPublishAttempts}
      order by ${agentDeploymentWakeups.dueAt}, ${agentDeploymentWakeups.updatedAt}, ${agentDeploymentWakeups.id}
      for update skip locked
      limit 1
    )
    update ${agentDeploymentWakeups}
    set state = 'publishing',
        publish_attempt_count = ${agentDeploymentWakeups.publishAttemptCount} + 1,
        publish_lease_owner = ${input.leaseOwner},
        publish_lease_expires_at = ${leaseExpiresAt},
        safe_error_code = null,
        updated_at = ${nowIso}
    where ${agentDeploymentWakeups.id} = (select id from next_wakeup)
    returning
      id,
      deployment_id as "deploymentId",
      generation,
      due_at as "dueAt",
      publish_lease_owner as "publishLeaseOwner",
      publish_lease_expires_at as "publishLeaseExpiresAt"
  `);

  return claimed
    ? {
        ...claimed,
        dueAt: toIso(claimed.dueAt),
      }
    : null;
}

async function markDeploymentWakeupPublished(
  db: DeploymentDispatchDatabase,
  input: {
    wakeupId: string;
    leaseOwner: string;
    messageId: string;
    now: Date;
  },
): Promise<void> {
  await db.execute(sql`
    update ${agentDeploymentWakeups}
    set state = 'published',
        provider_message_id = ${input.messageId},
        published_at = ${input.now.toISOString()},
        publish_lease_owner = null,
        publish_lease_expires_at = null,
        updated_at = ${input.now.toISOString()}
    where ${agentDeploymentWakeups.id} = ${input.wakeupId}
      and ${agentDeploymentWakeups.publishLeaseOwner} = ${input.leaseOwner}
      and ${agentDeploymentWakeups.state} = 'publishing'
  `);
}

async function lockDeploymentForWakeupCompletion(
  db: DeploymentDispatchTransaction,
  wakeup: Pick<DeploymentWakeupRow, "id" | "deploymentId">,
): Promise<void> {
  await db.execute(sql`
    select ${agentDeployments.id}
    from ${agentDeployments}
    inner join ${agentDeploymentWakeups}
      on ${agentDeploymentWakeups.deploymentId} = ${agentDeployments.id}
    where ${agentDeploymentWakeups.id} = ${wakeup.id}
      and ${agentDeployments.id} = ${wakeup.deploymentId}
    for update of ${agentDeployments}
  `);
}

async function markDeploymentWakeupPublishFailed(
  db: DeploymentDispatchDatabase,
  input: {
    wakeupId: string;
    leaseOwner: string;
    now: Date;
    safeErrorCode: string;
    exhaustImmediately: boolean;
    maxPublishAttempts: number;
  },
): Promise<void> {
  const nowIso = input.now.toISOString();
  await db.execute(sql`
    update ${agentDeploymentWakeups}
    set state = case
          when ${input.exhaustImmediately}
            or ${agentDeploymentWakeups.publishAttemptCount} >= ${input.maxPublishAttempts}
            then 'exhausted'::agent_deployment_wakeup_state
          else 'failed'::agent_deployment_wakeup_state
        end,
        safe_error_code = case
          when not ${input.exhaustImmediately}
            and ${agentDeploymentWakeups.publishAttemptCount} >= ${input.maxPublishAttempts}
            then ${SAFE_PUBLISH_ATTEMPTS_EXHAUSTED_CODE}
          else ${input.safeErrorCode}
        end,
        exhausted_at = case
          when ${input.exhaustImmediately}
            or ${agentDeploymentWakeups.publishAttemptCount} >= ${input.maxPublishAttempts}
            then ${nowIso}::timestamptz
          else null
        end,
        publish_lease_owner = null,
        publish_lease_expires_at = null,
        updated_at = ${nowIso}
    where ${agentDeploymentWakeups.id} = ${input.wakeupId}
      and ${agentDeploymentWakeups.publishLeaseOwner} = ${input.leaseOwner}
      and ${agentDeploymentWakeups.state} = 'publishing'
  `);
}

function classifyDeploymentWakeupPublishFailure(error: unknown): {
  safeErrorCode: string;
  exhaustImmediately: boolean;
} {
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
      ? error.status
      : null;

  if (status === 401 || status === 403) {
    return {
      safeErrorCode: SAFE_PUBLISH_AUTHENTICATION_REJECTION_CODE,
      exhaustImmediately: true,
    };
  }
  if (status === 400 || status === 413 || status === 422) {
    return { safeErrorCode: SAFE_PUBLISH_PAYLOAD_REJECTION_CODE, exhaustImmediately: true };
  }

  return { safeErrorCode: SAFE_PUBLISH_REJECTION_CODE, exhaustImmediately: false };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isValidIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toExhaustedDeploymentWakeupEvidence(
  row: ExhaustedDeploymentWakeupEvidenceRow,
): ExhaustedDeploymentWakeupEvidence {
  return {
    ...row,
    dueAt: toIso(row.dueAt),
    exhaustedAt: toIso(row.exhaustedAt),
  };
}

export const deploymentWakeupSafeCodes = {
  publishRejected: SAFE_PUBLISH_REJECTION_CODE,
  publishAuthenticationRejected: SAFE_PUBLISH_AUTHENTICATION_REJECTION_CODE,
  publishPayloadRejected: SAFE_PUBLISH_PAYLOAD_REJECTION_CODE,
  publishAttemptsExhausted: SAFE_PUBLISH_ATTEMPTS_EXHAUSTED_CODE,
  deliveryRejected: SAFE_DELIVERY_REJECTION_CODE,
  signatureHeader: UPSTASH_SIGNATURE_HEADER,
  regionHeader: UPSTASH_REGION_HEADER,
} as const;

export function assertTransactionHandle(db: DeploymentDispatchTransaction): void {
  const runtime = db as object;
  if ("$client" in runtime && !("nestedIndex" in runtime)) {
    throw new AgentDeploymentDispatchError(
      new Error("Deployment wakeup writes require an owning transaction."),
    );
  }
}
