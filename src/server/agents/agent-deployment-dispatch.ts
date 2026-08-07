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
      }),
    );

    if (!claimed) return "unavailable";

    try {
      const published = await publisher.publish({
        payload,
        dueAt: new Date(payload.dueAt),
        callbackUrl: deploymentWakeupCallbackUrl(config),
      });
      await markDeploymentWakeupPublished(connection.db, {
        wakeupId: claimed.id,
        leaseOwner,
        messageId: published.messageId,
        now: dependencies.now?.() ?? new Date(),
      });
      return "published";
    } catch {
      await markDeploymentWakeupPublishFailed(connection.db, {
        wakeupId: claimed.id,
        leaseOwner,
        now: dependencies.now?.() ?? new Date(),
        safeErrorCode: SAFE_PUBLISH_REJECTION_CODE,
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
      claimNextDeploymentWakeupForPublish(tx, { leaseOwner, now }),
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
      await markDeploymentWakeupPublished(connection.db, {
        wakeupId: claimed.id,
        leaseOwner,
        messageId: published.messageId,
        now: dependencies.now?.() ?? new Date(),
      });
      return { published: 1 };
    } catch {
      await markDeploymentWakeupPublishFailed(connection.db, {
        wakeupId: claimed.id,
        leaseOwner,
        now: dependencies.now?.() ?? new Date(),
        safeErrorCode: SAFE_PUBLISH_REJECTION_CODE,
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
  if (current.stage === "ready" || current.stage === "failed" || current.state === "terminal") {
    return { ok: false, reason: "terminal" };
  }
  if (current.state === "claimed") return { ok: false, reason: "already_claimed" };
  return { ok: false, reason: "stale" };
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
  },
): Promise<PublishableWakeupRow | null> {
  const leaseExpiresAt = new Date(input.now.getTime() + PUBLISH_LEASE_MS).toISOString();
  const nowIso = input.now.toISOString();
  const [claimed] = await db.execute<PublishableWakeupRow>(sql`
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
  },
): Promise<PublishableWakeupRow | null> {
  const leaseExpiresAt = new Date(input.now.getTime() + PUBLISH_LEASE_MS).toISOString();
  const nowIso = input.now.toISOString();
  const [claimed] = await db.execute<PublishableWakeupRow>(sql`
    with next_wakeup as (
      select ${agentDeploymentWakeups.id} as id
      from ${agentDeploymentWakeups}
      where (
          ${agentDeploymentWakeups.state} in ('pending', 'failed')
          or (
            ${agentDeploymentWakeups.state} = 'publishing'
            and ${agentDeploymentWakeups.publishLeaseExpiresAt} <= ${nowIso}
          )
        )
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

async function markDeploymentWakeupPublishFailed(
  db: DeploymentDispatchDatabase,
  input: {
    wakeupId: string;
    leaseOwner: string;
    now: Date;
    safeErrorCode: string;
  },
): Promise<void> {
  await db.execute(sql`
    update ${agentDeploymentWakeups}
    set state = 'failed',
        safe_error_code = ${input.safeErrorCode},
        publish_lease_owner = null,
        publish_lease_expires_at = null,
        updated_at = ${input.now.toISOString()}
    where ${agentDeploymentWakeups.id} = ${input.wakeupId}
      and ${agentDeploymentWakeups.publishLeaseOwner} = ${input.leaseOwner}
      and ${agentDeploymentWakeups.state} = 'publishing'
  `);
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

export const deploymentWakeupSafeCodes = {
  publishRejected: SAFE_PUBLISH_REJECTION_CODE,
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
