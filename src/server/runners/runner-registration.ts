import { and, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { EnvValidationError, validateManualRunnerEndpointUrl } from "@/src/env/validation";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { runnerCredentials, runnerRegistrationTokens, runners } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import {
  createRunnerCredential,
  createRunnerRegistrationToken,
  hashRunnerSecret,
  REGISTRATION_TOKEN_PREFIX,
} from "@/src/server/runners/runner-auth-secrets";
import { DIGITALOCEAN_RUNNER_KIND } from "@/src/server/runners/digitalocean-provider";
import { markCloudRunnerRegistered } from "@/src/server/runners/runner-provisioning-events";
import { getOrCreateDevelopmentUserId } from "@/src/server/users/development-user";

const DEFAULT_REGISTRATION_TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_REGISTERED_RUNNER_NAME = "Manual VPS Runner";
const MANUAL_RUNNER_KIND = "manual_vps";
const ACTIVE_RUNNER_STATUS = "active";

type RunnerRegistrationTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type RegistrationValidationIssue = {
  field: string;
  message: string;
};

export type CreateRunnerRegistrationTokenResult = {
  registrationToken: {
    id: string;
    token: string;
    prefix: string;
    expiresAt: string;
  };
};

export type RegisterRunnerPayload = {
  registrationToken: string;
  endpointUrl: string;
  name: string;
};

export type ExchangeRunnerRegistrationTokenResult =
  | {
      ok: true;
      runner: {
        id: string;
      };
      credential: {
        token: string;
        prefix: string;
      };
    }
  | {
      ok: false;
      reason:
        | "missing_registration_token"
        | "malformed_registration_token"
        | "wrong_registration_token_prefix"
        | "unknown_registration_token"
        | "expired_registration_token"
        | "revoked_registration_token"
        | "used_registration_token";
    };

export class RunnerRegistrationPersistenceError extends Error {
  constructor(readonly cause?: unknown) {
    super("Runner registration persistence failed.");
    this.name = "RunnerRegistrationPersistenceError";
  }
}

export function validateRegisterRunnerPayload(
  payload: unknown,
):
  | { ok: true; value: RegisterRunnerPayload }
  | { ok: false; issues: RegistrationValidationIssue[] } {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be an object." }],
    };
  }

  const input = payload as Record<string, unknown>;
  const issues: RegistrationValidationIssue[] = [];
  const registrationToken =
    typeof input.registrationToken === "string" ? input.registrationToken.trim() : "";
  const endpointUrl = typeof input.endpointUrl === "string" ? input.endpointUrl.trim() : "";
  const name =
    typeof input.name === "string" && input.name.trim()
      ? input.name.trim()
      : DEFAULT_REGISTERED_RUNNER_NAME;

  if (!registrationToken) {
    issues.push({ field: "registrationToken", message: "Registration token is required." });
  } else if (!registrationToken.startsWith(`${REGISTRATION_TOKEN_PREFIX}_`)) {
    issues.push({
      field: "registrationToken",
      message: "Registration token must use the registration-token prefix.",
    });
  } else if (!isWellFormedRegistrationToken(registrationToken)) {
    issues.push({ field: "registrationToken", message: "Registration token is malformed." });
  }

  if (!endpointUrl) {
    issues.push({ field: "endpointUrl", message: "Runner endpoint URL is required." });
  } else {
    try {
      validateManualRunnerEndpointUrl(endpointUrl);
    } catch (error) {
      if (error instanceof EnvValidationError) {
        issues.push({ field: "endpointUrl", message: error.issues.join(" ") });
      } else {
        throw error;
      }
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      registrationToken,
      endpointUrl: validateManualRunnerEndpointUrl(endpointUrl),
      name,
    },
  };
}

export async function createRunnerRegistrationTokenForDevelopmentUser(
  dependencies: { createConnection?: () => DatabaseConnection; now?: () => Date } = {},
): Promise<CreateRunnerRegistrationTokenResult> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + DEFAULT_REGISTRATION_TOKEN_TTL_MS);
  const generated = createRunnerRegistrationToken();

  try {
    return await connection.db.transaction(async (tx) => {
      const userId = await getOrCreateDevelopmentUserId(tx);
      const [createdToken] = await tx
        .insert(runnerRegistrationTokens)
        .values({
          userId,
          tokenHash: generated.hash,
          tokenPrefix: generated.prefix,
          status: "pending",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: runnerRegistrationTokens.id,
          expiresAt: runnerRegistrationTokens.expiresAt,
        });

      if (!createdToken) {
        throw new Error("Runner registration token insert returned no rows.");
      }

      return {
        registrationToken: {
          id: createdToken.id,
          token: generated.value,
          prefix: generated.prefix,
          expiresAt: createdToken.expiresAt.toISOString(),
        },
      };
    });
  } catch (error) {
    throw new RunnerRegistrationPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function exchangeRunnerRegistrationTokenForCredential(
  input: RegisterRunnerPayload,
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<ExchangeRunnerRegistrationTokenResult> {
  const tokenCheck = classifyRegistrationTokenShape(input.registrationToken);

  if (!tokenCheck.ok) {
    return { ok: false, reason: tokenCheck.reason };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const credential = createRunnerCredential();
  const tokenHash = hashRunnerSecret(input.registrationToken);

  try {
    return await connection.db.transaction(async (tx) => {
      const [claimedToken] = await tx
        .update(runnerRegistrationTokens)
        .set({ updatedAt: now })
        .where(
          and(
            eq(runnerRegistrationTokens.tokenHash, tokenHash),
            eq(runnerRegistrationTokens.status, "pending"),
            gt(runnerRegistrationTokens.expiresAt, now),
          ),
        )
        .returning({
          id: runnerRegistrationTokens.id,
          userId: runnerRegistrationTokens.userId,
          runnerId: runnerRegistrationTokens.runnerId,
        });

      if (!claimedToken) {
        return await classifyUnclaimedRegistrationToken(tx, tokenHash, now);
      }

      const runner = await upsertRegisteredRunnerInTransaction(tx, {
        userId: claimedToken.userId,
        runnerId: claimedToken.runnerId,
        name: input.name,
        endpointUrl: input.endpointUrl,
        now,
      });

      const [createdCredential] = await tx
        .insert(runnerCredentials)
        .values({
          runnerId: runner.id,
          credentialHash: credential.hash,
          credentialPrefix: credential.prefix,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: runnerCredentials.id });

      if (!createdCredential) {
        throw new Error("Runner credential insert returned no rows.");
      }

      const [usedToken] = await tx
        .update(runnerRegistrationTokens)
        .set({
          runnerId: runner.id,
          status: "used",
          usedAt: now,
          updatedAt: now,
        })
        .where(eq(runnerRegistrationTokens.id, claimedToken.id))
        .returning({ id: runnerRegistrationTokens.id });

      if (!usedToken) {
        throw new Error("Runner registration token use update returned no rows.");
      }

      return {
        ok: true,
        runner: {
          id: runner.id,
        },
        credential: {
          token: credential.value,
          prefix: credential.prefix,
        },
      } as const;
    });
  } catch (error) {
    throw new RunnerRegistrationPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function classifyRegistrationTokenShape(registrationToken: string):
  | { ok: true }
  | {
      ok: false;
      reason:
        | "missing_registration_token"
        | "malformed_registration_token"
        | "wrong_registration_token_prefix";
    } {
  const token = registrationToken.trim();

  if (!token) {
    return { ok: false, reason: "missing_registration_token" };
  }

  if (!token.startsWith(`${REGISTRATION_TOKEN_PREFIX}_`)) {
    return { ok: false, reason: "wrong_registration_token_prefix" };
  }

  if (!isWellFormedRegistrationToken(token)) {
    return { ok: false, reason: "malformed_registration_token" };
  }

  return { ok: true };
}

function isWellFormedRegistrationToken(token: string): boolean {
  return new RegExp(`^${REGISTRATION_TOKEN_PREFIX}_[A-Za-z0-9_-]{32,}$`).test(token);
}

async function classifyUnclaimedRegistrationToken(
  tx: RunnerRegistrationTransaction,
  tokenHash: string,
  now: Date,
): Promise<ExchangeRunnerRegistrationTokenResult> {
  const [existingToken] = await tx
    .select({
      status: runnerRegistrationTokens.status,
      expiresAt: runnerRegistrationTokens.expiresAt,
    })
    .from(runnerRegistrationTokens)
    .where(eq(runnerRegistrationTokens.tokenHash, tokenHash))
    .limit(1);

  if (!existingToken) {
    return { ok: false, reason: "unknown_registration_token" };
  }

  if (existingToken.status === "revoked") {
    return { ok: false, reason: "revoked_registration_token" };
  }

  if (existingToken.status === "used") {
    return { ok: false, reason: "used_registration_token" };
  }

  if (existingToken.status === "expired" || existingToken.expiresAt <= now) {
    return { ok: false, reason: "expired_registration_token" };
  }

  return { ok: false, reason: "unknown_registration_token" };
}

async function upsertRegisteredRunnerInTransaction(
  tx: RunnerRegistrationTransaction,
  input: {
    userId: string;
    runnerId: string | null;
    name: string;
    endpointUrl: string;
    now: Date;
  },
): Promise<{ id: string }> {
  if (input.runnerId) {
    return await updateProvisionedRunnerInTransaction(tx, {
      userId: input.userId,
      runnerId: input.runnerId,
      name: input.name,
      endpointUrl: input.endpointUrl,
      now: input.now,
    });
  }

  const [existingRunner] = await tx
    .select({ id: runners.id })
    .from(runners)
    .where(
      and(
        eq(runners.userId, input.userId),
        eq(runners.endpointUrl, input.endpointUrl),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (existingRunner) {
    const [updatedRunner] = await tx
      .update(runners)
      .set({
        name: input.name,
        kind: MANUAL_RUNNER_KIND,
        status: ACTIVE_RUNNER_STATUS,
        updatedAt: input.now,
      })
      .where(eq(runners.id, existingRunner.id))
      .returning({ id: runners.id });

    if (!updatedRunner) {
      throw new Error("Registered runner update returned no rows.");
    }

    return updatedRunner;
  }

  const [createdRunner] = await tx
    .insert(runners)
    .values({
      userId: input.userId,
      name: input.name,
      kind: MANUAL_RUNNER_KIND,
      endpointUrl: input.endpointUrl,
      status: ACTIVE_RUNNER_STATUS,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: runners.id });

  if (!createdRunner) {
    throw new Error("Registered runner insert returned no rows.");
  }

  return createdRunner;
}

async function updateProvisionedRunnerInTransaction(
  tx: RunnerRegistrationTransaction,
  input: {
    userId: string;
    runnerId: string;
    name: string;
    endpointUrl: string;
    now: Date;
  },
): Promise<{ id: string }> {
  const [existingRunner] = await tx
    .select({
      id: runners.id,
      kind: runners.kind,
    })
    .from(runners)
    .where(
      and(
        eq(runners.id, input.runnerId),
        eq(runners.userId, input.userId),
        isNull(runners.deletedAt),
      ),
    )
    .limit(1);

  if (!existingRunner) {
    throw new Error("Provisioned runner for registration token was not found.");
  }

  if (existingRunner.kind !== DIGITALOCEAN_RUNNER_KIND) {
    throw new Error("Registration token is linked to an unsupported runner kind.");
  }

  const [updatedRunner] = await tx
    .update(runners)
    .set({
      name: input.name,
      endpointUrl: input.endpointUrl,
      status: "registering",
      provisioningStatus: "waiting_for_runner",
      updatedAt: input.now,
    })
    .where(eq(runners.id, input.runnerId))
    .returning({ id: runners.id });

  if (!updatedRunner) {
    throw new Error("Provisioned runner registration update returned no rows.");
  }

  await markCloudRunnerRegistered(tx, {
    runnerId: updatedRunner.id,
    now: input.now,
  });

  return updatedRunner;
}
