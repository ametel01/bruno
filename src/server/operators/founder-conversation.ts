import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorAiConnections,
  operatorConversationMessages,
  operatorConversations,
  operatorConversationWorks,
} from "@/src/server/db/schema";
import {
  type FounderActionPreviewDto,
  projectFounderActionPreview,
} from "@/src/server/operators/founder-action-previews";
import {
  type FounderAiConnectionDto,
  requireReadyFounderOpenAiConnectionForUser,
} from "@/src/server/operators/founder-ai-connection";
import {
  buildFounderAiCheckpointIdentity,
  buildFounderAiCompletionIdentity,
  FOUNDER_AI_COMPATIBILITY_POLICY_VERSION,
  FOUNDER_AI_RECOVERY_CHOICES,
  FOUNDER_AI_WORK_PROVIDER,
  type FounderAiRecoveryChoice,
} from "@/src/server/operators/founder-ai-work";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import {
  type FounderProposedActionDto,
  projectFounderProposedAction,
} from "@/src/server/operators/founder-proposed-actions";

type FounderConversationTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const MAX_MESSAGE_LENGTH = 12_000;

export type FounderConversationMessageDto = {
  id: string;
  sequence: number;
  role: "founder" | "operator";
  status: "complete" | "paused";
  body: string;
  createdAt: string;
};

export type FounderConversationWorkDto = {
  id: string;
  requestId: string;
  checkpointId: string;
  provider: "openai";
  policyVersion: number;
  completionIdentity: string;
  externalEffectStarted: boolean;
  state: "running" | "completed" | "paused" | "failed";
  recoveryMessage: string | null;
  recoveryChoices: FounderAiRecoveryChoice[];
  createdAt: string;
  updatedAt: string;
};

export type FounderConversationDto = {
  id: string;
  status: "active" | "paused";
  messages: FounderConversationMessageDto[];
  activeWork: FounderConversationWorkDto | null;
  actionPreview: FounderActionPreviewDto;
  proposedAction?: FounderProposedActionDto | null;
  createdAt: string;
  updatedAt: string;
};

export type FounderConversationAdapterInput = {
  operatorId: string;
  userId: string;
  conversationId: string;
  requestId: string;
  checkpointId: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
};

export type FounderConversationAdapterResult =
  | { ok: true; response: string }
  | {
      ok: false;
      code: "capacity_unavailable" | "provider_unavailable";
      message: string;
    };

export type FounderConversationAdapter = {
  send(input: FounderConversationAdapterInput): Promise<FounderConversationAdapterResult>;
};

export type FounderConversationDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  requestId?: string;
  adapter?: FounderConversationAdapter;
  requireReadyConnection?: (
    userId: string,
    dependencies?: { createConnection?: () => DatabaseConnection },
  ) => Promise<FounderAiConnectionDto>;
  maxMessageLength?: number;
};

export class FounderConversationError extends Error {
  readonly code:
    | "invalid_message"
    | "operator_not_ready"
    | "conversation_unavailable"
    | "conversation_ai_unavailable";
  readonly status: 400 | 409 | 503;

  constructor(
    code: FounderConversationError["code"],
    message: string,
    status: 400 | 409 | 503 = 409,
  ) {
    super(message);
    this.name = "FounderConversationError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderConversationForUser(
  userId: string,
  dependencies: Pick<FounderConversationDependencies, "createConnection"> = {},
): Promise<FounderConversationDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const conversation = await ensureConversation(tx, operator.id, new Date());
      return projectConversation(tx, conversation);
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function sendFounderConversationMessageForUser(
  userId: string,
  body: string,
  dependencies: FounderConversationDependencies = {},
): Promise<FounderConversationDto> {
  const message = normalizeMessage(body, dependencies.maxMessageLength ?? MAX_MESSAGE_LENGTH);
  if (!message) {
    throw new FounderConversationError(
      "invalid_message",
      "Write a message before sending it.",
      400,
    );
  }

  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  if (operator.preparation.status !== "ready" || operator.runtime?.status !== "ready") {
    throw new FounderConversationError(
      "operator_not_ready",
      "Bruno is still preparing your private workspace. Try again when it is ready.",
    );
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.randomUUID ?? randomUUID;
  const requestId = normalizeRequestId(dependencies.requestId) ?? makeId();

  try {
    const started = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const conversation = await ensureConversation(tx, operator.id, now());
      const [existing] = await tx
        .select()
        .from(operatorConversationWorks)
        .where(
          and(
            eq(operatorConversationWorks.conversationId, conversation.id),
            eq(operatorConversationWorks.requestId, requestId),
          ),
        )
        .limit(1);
      if (existing) return { kind: "existing" as const, conversation };

      const founderMessageId = makeId();
      const workId = makeId();
      const checkpointId = buildFounderAiCheckpointIdentity(
        conversation.id,
        conversation.nextSequence,
      );
      const createdAt = now();
      await tx.insert(operatorConversationWorks).values({
        id: workId,
        conversationId: conversation.id,
        requestId,
        checkpointId,
        provider: FOUNDER_AI_WORK_PROVIDER,
        policyVersion: FOUNDER_AI_COMPATIBILITY_POLICY_VERSION,
        completionIdentity: buildFounderAiCompletionIdentity(workId),
        responseSequence: conversation.nextSequence + 1,
        state: "running",
        founderMessageId,
        recoveryChoices: [],
        createdAt,
        updatedAt: createdAt,
      });
      await tx.insert(operatorConversationMessages).values({
        id: founderMessageId,
        conversationId: conversation.id,
        workId,
        sequence: conversation.nextSequence,
        role: "founder",
        status: "complete",
        body: message,
        createdAt,
      });
      await tx
        .update(operatorConversations)
        .set({ nextSequence: conversation.nextSequence + 2, updatedAt: createdAt })
        .where(eq(operatorConversations.id, conversation.id));

      const history = await tx
        .select({
          role: operatorConversationMessages.role,
          body: operatorConversationMessages.body,
        })
        .from(operatorConversationMessages)
        .where(eq(operatorConversationMessages.conversationId, conversation.id))
        .orderBy(asc(operatorConversationMessages.sequence));
      return {
        kind: "started" as const,
        conversation,
        workId,
        checkpointId,
        messages: history.map((item) => ({
          role: item.role === "founder" ? ("user" as const) : ("assistant" as const),
          content: item.body,
        })),
      };
    });

    if (started.kind === "existing") {
      return connection.db.transaction((tx) => projectConversation(tx, started.conversation));
    }

    try {
      const ready =
        dependencies.requireReadyConnection ?? requireReadyFounderOpenAiConnectionForUser;
      await ready(userId, { createConnection: () => connection });
    } catch (error) {
      const message =
        error instanceof Error && error.message.trim()
          ? error.message.trim()
          : "Your connected AI account is not available. Bruno paused this message safely.";
      return finalizePausedConversation(connection, started, message, now());
    }

    await connection.db.transaction(async (tx) => {
      const [aiConnection] = await tx
        .select({ id: operatorAiConnections.id })
        .from(operatorAiConnections)
        .where(
          and(
            eq(operatorAiConnections.operatorId, operator.id),
            eq(operatorAiConnections.status, "ready"),
          ),
        )
        .orderBy(desc(operatorAiConnections.updatedAt))
        .limit(1);
      if (aiConnection) {
        await tx
          .update(operatorConversationWorks)
          .set({ providerConnectionId: aiConnection.id, updatedAt: now() })
          .where(eq(operatorConversationWorks.id, started.workId));
      }
    });

    const adapter = dependencies.adapter ?? createHermesConversationAdapter();
    let result: FounderConversationAdapterResult;
    try {
      result = await adapter.send({
        operatorId: operator.id,
        userId,
        conversationId: started.conversation.id,
        requestId,
        checkpointId: started.checkpointId,
        messages: started.messages,
      });
    } catch {
      return finalizePausedConversation(
        connection,
        started,
        "Bruno could not reach your connected AI account. Your message remains checkpointed.",
        now(),
      );
    }
    if (!result.ok) return finalizePausedConversation(connection, started, result.message, now());

    const response = normalizeMessage(result.response, MAX_MESSAGE_LENGTH);
    if (!response) {
      return finalizePausedConversation(
        connection,
        started,
        "Bruno received an empty response and kept your message checkpointed for safety.",
        now(),
      );
    }
    return finalizeCompletedConversation(connection, started, response, now());
  } finally {
    if (ownsConnection) await connection.close();
  }
}

function normalizeRequestId(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 200 ? normalized : null;
}

function normalizeMessage(value: string, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= maxLength ? normalized : null;
}

async function ensureConversation(
  tx: FounderConversationTransaction,
  operatorId: string,
  now: Date,
): Promise<typeof operatorConversations.$inferSelect> {
  const [existing] = await tx
    .select()
    .from(operatorConversations)
    .where(eq(operatorConversations.operatorId, operatorId))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(operatorConversations)
    .values({ operatorId, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: operatorConversations.operatorId })
    .returning();
  if (created) return created;
  const [afterConflict] = await tx
    .select()
    .from(operatorConversations)
    .where(eq(operatorConversations.operatorId, operatorId))
    .limit(1);
  if (!afterConflict)
    throw new FounderConversationError(
      "conversation_unavailable",
      "Conversation could not be opened.",
      503,
    );
  return afterConflict;
}

async function projectConversation(
  tx: FounderConversationTransaction,
  conversation: typeof operatorConversations.$inferSelect,
): Promise<FounderConversationDto> {
  const messages = await tx
    .select()
    .from(operatorConversationMessages)
    .where(eq(operatorConversationMessages.conversationId, conversation.id))
    .orderBy(asc(operatorConversationMessages.sequence));
  const [work] = await tx
    .select()
    .from(operatorConversationWorks)
    .where(eq(operatorConversationWorks.conversationId, conversation.id))
    .orderBy(desc(operatorConversationWorks.createdAt), desc(operatorConversationWorks.id))
    .limit(1);
  const actionPreview = await projectFounderActionPreview(tx, conversation.operatorId);
  const proposedAction = await projectFounderProposedAction(tx, conversation.operatorId);
  return {
    id: conversation.id,
    status: conversation.status,
    messages: messages.map((message) => ({
      id: message.id,
      sequence: message.sequence,
      role: message.role,
      status: message.status,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
    })),
    activeWork: work
      ? {
          id: work.id,
          requestId: work.requestId,
          checkpointId: work.checkpointId,
          provider: work.provider as "openai",
          policyVersion: work.policyVersion,
          completionIdentity: work.completionIdentity,
          externalEffectStarted: work.externalEffectStarted,
          state: work.state,
          recoveryMessage: work.recoveryMessage,
          recoveryChoices: readRecoveryChoices(work.recoveryChoices),
          createdAt: work.createdAt.toISOString(),
          updatedAt: work.updatedAt.toISOString(),
        }
      : null,
    actionPreview,
    proposedAction,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

async function finalizeCompletedConversation(
  connection: DatabaseConnection,
  started: {
    conversation: typeof operatorConversations.$inferSelect;
    workId: string;
  },
  response: string,
  now: Date,
): Promise<FounderConversationDto> {
  return connection.db.transaction(async (tx) => {
    await lockConversation(tx, started.conversation.id);
    const [work] = await tx
      .select()
      .from(operatorConversationWorks)
      .where(eq(operatorConversationWorks.id, started.workId))
      .limit(1);
    if (!work)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation work could not be reloaded.",
        503,
      );
    const [conversation] = await tx
      .select()
      .from(operatorConversations)
      .where(eq(operatorConversations.id, work.conversationId))
      .limit(1)
      .for("update");
    if (!conversation)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation could not be reloaded.",
        503,
      );
    if (work.state !== "running") return projectConversation(tx, conversation);
    const [operatorMessage] = await tx
      .insert(operatorConversationMessages)
      .values({
        conversationId: work.conversationId,
        workId: work.id,
        sequence: work.responseSequence,
        role: "operator",
        status: "complete",
        body: response,
        createdAt: now,
      })
      .returning();
    if (!operatorMessage)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Operator response could not be saved.",
        503,
      );
    await tx
      .update(operatorConversationWorks)
      .set({
        state: "completed",
        operatorMessageId: operatorMessage.id,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(operatorConversationWorks.id, work.id));
    const [updatedConversation] = await tx
      .update(operatorConversations)
      .set({
        status: "active",
        updatedAt: now,
      })
      .where(eq(operatorConversations.id, work.conversationId))
      .returning();
    if (!updatedConversation)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation could not be updated.",
        503,
      );
    return projectConversation(tx, updatedConversation);
  });
}

async function finalizePausedConversation(
  connection: DatabaseConnection,
  started: {
    conversation: typeof operatorConversations.$inferSelect;
    workId: string;
  },
  message: string,
  now: Date,
): Promise<FounderConversationDto> {
  return connection.db.transaction(async (tx) => {
    await lockConversation(tx, started.conversation.id);
    const [work] = await tx
      .select()
      .from(operatorConversationWorks)
      .where(eq(operatorConversationWorks.id, started.workId))
      .limit(1);
    if (!work)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation work could not be reloaded.",
        503,
      );
    const [conversation] = await tx
      .select()
      .from(operatorConversations)
      .where(eq(operatorConversations.id, work.conversationId))
      .limit(1)
      .for("update");
    if (!conversation)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation could not be reloaded.",
        503,
      );
    if (work.state !== "running") return projectConversation(tx, conversation);
    const [operatorMessage] = await tx
      .insert(operatorConversationMessages)
      .values({
        conversationId: work.conversationId,
        workId: work.id,
        sequence: work.responseSequence,
        role: "operator",
        status: "paused",
        body: message,
        createdAt: now,
      })
      .returning();
    if (!operatorMessage)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Paused state could not be saved.",
        503,
      );
    await tx
      .update(operatorConversationWorks)
      .set({
        state: "paused",
        operatorMessageId: operatorMessage.id,
        recoveryMessage: message,
        recoveryChoices: FOUNDER_AI_RECOVERY_CHOICES.map((choice) => choice.kind),
        pausedAt: now,
        updatedAt: now,
      })
      .where(eq(operatorConversationWorks.id, work.id));
    const [updatedConversation] = await tx
      .update(operatorConversations)
      .set({
        status: "paused",
        updatedAt: now,
      })
      .where(eq(operatorConversations.id, work.conversationId))
      .returning();
    if (!updatedConversation)
      throw new FounderConversationError(
        "conversation_unavailable",
        "Conversation could not be paused.",
        503,
      );
    return projectConversation(tx, updatedConversation);
  });
}

function readRecoveryChoices(value: string[]): FounderAiRecoveryChoice[] {
  const available = new Map(FOUNDER_AI_RECOVERY_CHOICES.map((choice) => [choice.kind, choice]));
  return value.flatMap((kind) => {
    const choice = available.get(kind as FounderAiRecoveryChoice["kind"]);
    return choice ? [choice] : [];
  });
}

async function lockOperator(tx: FounderConversationTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:operator-conversation:${operatorId}`}, 0))`,
  );
}

async function lockConversation(
  tx: FounderConversationTransaction,
  conversationId: string,
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:conversation:${conversationId}`}, 0))`,
  );
}

export function createHermesConversationAdapter(
  input: {
    baseUrl?: string;
    request?: (path: string, init?: RequestInit) => Promise<unknown>;
  } = {},
): FounderConversationAdapter {
  const baseUrl = input.baseUrl ?? process.env.BRUNO_HERMES_CONTROL_URL?.trim();
  const request =
    input.request ??
    (baseUrl
      ? async (path: string, init?: RequestInit) => {
          const token = process.env.BRUNO_HERMES_CONTROL_TOKEN?.trim();
          const response = await fetch(new URL(path, baseUrl), {
            ...init,
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(init?.headers ?? {}),
            },
          });
          const body = (await response.json().catch(() => null)) as unknown;
          if (!response.ok) {
            const code = readErrorCode(body);
            if (code === "quota_exceeded" || code === "capacity_unavailable") {
              return { error: { code: "capacity_unavailable" } };
            }
            throw new Error("Hermes could not answer this message.");
          }
          return body;
        }
      : async () => {
          throw new Error("Hermes Conversation transport is not configured.");
        });

  return {
    async send(input) {
      try {
        const body = await request("/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({
            model: "configured-by-hermes",
            messages: input.messages,
            stream: false,
            metadata: {
              bruno_checkpoint_id: input.checkpointId,
              bruno_request_id: input.requestId,
            },
          }),
        });
        if (isCapacityBody(body)) {
          return {
            ok: false,
            code: "capacity_unavailable",
            message:
              "Your connected AI account has no available capacity right now. Bruno paused this message safely.",
          };
        }
        const response = readResponseText(body);
        return response
          ? { ok: true, response }
          : {
              ok: false,
              code: "provider_unavailable",
              message:
                "Bruno could not get a complete response. Your message remains checkpointed.",
            };
      } catch {
        return {
          ok: false,
          code: "provider_unavailable",
          message:
            "Bruno could not reach your connected AI account. Your message remains checkpointed.",
        };
      }
    },
  };
}

function readResponseText(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const choice = choices[0];
  if (choice && typeof choice === "object") {
    const message = (choice as Record<string, unknown>).message;
    if (message && typeof message === "object") {
      const content = (message as Record<string, unknown>).content;
      if (typeof content === "string") return content;
    }
  }
  const outputText = record.output_text;
  return typeof outputText === "string" ? outputText : null;
}

function readErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : null;
}

function isCapacityBody(value: unknown): boolean {
  return readErrorCode(value) === "capacity_unavailable";
}
