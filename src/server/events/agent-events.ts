import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { agentEvents, agents } from "@/src/server/db/schema";

const DEFAULT_EVENT_FEED_LIMIT = 20;
const MAX_EVENT_FEED_LIMIT = 100;
const EVENT_FEED_CURSOR_VERSION = 1;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_AGENT_EVENT_ACTOR_DISPLAY_NAME = "Local development user";

export type AgentEventMetadata = Record<string, unknown>;

export type AgentEventWrite = {
  agentId: string;
  actorUserId: string;
  type: string;
  message: string;
  metadata?: AgentEventMetadata;
};

export type AgentEventTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type AgentEventCursor = {
  createdAt: Date;
  id: string;
};

export type EventCursorDecodeFailureReason =
  | "empty_cursor"
  | "invalid_encoding"
  | "invalid_json"
  | "invalid_shape"
  | "unsupported_version"
  | "invalid_created_at"
  | "invalid_id";

export class MalformedEventCursorError extends Error {
  readonly reason: EventCursorDecodeFailureReason;

  constructor(reason: EventCursorDecodeFailureReason) {
    super("Malformed event feed cursor.");
    this.name = "MalformedEventCursorError";
    this.reason = reason;
  }
}

export type DecodeEventFeedCursorResult =
  | {
      ok: true;
      cursor: AgentEventCursor;
    }
  | {
      ok: false;
      error: MalformedEventCursorError;
    };

export type AgentEventActorDto = {
  userId: string;
  displayName: string;
};

export type AgentEventAgentContextDto = {
  id: string;
  name: string;
  templateKey: string;
  status: string;
  deletedAt: string | null;
};

export type AgentEventDto = {
  id: string;
  agentId: string;
  actor: AgentEventActorDto;
  type: string;
  message: string;
  metadata: AgentEventMetadata;
  metadataSummary: string | null;
  createdAt: string;
  agent?: AgentEventAgentContextDto;
};

export type AgentEventFeedPage = {
  events: AgentEventDto[];
  nextCursor: string | null;
};

export type AgentEventFeedQueryResult =
  | {
      ok: true;
      page: AgentEventFeedPage;
    }
  | {
      ok: false;
      error: MalformedEventCursorError;
    };

export type AgentEventQueryExecutor = Pick<PostgresJsDatabase<typeof schema>, "select">;
type AgentEventRow = typeof agentEvents.$inferSelect;
type AgentContextRow = Pick<
  typeof agents.$inferSelect,
  "id" | "name" | "templateKey" | "status" | "deletedAt"
>;

type CursorPayload = {
  v: typeof EVENT_FEED_CURSOR_VERSION;
  createdAt: string;
  id: string;
};

const eventSelection = {
  id: agentEvents.id,
  agentId: agentEvents.agentId,
  actorUserId: agentEvents.actorUserId,
  type: agentEvents.type,
  message: agentEvents.message,
  metadata: agentEvents.metadata,
  createdAt: agentEvents.createdAt,
};

export async function recordAgentEventInTransaction(
  tx: AgentEventTransaction,
  event: AgentEventWrite,
): Promise<void> {
  await recordAgentEventsInTransaction(tx, [event]);
}

export async function recordAgentEventsInTransaction(
  tx: AgentEventTransaction,
  events: readonly AgentEventWrite[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }

  await tx.insert(agentEvents).values(
    events.map((event) => ({
      agentId: event.agentId,
      actorUserId: event.actorUserId,
      type: event.type,
      message: event.message,
      metadata: event.metadata ?? {},
    })),
  );
}

export function encodeEventFeedCursor(cursor: { createdAt: Date | string; id: string }): string {
  const createdAt =
    cursor.createdAt instanceof Date ? cursor.createdAt.toISOString() : cursor.createdAt;
  const payload: CursorPayload = {
    v: EVENT_FEED_CURSOR_VERSION,
    createdAt,
    id: cursor.id,
  };

  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeEventFeedCursor(cursor: string): DecodeEventFeedCursorResult {
  if (cursor.length === 0) {
    return malformedCursor("empty_cursor");
  }

  if (!BASE64URL_PATTERN.test(cursor)) {
    return malformedCursor("invalid_encoding");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return malformedCursor("invalid_json");
  }

  if (!isPlainObject(parsed)) {
    return malformedCursor("invalid_shape");
  }

  if (parsed.v !== EVENT_FEED_CURSOR_VERSION) {
    return malformedCursor("unsupported_version");
  }

  if (typeof parsed.createdAt !== "string") {
    return malformedCursor("invalid_shape");
  }

  const createdAt = new Date(parsed.createdAt);

  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed.createdAt) {
    return malformedCursor("invalid_created_at");
  }

  if (typeof parsed.id !== "string") {
    return malformedCursor("invalid_shape");
  }

  if (!UUID_PATTERN.test(parsed.id)) {
    return malformedCursor("invalid_id");
  }

  return {
    ok: true,
    cursor: {
      createdAt,
      id: parsed.id,
    },
  };
}

export function getAgentEventActorDisplayName(displayName?: string | null): string {
  const normalizedDisplayName = displayName?.trim();

  return normalizedDisplayName || DEFAULT_AGENT_EVENT_ACTOR_DISPLAY_NAME;
}

export function summarizeAgentEventMetadata(metadata: AgentEventMetadata): string | null {
  const parts: string[] = [];
  const summarizedKeys = new Set<string>();
  const fromStatus = metadata.fromStatus;
  const toStatus = metadata.toStatus;

  if (isDisplayScalar(fromStatus) && isDisplayScalar(toStatus)) {
    parts.push(`${String(fromStatus)} -> ${String(toStatus)}`);
    summarizedKeys.add("fromStatus");
    summarizedKeys.add("toStatus");
  }

  if (isDisplayScalar(metadata.templateKey)) {
    parts.push(`Template: ${String(metadata.templateKey)}`);
    summarizedKeys.add("templateKey");
  }

  if (isDisplayScalar(metadata.status)) {
    parts.push(`Status: ${String(metadata.status)}`);
    summarizedKeys.add("status");
  }

  if (isDisplayScalar(metadata.deletedAt)) {
    parts.push(`Deleted at: ${String(metadata.deletedAt)}`);
    summarizedKeys.add("deletedAt");
  }

  for (const key of Object.keys(metadata).sort()) {
    if (summarizedKeys.has(key)) {
      continue;
    }

    const value = metadata[key];

    if (isDisplayScalar(value)) {
      parts.push(`${humanizeMetadataKey(key)}: ${String(value)}`);
    }
  }

  return parts.length > 0 ? parts.join("; ") : null;
}

export function mapAgentEventToDto(
  event: AgentEventRow,
  options: {
    agent?: AgentContextRow;
    actorDisplayName?: string | null;
  } = {},
): AgentEventDto {
  const dto: AgentEventDto = {
    id: event.id,
    agentId: event.agentId,
    actor: {
      userId: event.actorUserId,
      displayName: getAgentEventActorDisplayName(options.actorDisplayName),
    },
    type: event.type,
    message: event.message,
    metadata: event.metadata,
    metadataSummary: summarizeAgentEventMetadata(event.metadata),
    createdAt: event.createdAt.toISOString(),
  };

  if (options.agent) {
    dto.agent = {
      id: options.agent.id,
      name: options.agent.name,
      templateKey: options.agent.templateKey,
      status: options.agent.status,
      deletedAt: options.agent.deletedAt?.toISOString() ?? null,
    };
  }

  return dto;
}

export async function listAgentEventFeed(input: {
  db: AgentEventQueryExecutor;
  agentId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<AgentEventFeedQueryResult> {
  const cursor = decodeOptionalEventCursor(input.cursor);

  if (!cursor.ok) {
    return cursor;
  }

  const limit = normalizeEventFeedLimit(input.limit);
  const predicates = [eq(agentEvents.agentId, input.agentId)];

  if (cursor.cursor) {
    predicates.push(eventCursorPredicate(cursor.cursor));
  }

  const rows = await input.db
    .select(eventSelection)
    .from(agentEvents)
    .where(and(...predicates))
    .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
    .limit(limit + 1);

  return toEventFeedPage(rows, limit);
}

export async function listLatestAgentActivity(input: {
  db: AgentEventQueryExecutor;
  cursor?: string | null;
  limit?: number;
}): Promise<AgentEventFeedQueryResult> {
  const cursor = decodeOptionalEventCursor(input.cursor);

  if (!cursor.ok) {
    return cursor;
  }

  const limit = normalizeEventFeedLimit(input.limit);
  const predicates = cursor.cursor ? [eventCursorPredicate(cursor.cursor)] : [];
  const query = input.db
    .select({
      event: eventSelection,
      agent: {
        id: agents.id,
        name: agents.name,
        templateKey: agents.templateKey,
        status: agents.status,
        deletedAt: agents.deletedAt,
      },
    })
    .from(agentEvents)
    .innerJoin(agents, eq(agentEvents.agentId, agents.id));
  const rows = await (predicates.length > 0 ? query.where(and(...predicates)) : query)
    .orderBy(desc(agentEvents.createdAt), desc(agentEvents.id))
    .limit(limit + 1);
  const visibleRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const cursorRow = visibleRows.at(-1);

  return {
    ok: true,
    page: {
      events: visibleRows.map((row) => mapAgentEventToDto(row.event, { agent: row.agent })),
      nextCursor:
        hasNextPage && cursorRow
          ? encodeEventFeedCursor({ createdAt: cursorRow.event.createdAt, id: cursorRow.event.id })
          : null,
    },
  };
}

function decodeOptionalEventCursor(cursor: string | null | undefined):
  | {
      ok: true;
      cursor: AgentEventCursor | null;
    }
  | {
      ok: false;
      error: MalformedEventCursorError;
    } {
  if (cursor === null || cursor === undefined) {
    return {
      ok: true,
      cursor: null,
    };
  }

  return decodeEventFeedCursor(cursor);
}

function toEventFeedPage(rows: AgentEventRow[], limit: number): AgentEventFeedQueryResult {
  const visibleRows = rows.slice(0, limit);
  const hasNextPage = rows.length > limit;
  const cursorRow = visibleRows.at(-1);

  return {
    ok: true,
    page: {
      events: visibleRows.map((row) => mapAgentEventToDto(row)),
      nextCursor:
        hasNextPage && cursorRow
          ? encodeEventFeedCursor({ createdAt: cursorRow.createdAt, id: cursorRow.id })
          : null,
    },
  };
}

function eventCursorPredicate(cursor: AgentEventCursor): SQL {
  const predicate = or(
    lt(agentEvents.createdAt, cursor.createdAt),
    and(eq(agentEvents.createdAt, cursor.createdAt), lt(agentEvents.id, cursor.id)),
  );

  if (!predicate) {
    throw new Error("Event cursor predicate could not be built.");
  }

  return predicate;
}

function normalizeEventFeedLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isInteger(limit)) {
    return DEFAULT_EVENT_FEED_LIMIT;
  }

  if (limit < 1) {
    return 1;
  }

  return Math.min(limit, MAX_EVENT_FEED_LIMIT);
}

function malformedCursor(reason: EventCursorDecodeFailureReason): DecodeEventFeedCursorResult {
  return {
    ok: false,
    error: new MalformedEventCursorError(reason),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDisplayScalar(value: unknown): value is boolean | number | string {
  return ["boolean", "number", "string"].includes(typeof value);
}

function humanizeMetadataKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (firstCharacter) => firstCharacter.toUpperCase());
}
