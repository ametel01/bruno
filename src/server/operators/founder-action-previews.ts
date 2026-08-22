import "server-only";

import { randomUUID } from "node:crypto";
import { desc, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { operatorActionPreviewRevisions, operatorActionPreviews } from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

type ActionPreviewTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderActionPreviewState = "draft";

export type FounderActionPreviewEvidenceDto = {
  label: string;
  detail: string;
};

export type FounderActionPreviewRevisionDto = {
  id: string;
  revision: number;
  state: FounderActionPreviewState;
  recipient: {
    name: string;
    address: string;
  };
  content: string;
  supportingEvidence: FounderActionPreviewEvidenceDto[];
  expectedExternalEffect: string;
  createdAt: string;
};

export type FounderActionPreviewDto = {
  id: string;
  current: FounderActionPreviewRevisionDto;
  /** Historical revisions are intentionally read-only and make edits auditable. */
  history: FounderActionPreviewRevisionDto[];
  authority: "none";
  executable: false;
  mailSendingOffer: "available" | "dismissed";
  createdAt: string;
  updatedAt: string;
};

export type FounderActionPreviewDraft = {
  recipientName: string;
  recipientAddress: string;
  content: string;
  supportingEvidence: FounderActionPreviewEvidenceDto[];
  expectedExternalEffect: string;
};

export type FounderActionPreviewDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
};

export class FounderActionPreviewError extends Error {
  readonly code: "invalid_preview" | "preview_unavailable";
  readonly status: 400 | 503;

  constructor(
    code: FounderActionPreviewError["code"],
    message: string,
    status: FounderActionPreviewError["status"] = 400,
  ) {
    super(message);
    this.name = "FounderActionPreviewError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderActionPreviewForUser(
  userId: string,
  dependencies: FounderActionPreviewDependencies = {},
): Promise<FounderActionPreviewDto | null> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction((tx) => projectFounderActionPreview(tx, operator.id)),
  );
}

export async function editFounderActionPreviewForUser(
  userId: string,
  draft: FounderActionPreviewDraft,
  dependencies: FounderActionPreviewDependencies = {},
): Promise<FounderActionPreviewDto> {
  const normalized = normalizeDraft(draft);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const at = dependencies.now?.() ?? new Date();
      await lockOperator(tx, operator.id);
      const preview = await ensurePreview(
        tx,
        operator.id,
        at,
        dependencies.randomUUID ? { randomUUID: dependencies.randomUUID } : undefined,
      );
      const [latest] = await tx
        .select()
        .from(operatorActionPreviewRevisions)
        .where(eq(operatorActionPreviewRevisions.previewId, preview.id))
        .orderBy(desc(operatorActionPreviewRevisions.revision))
        .limit(1);
      const revision = (latest?.revision ?? 0) + 1;
      const [created] = await tx
        .insert(operatorActionPreviewRevisions)
        .values({
          id: (dependencies.randomUUID ?? randomUUID)(),
          previewId: preview.id,
          revision,
          state: "draft",
          recipientName: normalized.recipientName,
          recipientAddress: normalized.recipientAddress,
          content: normalized.content,
          supportingEvidence: normalized.supportingEvidence,
          expectedExternalEffect: normalized.expectedExternalEffect,
          supersedesRevisionId: latest?.id ?? null,
          createdAt: at,
        })
        .returning();
      if (!created) {
        throw new FounderActionPreviewError(
          "preview_unavailable",
          "The new Action Preview draft could not be saved.",
          503,
        );
      }
      await tx
        .update(operatorActionPreviews)
        .set({ updatedAt: at })
        .where(eq(operatorActionPreviews.id, preview.id));
      return projectPreview(tx, preview, created);
    }),
  );
}

export async function dismissFounderMailSendingOfferForUser(
  userId: string,
  dependencies: FounderActionPreviewDependencies = {},
): Promise<FounderActionPreviewDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const at = dependencies.now?.() ?? new Date();
      await lockOperator(tx, operator.id);
      const preview = await ensurePreview(tx, operator.id, at, {
        ...(dependencies.randomUUID ? { randomUUID: dependencies.randomUUID } : {}),
      });
      await tx
        .update(operatorActionPreviews)
        .set({ mailSendingOfferDismissedAt: at, updatedAt: at })
        .where(eq(operatorActionPreviews.id, preview.id));
      const [latest] = await tx
        .select()
        .from(operatorActionPreviewRevisions)
        .where(eq(operatorActionPreviewRevisions.previewId, preview.id))
        .orderBy(desc(operatorActionPreviewRevisions.revision))
        .limit(1);
      if (!latest)
        throw new FounderActionPreviewError(
          "preview_unavailable",
          "Action Preview unavailable.",
          503,
        );
      return projectPreview(tx, { ...preview, mailSendingOfferDismissedAt: at }, latest);
    }),
  );
}

/** Used by other projections so every surface reads the same owner-scoped row. */
export async function projectFounderActionPreview(
  tx: ActionPreviewTransaction,
  operatorId: string,
): Promise<FounderActionPreviewDto | null> {
  const [preview] = await tx
    .select()
    .from(operatorActionPreviews)
    .where(eq(operatorActionPreviews.operatorId, operatorId))
    .limit(1);
  if (!preview) return null;
  const [latest] = await tx
    .select()
    .from(operatorActionPreviewRevisions)
    .where(eq(operatorActionPreviewRevisions.previewId, preview.id))
    .orderBy(desc(operatorActionPreviewRevisions.revision))
    .limit(1);
  if (!latest) return null;
  return projectPreview(tx, preview, latest);
}

async function projectPreview(
  tx: ActionPreviewTransaction,
  preview: typeof operatorActionPreviews.$inferSelect,
  current: typeof operatorActionPreviewRevisions.$inferSelect,
): Promise<FounderActionPreviewDto> {
  const revisions = await tx
    .select()
    .from(operatorActionPreviewRevisions)
    .where(eq(operatorActionPreviewRevisions.previewId, preview.id))
    .orderBy(desc(operatorActionPreviewRevisions.revision));
  return {
    id: preview.id,
    current: toRevisionDto(current),
    history: revisions.map(toRevisionDto),
    authority: "none",
    executable: false,
    mailSendingOffer: preview.mailSendingOfferDismissedAt ? "dismissed" : "available",
    createdAt: preview.createdAt.toISOString(),
    updatedAt: preview.updatedAt.toISOString(),
  };
}

async function ensurePreview(
  tx: ActionPreviewTransaction,
  operatorId: string,
  now: Date,
  options: { randomUUID?: () => string } = {},
) {
  await lockOperator(tx, operatorId);
  const [existing] = await tx
    .select()
    .from(operatorActionPreviews)
    .where(eq(operatorActionPreviews.operatorId, operatorId))
    .limit(1);
  if (existing) return existing;
  const makeId = options.randomUUID ?? randomUUID;
  const previewId = makeId();
  const [created] = await tx
    .insert(operatorActionPreviews)
    .values({ id: previewId, operatorId, createdAt: now, updatedAt: now })
    .onConflictDoNothing({ target: operatorActionPreviews.operatorId })
    .returning();
  const preview =
    created ??
    (
      await tx
        .select()
        .from(operatorActionPreviews)
        .where(eq(operatorActionPreviews.operatorId, operatorId))
        .limit(1)
    )[0];
  if (!preview) {
    throw new FounderActionPreviewError(
      "preview_unavailable",
      "The Action Preview could not be opened.",
      503,
    );
  }
  const [revision] = await tx
    .select()
    .from(operatorActionPreviewRevisions)
    .where(eq(operatorActionPreviewRevisions.previewId, preview.id))
    .limit(1);
  if (!revision) {
    await tx.insert(operatorActionPreviewRevisions).values({
      id: makeId(),
      previewId: preview.id,
      revision: 1,
      state: "draft",
      recipientName: "Recipient not selected",
      recipientAddress: "Address not selected",
      content: "Draft content pending Founder editing.",
      supportingEvidence: [
        { label: "Supporting evidence", detail: "No evidence has been selected yet." },
      ],
      expectedExternalEffect:
        "No external effect. This is a non-executable preview and nothing will be sent.",
      createdAt: now,
    });
  }
  return preview;
}

function normalizeDraft(input: FounderActionPreviewDraft): FounderActionPreviewDraft {
  const recipientName = normalize(input.recipientName, 240);
  const recipientAddress = normalize(input.recipientAddress, 320);
  const content = normalize(input.content, 12_000);
  const expectedExternalEffect = normalize(input.expectedExternalEffect, 2_000);
  const supportingEvidence = input.supportingEvidence
    .map((item) => ({ label: normalize(item.label, 240), detail: normalize(item.detail, 2_000) }))
    .filter((item) => item.label && item.detail)
    .slice(0, 20);
  if (!recipientName || !recipientAddress || !content || !expectedExternalEffect) {
    throw new FounderActionPreviewError(
      "invalid_preview",
      "Recipient, content, supporting evidence effect, and expected external effect are required.",
    );
  }
  if (supportingEvidence.length === 0) {
    throw new FounderActionPreviewError(
      "invalid_preview",
      "Add at least one supporting evidence item to the Action Preview.",
    );
  }
  return { recipientName, recipientAddress, content, supportingEvidence, expectedExternalEffect };
}

function normalize(value: string, max: number): string {
  if (typeof value !== "string") return "";
  const result = value.trim();
  return result.length >= 1 && result.length <= max ? result : "";
}

function toRevisionDto(
  revision: typeof operatorActionPreviewRevisions.$inferSelect,
): FounderActionPreviewRevisionDto {
  return {
    id: revision.id,
    revision: revision.revision,
    state: revision.state,
    recipient: { name: revision.recipientName, address: revision.recipientAddress },
    content: revision.content,
    supportingEvidence: revision.supportingEvidence,
    expectedExternalEffect: revision.expectedExternalEffect,
    createdAt: revision.createdAt.toISOString(),
  };
}

async function lockOperator(tx: ActionPreviewTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:action-preview:${operatorId}`}, 0))`,
  );
}

async function withConnection<T>(
  dependencies: FounderActionPreviewDependencies,
  callback: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await callback(connection);
  } finally {
    if (ownsConnection) await connection.close();
  }
}
