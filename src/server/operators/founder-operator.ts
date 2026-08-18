import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { operatorPreparations, operators } from "@/src/server/db/schema";

type OperatorTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderOperatorPreparationStatus =
  | "awaiting_timezone"
  | "preparing"
  | "ready"
  | "needs_attention";

export type FounderOperatorDto = {
  id: string;
  userId: string;
  status: "active";
  createdAt: string;
  updatedAt: string;
  preparation: {
    id: string;
    status: FounderOperatorPreparationStatus;
    timezone: string | null;
    timezoneConfirmedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    recoveryMessage: string | null;
    createdAt: string;
    updatedAt: string;
  };
};

export type FounderOperatorDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
};

export class FounderOperatorTimezoneError extends Error {
  readonly code = "invalid_timezone" as const;

  constructor() {
    super("Timezone must be a valid IANA timezone.");
    this.name = "FounderOperatorTimezoneError";
  }
}

export class FounderOperatorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FounderOperatorInvariantError";
  }
}

export async function ensureFounderOperatorForUser(
  userId: string,
  dependencies: FounderOperatorDependencies = {},
): Promise<FounderOperatorDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());

  try {
    return await connection.db.transaction((tx) =>
      ensureFounderOperatorInTransaction(tx, userId, now()),
    );
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function getFounderOperatorForUser(
  userId: string,
  dependencies: FounderOperatorDependencies = {},
): Promise<FounderOperatorDto | null> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const row = await selectFounderOperatorInTransaction(tx, userId);
      return row ? toDto(row.operator, row.preparation) : null;
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function confirmFounderTimezoneForUser(
  userId: string,
  timezone: string,
  dependencies: FounderOperatorDependencies = {},
): Promise<FounderOperatorDto> {
  const normalizedTimezone = normalizeTimezone(timezone);
  if (!normalizedTimezone) {
    throw new FounderOperatorTimezoneError();
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());

  try {
    return await connection.db.transaction(async (tx) => {
      const current = await ensureFounderOperatorInTransaction(tx, userId, now());
      const [preparation] = await tx
        .select()
        .from(operatorPreparations)
        .where(eq(operatorPreparations.id, current.preparation.id))
        .limit(1);

      if (!preparation) {
        throw new FounderOperatorInvariantError("Operator preparation could not be reloaded.");
      }

      const timezoneChanged = preparation.timezone !== normalizedTimezone;
      const currentNow = now();
      const confirmedAt = timezoneChanged
        ? currentNow
        : (preparation.timezoneConfirmedAt ?? currentNow);
      const [updatedPreparation] = await tx
        .update(operatorPreparations)
        .set({
          status: preparation.status === "ready" && !timezoneChanged ? "ready" : "preparing",
          timezone: normalizedTimezone,
          timezoneConfirmedAt: confirmedAt,
          startedAt: preparation.startedAt ?? laterDate(currentNow, preparation.createdAt),
          updatedAt: currentNow,
        })
        .where(eq(operatorPreparations.id, preparation.id))
        .returning();

      if (!updatedPreparation) {
        throw new FounderOperatorInvariantError("Operator preparation could not be updated.");
      }

      const [operator] = await tx
        .select()
        .from(operators)
        .where(eq(operators.id, current.id))
        .limit(1);

      if (operator?.status !== "active") {
        throw new FounderOperatorInvariantError("Active Founder Operator could not be reloaded.");
      }

      return toDto(operator, updatedPreparation);
    });
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function ensureFounderOperatorInTransaction(
  tx: OperatorTransaction,
  userId: string,
  now: Date,
): Promise<FounderOperatorDto> {
  await lockFounderOperatorOwner(tx, userId);

  const existing = await selectFounderOperatorInTransaction(tx, userId);
  let operator = existing?.operator;

  if (!operator) {
    const [activeOperator] = await tx
      .select()
      .from(operators)
      .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
      .limit(1);
    operator = activeOperator;
  }

  if (!operator) {
    const [created] = await tx
      .insert(operators)
      .values({ userId, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: operators.userId })
      .returning();
    operator = created;
  }

  if (!operator) {
    const [afterConflict] = await tx
      .select()
      .from(operators)
      .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
      .limit(1);
    operator = afterConflict;
  }

  if (operator?.status !== "active") {
    throw new FounderOperatorInvariantError("An active Founder Operator could not be established.");
  }

  let preparation = existing?.preparation;
  if (!preparation || preparation.operatorId !== operator.id) {
    const [existingPreparation] = await tx
      .select()
      .from(operatorPreparations)
      .where(eq(operatorPreparations.operatorId, operator.id))
      .limit(1);
    preparation = existingPreparation;
  }

  if (!preparation) {
    const [createdPreparation] = await tx
      .insert(operatorPreparations)
      .values({ operatorId: operator.id, createdAt: now, updatedAt: now })
      .onConflictDoNothing({ target: operatorPreparations.operatorId })
      .returning();
    preparation = createdPreparation;
  }

  if (!preparation) {
    const afterConflict = await tx
      .select()
      .from(operatorPreparations)
      .where(eq(operatorPreparations.operatorId, operator.id))
      .limit(1);
    preparation = afterConflict[0];
  }

  if (!preparation) {
    throw new FounderOperatorInvariantError(
      "Founder Operator preparation could not be established.",
    );
  }

  return toDto(operator, preparation);
}

async function selectFounderOperatorInTransaction(
  tx: OperatorTransaction,
  userId: string,
): Promise<{
  operator: typeof operators.$inferSelect;
  preparation: typeof operatorPreparations.$inferSelect;
} | null> {
  const [row] = await tx
    .select({ operator: operators, preparation: operatorPreparations })
    .from(operators)
    .innerJoin(operatorPreparations, eq(operatorPreparations.operatorId, operators.id))
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);

  return row ?? null;
}

async function lockFounderOperatorOwner(tx: OperatorTransaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:founder-operator:${userId}`}, 0))`,
  );
}

function toDto(
  operator: typeof operators.$inferSelect,
  preparation: typeof operatorPreparations.$inferSelect,
): FounderOperatorDto {
  if (operator.status !== "active") {
    throw new FounderOperatorInvariantError("Only active Founder Operators are customer-visible.");
  }

  return {
    id: operator.id,
    userId: operator.userId,
    status: operator.status,
    createdAt: operator.createdAt.toISOString(),
    updatedAt: operator.updatedAt.toISOString(),
    preparation: {
      id: preparation.id,
      status: preparation.status,
      timezone: preparation.timezone,
      timezoneConfirmedAt: preparation.timezoneConfirmedAt?.toISOString() ?? null,
      startedAt: preparation.startedAt?.toISOString() ?? null,
      completedAt: preparation.completedAt?.toISOString() ?? null,
      recoveryMessage: preparation.recoveryMessage,
      createdAt: preparation.createdAt.toISOString(),
      updatedAt: preparation.updatedAt.toISOString(),
    },
  };
}

function normalizeTimezone(value: string): string | null {
  const timezone = value.trim();
  if (!timezone || timezone.length > 120) {
    return null;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    return null;
  }
}

function laterDate(left: Date, right: Date): Date {
  return left.getTime() >= right.getTime() ? left : right;
}
