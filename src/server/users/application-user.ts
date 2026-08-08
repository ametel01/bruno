import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { users } from "@/src/server/db/schema";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";

export type ApplicationUserMode = "clerk" | "development" | "operator";

export type ApplicationUserResolution =
  | {
      ok: true;
      userId: string;
    }
  | {
      ok: false;
      status: 401;
      code: "unauthenticated";
    };

export type ClerkRequestIdentityProvider = () => Promise<string | null>;

export type RequireApplicationUserDependencies = {
  createConnection?: () => DatabaseConnection;
  getClerkUserId?: ClerkRequestIdentityProvider;
};

export type ApplicationUserTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export async function requireApplicationUser(
  mode: ApplicationUserMode,
  dependencies: RequireApplicationUserDependencies = {},
): Promise<ApplicationUserResolution> {
  const clerkUserId = await resolveRequestClerkUserId(mode, dependencies.getClerkUserId);

  if (mode === "clerk" && clerkUserId === null) {
    return {
      ok: false,
      status: 401,
      code: "unauthenticated",
    };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const userId = await connection.db.transaction(async (tx) => {
      if (mode === "development" || mode === "operator") {
        return await getOrCreateDevelopmentUserId(tx);
      }

      if (clerkUserId === null) {
        throw new Error("Authenticated Clerk identity unexpectedly missing.");
      }

      return await resolveClerkApplicationUserId(tx, clerkUserId);
    });

    return { ok: true, userId };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function resolveClerkApplicationUserId(
  tx: ApplicationUserTransaction,
  clerkUserId: string,
): Promise<string> {
  assertClerkUserId(clerkUserId);
  await lockClerkUserId(tx, clerkUserId);

  const [createdUser] = await tx
    .insert(users)
    .values({ clerkUserId })
    .onConflictDoNothing({ target: users.clerkUserId })
    .returning({ id: users.id });

  if (createdUser) {
    return createdUser.id;
  }

  const [existingUser] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.clerkUserId, clerkUserId))
    .limit(1);

  if (!existingUser) {
    throw new Error("Clerk identity insert conflict could not be resolved.");
  }

  return existingUser.id;
}

export async function lockClerkUserId(
  tx: ApplicationUserTransaction,
  clerkUserId: string,
): Promise<void> {
  assertClerkUserId(clerkUserId);
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:clerk-user:${clerkUserId}`}, 0))`,
  );
}

export function assertClerkUserId(clerkUserId: string): void {
  if (clerkUserId.length === 0 || clerkUserId.trim() !== clerkUserId) {
    throw new Error("Clerk user ID must be a non-empty opaque identifier.");
  }
}

async function resolveRequestClerkUserId(
  mode: ApplicationUserMode,
  getClerkUserId: ClerkRequestIdentityProvider | undefined,
): Promise<string | null> {
  if (mode === "development" || mode === "operator") {
    return null;
  }

  if (mode !== "clerk") {
    throw new Error("Unsupported application user mode.");
  }

  if (!getClerkUserId) {
    throw new Error("Clerk mode requires a request identity provider.");
  }

  const clerkUserId = await getClerkUserId();

  if (clerkUserId !== null) {
    assertClerkUserId(clerkUserId);
  }

  return clerkUserId;
}
