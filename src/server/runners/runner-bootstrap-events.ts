import "server-only";

import { and, eq, gt, inArray } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
} from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";
import { DIGITALOCEAN_PROVIDER } from "@/src/server/runners/digitalocean-provider";
import {
  hashRunnerSecret,
  REGISTRATION_TOKEN_PREFIX,
} from "@/src/server/runners/runner-auth-secrets";
import type {
  RunnerProvisioningEventStatus,
  RunnerProvisioningPhase,
} from "@/src/server/runners/runner-provisioning-events";

const BOOTSTRAP_EVENT_PHASES = new Set<RunnerProvisioningPhase>([
  "bootstrapping",
  "waiting_for_runner",
  "failed",
]);
const BOOTSTRAP_EVENT_STATUSES = new Set<RunnerProvisioningEventStatus>([
  "started",
  "completed",
  "failed",
]);
const MAX_MESSAGE_LENGTH = 240;
const MAX_METADATA_STRING_LENGTH = 500;

type RunnerBootstrapEventTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type RecordRunnerBootstrapEventInput = {
  registrationToken: string;
  phase: RunnerProvisioningPhase;
  status: RunnerProvisioningEventStatus;
  message: string;
  metadata?: Record<string, unknown>;
};

export type RecordRunnerBootstrapEventResult =
  | { ok: true; runnerId: string }
  | {
      ok: false;
      reason:
        | "invalid_payload"
        | "malformed_registration_token"
        | "unknown_registration_token"
        | "invalid_phase"
        | "invalid_status";
      issues?: Array<{ field: string; message: string }>;
    };

export class RunnerBootstrapEventPersistenceError extends Error {
  constructor(readonly cause?: unknown) {
    super("Runner bootstrap event persistence failed.");
    this.name = "RunnerBootstrapEventPersistenceError";
  }
}

export function validateRunnerBootstrapEventPayload(
  payload: unknown,
):
  | { ok: true; value: RecordRunnerBootstrapEventInput }
  | { ok: false; issues: Array<{ field: string; message: string }> } {
  if (!payload || typeof payload !== "object") {
    return {
      ok: false,
      issues: [{ field: "body", message: "Request body must be an object." }],
    };
  }

  const input = payload as Record<string, unknown>;
  const issues: Array<{ field: string; message: string }> = [];
  const registrationToken =
    typeof input.registrationToken === "string" ? input.registrationToken.trim() : "";
  const phase = typeof input.phase === "string" ? input.phase.trim() : "";
  const status = typeof input.status === "string" ? input.status.trim() : "";
  const message = typeof input.message === "string" ? input.message.trim() : "";
  const metadata =
    input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : undefined;

  if (!registrationToken) {
    issues.push({ field: "registrationToken", message: "Registration token is required." });
  } else if (!isWellFormedRegistrationToken(registrationToken)) {
    issues.push({ field: "registrationToken", message: "Registration token is malformed." });
  }

  if (!BOOTSTRAP_EVENT_PHASES.has(phase as RunnerProvisioningPhase)) {
    issues.push({ field: "phase", message: "Bootstrap event phase is invalid." });
  }

  if (!BOOTSTRAP_EVENT_STATUSES.has(status as RunnerProvisioningEventStatus)) {
    issues.push({ field: "status", message: "Bootstrap event status is invalid." });
  }

  if (!message) {
    issues.push({ field: "message", message: "Bootstrap event message is required." });
  }

  if ("metadata" in input && metadata === undefined) {
    issues.push({ field: "metadata", message: "Metadata must be an object when provided." });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      registrationToken,
      phase: phase as RunnerProvisioningPhase,
      status: status as RunnerProvisioningEventStatus,
      message: truncate(message, MAX_MESSAGE_LENGTH),
      ...(metadata ? { metadata } : {}),
    },
  };
}

export async function recordRunnerBootstrapEvent(
  input: RecordRunnerBootstrapEventInput,
  dependencies: {
    createConnection?: () => DatabaseConnection;
    now?: () => Date;
  } = {},
): Promise<RecordRunnerBootstrapEventResult> {
  if (!isWellFormedRegistrationToken(input.registrationToken)) {
    return { ok: false, reason: "malformed_registration_token" };
  }

  if (!BOOTSTRAP_EVENT_PHASES.has(input.phase)) {
    return { ok: false, reason: "invalid_phase" };
  }

  if (!BOOTSTRAP_EVENT_STATUSES.has(input.status)) {
    return { ok: false, reason: "invalid_status" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const tokenHash = hashRunnerSecret(input.registrationToken);

  try {
    return await connection.db.transaction(async (tx) => {
      const token = await findUsableBootstrapEventToken(tx, tokenHash, now);

      if (!token?.runnerId) {
        return { ok: false, reason: "unknown_registration_token" };
      }

      const metadata = {
        provider: DIGITALOCEAN_PROVIDER,
        source: "cloud_init",
        ...sanitizeBootstrapEventMetadata(input.metadata ?? {}),
      };
      const message = truncate(input.message.trim(), MAX_MESSAGE_LENGTH);

      if (input.status === "failed") {
        await tx
          .update(runners)
          .set({
            status: "provision_failed",
            provisioningStatus: "failed",
            provisioningError: message,
            provisioningCompletedAt: now,
            updatedAt: now,
          })
          .where(eq(runners.id, token.runnerId));
      }

      await tx.insert(runnerProvisioningEvents).values({
        runnerId: token.runnerId,
        phase: input.phase,
        status: input.status,
        message,
        metadata,
        createdAt: now,
      });

      return { ok: true, runnerId: token.runnerId };
    });
  } catch (error) {
    throw new RunnerBootstrapEventPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function findUsableBootstrapEventToken(
  tx: RunnerBootstrapEventTransaction,
  tokenHash: string,
  now: Date,
): Promise<{ runnerId: string | null } | null> {
  const [token] = await tx
    .select({ runnerId: runnerRegistrationTokens.runnerId })
    .from(runnerRegistrationTokens)
    .where(
      and(
        eq(runnerRegistrationTokens.tokenHash, tokenHash),
        inArray(runnerRegistrationTokens.status, ["pending", "used"]),
        gt(runnerRegistrationTokens.expiresAt, now),
      ),
    )
    .limit(1);

  return token ?? null;
}

function isWellFormedRegistrationToken(value: string): boolean {
  return new RegExp(`^${REGISTRATION_TOKEN_PREFIX}_[A-Za-z0-9_-]{32,}$`).test(value.trim());
}

function sanitizeBootstrapEventMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};

  for (const [key, rawValue] of Object.entries(value)) {
    const safeKey = sanitizeMetadataKey(key);

    if (!safeKey || isSensitiveMetadataKey(safeKey)) {
      continue;
    }

    sanitized[safeKey] = sanitizeMetadataValue(rawValue);
  }

  return sanitized;
}

function sanitizeMetadataValue(value: unknown, depth = 0): unknown {
  if (depth > 2) {
    return "[truncated]";
  }

  if (typeof value === "string") {
    return redactSecretLikeValues(truncate(value, MAX_METADATA_STRING_LENGTH));
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === "boolean" || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => sanitizeMetadataValue(item, depth + 1));
  }

  if (typeof value === "object" && value) {
    return sanitizeBootstrapEventMetadata(value as Record<string, unknown>);
  }

  return null;
}

function sanitizeMetadataKey(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, "_")
    .slice(0, 80);

  return normalized || null;
}

function isSensitiveMetadataKey(value: string): boolean {
  return /token|secret|credential|password|authorization|bearer/i.test(value);
}

function redactSecretLikeValues(value: string): string {
  return value
    .replace(/dop_v1_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/agb_reg_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/agb_run_[A-Za-z0-9_-]+/g, "[redacted]");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
