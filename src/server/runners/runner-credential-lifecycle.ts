import { and, eq, isNull } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerCredentials, runners } from "@/src/server/db/schema";
import { createRunnerCredential } from "@/src/server/runners/runner-auth-secrets";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export type RunnerCredentialLifecycleFailureReason =
  | "missing_runner_id"
  | "malformed_runner_id"
  | "runner_not_found"
  | "runner_credential_not_found"
  | "runner_credential_already_revoked";

export type RotateRunnerCredentialResult =
  | {
      ok: true;
      runner: {
        id: string;
      };
      credential: {
        token: string;
        prefix: string;
        rotatedAt: string;
      };
    }
  | {
      ok: false;
      reason: RunnerCredentialLifecycleFailureReason;
    };

export type RevokeRunnerCredentialResult =
  | {
      ok: true;
      runner: {
        id: string;
      };
      credential: {
        revokedAt: string;
        revokedCredentialCount: number;
      };
    }
  | {
      ok: false;
      reason: RunnerCredentialLifecycleFailureReason;
    };

export class RunnerCredentialLifecyclePersistenceError extends Error {
  constructor(readonly cause?: unknown) {
    super("Runner credential lifecycle persistence failed.");
    this.name = "RunnerCredentialLifecyclePersistenceError";
  }
}

export async function rotateRunnerCredentialForDevelopmentUser(
  input: { runnerId: string },
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<RotateRunnerCredentialResult> {
  const runnerId = validateRunnerId(input.runnerId);

  if (!runnerId.ok) {
    return { ok: false, reason: runnerId.reason };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const generatedCredential = createRunnerCredential();

  try {
    return await connection.db.transaction(async (tx) => {
      const runner = await findDevelopmentRunner(tx, runnerId.value);

      if (!runner) {
        return { ok: false, reason: "runner_not_found" } as const;
      }

      const revokedCredentials = await revokeActiveRunnerCredentials(tx, runner.id, now);

      if (revokedCredentials.length === 0) {
        const credentialState = await getRunnerCredentialState(tx, runner.id);

        if (credentialState.reason) {
          return { ok: false, reason: credentialState.reason } as const;
        }

        throw new Error("Runner credential rotation found active credentials but revoked none.");
      }

      const [createdCredential] = await tx
        .insert(runnerCredentials)
        .values({
          runnerId: runner.id,
          credentialHash: generatedCredential.hash,
          credentialPrefix: generatedCredential.prefix,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: runnerCredentials.id });

      if (!createdCredential) {
        throw new Error("Runner credential rotation insert returned no rows.");
      }

      await touchRunner(tx, runner.id, now);

      return {
        ok: true,
        runner: {
          id: runner.id,
        },
        credential: {
          token: generatedCredential.value,
          prefix: generatedCredential.prefix,
          rotatedAt: now.toISOString(),
        },
      } as const;
    });
  } catch (error) {
    throw new RunnerCredentialLifecyclePersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function revokeRunnerCredentialForDevelopmentUser(
  input: { runnerId: string },
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<RevokeRunnerCredentialResult> {
  const runnerId = validateRunnerId(input.runnerId);

  if (!runnerId.ok) {
    return { ok: false, reason: runnerId.reason };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const runner = await findDevelopmentRunner(tx, runnerId.value);

      if (!runner) {
        return { ok: false, reason: "runner_not_found" } as const;
      }

      const revokedCredentials = await revokeActiveRunnerCredentials(tx, runner.id, now);

      if (revokedCredentials.length === 0) {
        const credentialState = await getRunnerCredentialState(tx, runner.id);

        if (credentialState.reason) {
          return { ok: false, reason: credentialState.reason } as const;
        }

        throw new Error("Runner credential revocation found active credentials but revoked none.");
      }

      await touchRunner(tx, runner.id, now);

      return {
        ok: true,
        runner: {
          id: runner.id,
        },
        credential: {
          revokedAt: now.toISOString(),
          revokedCredentialCount: revokedCredentials.length,
        },
      } as const;
    });
  } catch (error) {
    throw new RunnerCredentialLifecyclePersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function validateRunnerId(runnerId: string):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      reason: "missing_runner_id" | "malformed_runner_id";
    } {
  const normalizedRunnerId = runnerId.trim();

  if (!normalizedRunnerId) {
    return { ok: false, reason: "missing_runner_id" };
  }

  if (!isUuid(normalizedRunnerId)) {
    return { ok: false, reason: "malformed_runner_id" };
  }

  return { ok: true, value: normalizedRunnerId };
}

async function findDevelopmentRunner(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  runnerId: string,
): Promise<{ id: string } | null> {
  const developmentUserId = await getDevelopmentUserId(tx);

  if (!developmentUserId) {
    return null;
  }

  const [runner] = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.id, runnerId),
        eq(runners.userId, developmentUserId),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  return runner ?? null;
}

async function getRunnerCredentialState(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  runnerId: string,
): Promise<
  | {
      reason: null;
    }
  | {
      reason: "runner_credential_not_found" | "runner_credential_already_revoked";
    }
> {
  const persistedCredentials = await tx
    .select({ status: runnerCredentials.status })
    .from(runnerCredentials)
    .where(eq(runnerCredentials.runnerId, runnerId));

  if (persistedCredentials.length === 0) {
    return { reason: "runner_credential_not_found" };
  }

  if (!persistedCredentials.some((credential) => credential.status === "active")) {
    return { reason: "runner_credential_already_revoked" };
  }

  return { reason: null };
}

async function revokeActiveRunnerCredentials(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  runnerId: string,
  now: Date,
): Promise<Array<{ id: string }>> {
  return await tx
    .update(runnerCredentials)
    .set({
      status: "revoked",
      revokedAt: now,
      updatedAt: now,
    })
    .where(and(eq(runnerCredentials.runnerId, runnerId), eq(runnerCredentials.status, "active")))
    .returning({ id: runnerCredentials.id });
}

async function touchRunner(
  tx: Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0],
  runnerId: string,
  now: Date,
): Promise<void> {
  await tx.update(runners).set({ updatedAt: now }).where(eq(runners.id, runnerId));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
