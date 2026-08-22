import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import {
  AGENT_LAUNCH_SPEC_VERSION,
  type NativeAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { operatorPreparations, operatorRuntimes, operators } from "@/src/server/db/schema";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { persistFounderOwnerPreviewHoldInTransaction } from "@/src/server/founder-product-contract/release-stage-hold";
import {
  ensureFounderOperatorForUser,
  type FounderOperatorDto,
  type FounderOperatorRuntimeDto,
  type FounderOperatorRuntimeSafetyState,
  type FounderOperatorRuntimeTransportState,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

type OperatorRuntimeTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const RUNTIME_LEASE_MS = 90_000;
const SAFETY_CONTRACT_VERSION = "bruno.operator.safety.v1" as const;
const RUNTIME_IDENTITY_PREFIX = "bruno-operator";

export type FounderOperatorRuntimeFailureCode =
  | "runtime_prepare_failed"
  | "runtime_transport_failed"
  | "runtime_safety_failed"
  | "runtime_verification_failed";

export type FounderOperatorRuntimeAdapterInput = {
  operatorId: string;
  userId: string;
  runtimeIdentity: string;
  configRevision: string;
  now: Date;
  launchSpec?: NativeAgentLaunchSpec;
};

export type FounderOperatorRuntimeAdapterResult =
  | {
      ok: true;
      runtimeIdentity: string;
      transportState: FounderOperatorRuntimeTransportState;
      safetyState: FounderOperatorRuntimeSafetyState;
    }
  | {
      ok: false;
      code: FounderOperatorRuntimeFailureCode;
      message: string;
    };

export type FounderOperatorRuntimeAdapter = {
  prepare(input: FounderOperatorRuntimeAdapterInput): Promise<FounderOperatorRuntimeAdapterResult>;
  verify(input: FounderOperatorRuntimeAdapterInput): Promise<FounderOperatorRuntimeAdapterResult>;
};

export type FounderOperatorRuntimeDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  adapter?: FounderOperatorRuntimeAdapter;
  stateRoot?: string;
  env?: Record<string, string | undefined>;
};

export type FounderOperatorRuntimePreparationResult = {
  operator: FounderOperatorDto;
  runtime: FounderOperatorRuntimeDto;
  changed: boolean;
};

/**
 * Prepare the one runtime owned by an Operator. The durable lease and unique
 * operator key make retries and concurrent requests converge on one active
 * preparation attempt.
 */
export async function prepareFounderOperatorRuntimeForUser(
  userId: string,
  dependencies: FounderOperatorRuntimeDependencies = {},
): Promise<FounderOperatorRuntimePreparationResult> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.randomUUID ?? randomUUID;
  const leaseOwner = `operator-runtime:${makeId()}`;
  const current = now();

  try {
    const claim = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [runtime] = await tx
        .select()
        .from(operatorRuntimes)
        .where(eq(operatorRuntimes.operatorId, operator.id))
        .limit(1)
        .for("update");

      if (!runtime) {
        throw new FounderOperatorRuntimeInvariantError(
          "Operator runtime could not be established.",
        );
      }

      if (operator.preparation.status === "awaiting_timezone") {
        return { kind: "awaiting_timezone" as const, runtime };
      }

      if (
        runtime.status === "ready" &&
        runtime.transportState === "connected" &&
        runtime.safetyState === "verified"
      ) {
        return { kind: "ready" as const, runtime };
      }

      if (runtime.leaseExpiresAt && runtime.leaseExpiresAt.getTime() > current.getTime()) {
        return { kind: "leased" as const, runtime };
      }

      const configRevision = `operator-runtime-${runtime.attemptCount + 1}-${current.getTime()}`;
      const [claimed] = await tx
        .update(operatorRuntimes)
        .set({
          status: "preparing",
          transportState: "starting",
          safetyState: "unknown",
          configRevision,
          operationId: makeId(),
          attemptCount: runtime.attemptCount + 1,
          leaseOwner,
          leaseExpiresAt: new Date(current.getTime() + RUNTIME_LEASE_MS),
          startedAt: runtime.startedAt ?? current,
          recoveryMessage: null,
          failureCode: null,
          updatedAt: current,
        })
        .where(eq(operatorRuntimes.id, runtime.id))
        .returning();

      if (!claimed) {
        throw new FounderOperatorRuntimeInvariantError(
          "Operator runtime lease could not be claimed.",
        );
      }

      return {
        kind: "claimed" as const,
        runtime: claimed,
        admittedRuntimeRevision: runtime.configRevision,
      };
    });

    if (claim.kind !== "claimed") {
      const projection = await getFounderOperatorForUser(userId, {
        createConnection: () => connection,
      });
      if (!projection?.runtime) {
        throw new FounderOperatorRuntimeInvariantError(
          "Operator runtime projection is unavailable.",
        );
      }
      return {
        operator: projection,
        runtime: projection.runtime,
        changed: false,
      };
    }

    const configRevision = claim.runtime.configRevision;
    if (!configRevision) {
      throw new FounderOperatorRuntimeInvariantError("Operator runtime revision is missing.");
    }

    const input: FounderOperatorRuntimeAdapterInput = {
      operatorId: operator.id,
      userId,
      runtimeIdentity: `${RUNTIME_IDENTITY_PREFIX}-${operator.id}`,
      configRevision,
      now: current,
      launchSpec: buildFounderOperatorNativeLaunchSpec({
        operatorId: operator.id,
        timezone: operator.preparation.timezone ?? "UTC",
        configRevision,
        apiServerKey: `bruno_agent_${randomBytes(24).toString("base64url")}`,
        requestId: leaseOwner,
      }),
    };
    const adapter =
      dependencies.adapter ??
      createFounderOperatorFilesystemAdapter(
        dependencies.stateRoot === undefined ? {} : { stateRoot: dependencies.stateRoot },
      );
    const prepared = await adapter.prepare(input);
    const verified = prepared.ok ? await adapter.verify(input) : prepared;
    const result = verified.ok ? verified : verified;

    const completedAt = now();
    const projection = await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [updated] = await tx
        .update(operatorRuntimes)
        .set(
          result.ok
            ? {
                status: "ready",
                transportState: result.transportState,
                safetyState: result.safetyState,
                runtimeIdentity: result.runtimeIdentity,
                readyAt: completedAt,
                leaseOwner: null,
                leaseExpiresAt: null,
                recoveryMessage: null,
                failureCode: null,
                updatedAt: completedAt,
              }
            : {
                status: "needs_attention",
                transportState: result.code === "runtime_transport_failed" ? "failed" : "unknown",
                safetyState: result.code === "runtime_safety_failed" ? "failed" : "unknown",
                leaseOwner: null,
                leaseExpiresAt: null,
                recoveryMessage: result.message,
                failureCode: result.code,
                configRevision: claim.admittedRuntimeRevision ?? configRevision,
                updatedAt: completedAt,
              },
        )
        .where(
          and(
            eq(operatorRuntimes.id, claim.runtime.id),
            eq(operatorRuntimes.leaseOwner, leaseOwner),
          ),
        )
        .returning();

      if (!updated) {
        throw new FounderOperatorRuntimeInvariantError("Operator runtime result was superseded.");
      }

      await tx
        .update(operatorPreparations)
        .set({
          status: result.ok ? "ready" : "needs_attention",
          completedAt: result.ok ? completedAt : null,
          recoveryMessage: result.ok ? null : result.message,
          updatedAt: completedAt,
        })
        .where(eq(operatorPreparations.operatorId, operator.id));

      if (!result.ok && updated.configRevision) {
        const applicationRevision = readFounderApplicationRevision({
          env: dependencies.env,
        });
        if (applicationRevision) {
          await persistFounderOwnerPreviewHoldInTransaction(tx, {
            userId,
            operatorId: operator.id,
            applicationRevision,
            runtimeRevision: updated.configRevision,
            affectedCapabilities: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
            evidenceDigests: [
              runtimeFailureEvidenceDigest({
                userId,
                operatorId: operator.id,
                applicationRevision,
                runtimeRevision: updated.configRevision,
                attemptedRuntimeRevision: configRevision,
                failureCode: result.code,
                observedAt: completedAt,
              }),
            ],
            decidedAt: completedAt,
          });
        }
      }

      const [row] = await tx
        .select({
          operator: operators,
          preparation: operatorPreparations,
          runtime: operatorRuntimes,
        })
        .from(operators)
        .innerJoin(operatorPreparations, eq(operatorPreparations.operatorId, operators.id))
        .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
        .where(and(eq(operators.id, operator.id), eq(operators.userId, userId)))
        .limit(1);
      return row;
    });

    if (!projection) {
      throw new FounderOperatorRuntimeInvariantError("Operator runtime could not be reloaded.");
    }

    const refreshed = await getFounderOperatorForUser(userId, {
      createConnection: () => connection,
    });
    if (!refreshed?.runtime) {
      throw new FounderOperatorRuntimeInvariantError("Operator runtime projection is unavailable.");
    }

    return { operator: refreshed, runtime: refreshed.runtime, changed: true };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function runtimeFailureEvidenceDigest(input: {
  userId: string;
  operatorId: string;
  applicationRevision: string;
  runtimeRevision: string;
  attemptedRuntimeRevision: string;
  failureCode: FounderOperatorRuntimeFailureCode;
  observedAt: Date;
}): `sha256:${string}` {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        schemaVersion: "bruno.owner-preview-runtime-failure.v1",
        userId: input.userId,
        operatorId: input.operatorId,
        applicationRevision: input.applicationRevision,
        runtimeRevision: input.runtimeRevision,
        attemptedRuntimeRevision: input.attemptedRuntimeRevision,
        failureCode: input.failureCode,
        observedAt: input.observedAt.toISOString(),
      }),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

export async function getFounderOperatorRuntimeForUser(
  userId: string,
  dependencies: Pick<FounderOperatorRuntimeDependencies, "createConnection"> = {},
): Promise<FounderOperatorRuntimeDto | null> {
  const operator = await getFounderOperatorForUser(userId, dependencies);
  return operator?.runtime ?? null;
}

export function buildFounderOperatorNativeLaunchSpec(input: {
  operatorId: string;
  timezone: string;
  configRevision: string;
  apiServerKey: string;
  image?: string;
  requestId?: string;
}): NativeAgentLaunchSpec {
  return {
    version: AGENT_LAUNCH_SPEC_VERSION,
    requestId: input.requestId ?? randomUUID(),
    agent: {
      id: input.operatorId,
      name: "Bruno.Ai Operator",
      templateKey: "founder_operator",
      templateVersion: "1.0.0",
      configRevision: input.configRevision,
    },
    image: { ref: input.image?.trim() || DEFAULT_HERMES_WORKLOAD_IMAGE },
    model: { provider: "hermes", model: "configured-by-hermes" },
    schedule: { mode: "manual", cron: null, timezone: input.timezone },
    prompt: {
      soul: "You are the Bruno.Ai Operator. Work only within the Founder-approved workspace and ask before consequential external effects.",
    },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 25,
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: { kind: "inline", apiServerKey: input.apiServerKey },
  };
}

export class FounderOperatorRuntimeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FounderOperatorRuntimeInvariantError";
  }
}

export function createFounderOperatorFilesystemAdapter(input: {
  stateRoot?: string;
}): FounderOperatorRuntimeAdapter {
  const stateRoot =
    input.stateRoot ??
    process.env.BRUNO_OPERATOR_RUNTIME_STATE_ROOT ??
    process.env.BRUNO_HERMES_STATE_ROOT ??
    DEFAULT_HERMES_STATE_ROOT;

  return {
    async prepare(runtime) {
      const root = join(stateRoot, runtime.operatorId);
      const markerPath = join(root, "hermes", "bruno-operator-runtime.json");
      try {
        const { prepareHermesState } = await import("@/src/runner-service/hermes-projection");
        await prepareHermesState(runtime.operatorId, { stateRoot });
        if (runtime.launchSpec) {
          const configPath = join(root, "hermes", "config.yaml");
          await ensureNativeHermesConfig(configPath);
          const { projectHermesHome } = await import("@/src/runner-service/hermes-projection");
          await projectHermesHome(runtime.launchSpec, { stateRoot });
        }
        const marker = `${JSON.stringify({
          contractVersion: SAFETY_CONTRACT_VERSION,
          operatorId: runtime.operatorId,
          runtimeIdentity: runtime.runtimeIdentity,
          configRevision: runtime.configRevision,
          telegramRequired: false,
          providerConfigOwner: "hermes",
          workspace: "../workspace",
        })}\n`;
        try {
          const existing = await lstat(markerPath);
          if (!existing.isFile() || existing.nlink !== 1) throw new Error("unsafe marker");
          if ((await readFile(markerPath, "utf8")) !== marker) {
            await writeFile(markerPath, marker, { encoding: "utf8", flag: "w" });
          }
          await chmod(markerPath, 0o600);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
          await writeFile(markerPath, marker, { encoding: "utf8", mode: 0o600, flag: "wx" });
        }
        return {
          ok: true,
          runtimeIdentity: runtime.runtimeIdentity,
          transportState: "connected",
          safetyState: "verified",
        };
      } catch {
        return {
          ok: false,
          code: "runtime_prepare_failed",
          message: "Bruno could not prepare the private Operator workspace. Try again.",
        };
      }
    },
    async verify(runtime) {
      const markerPath = join(
        stateRoot,
        runtime.operatorId,
        "hermes",
        "bruno-operator-runtime.json",
      );
      try {
        const stats = await lstat(markerPath);
        if (!stats.isFile() || stats.nlink !== 1) throw new Error("unsafe marker");
        const parsed = JSON.parse(await readFile(markerPath, "utf8")) as Record<string, unknown>;
        if (
          parsed.contractVersion !== SAFETY_CONTRACT_VERSION ||
          parsed.operatorId !== runtime.operatorId ||
          parsed.runtimeIdentity !== runtime.runtimeIdentity ||
          parsed.configRevision !== runtime.configRevision ||
          parsed.telegramRequired !== false ||
          parsed.providerConfigOwner !== "hermes"
        ) {
          throw new Error("invalid marker");
        }
        if (runtime.launchSpec) {
          const revision = JSON.parse(
            await readFile(
              join(stateRoot, runtime.operatorId, "hermes", "bruno-config-revision.json"),
              "utf8",
            ),
          ) as Record<string, unknown>;
          if (
            revision.version !== runtime.launchSpec.version ||
            revision.agentId !== runtime.operatorId ||
            revision.configRevision !== runtime.configRevision ||
            revision.image !== runtime.launchSpec.image.ref
          ) {
            throw new Error("native launch revision mismatch");
          }
        }
        return {
          ok: true,
          runtimeIdentity: runtime.runtimeIdentity,
          transportState: "connected",
          safetyState: "verified",
        };
      } catch {
        return {
          ok: false,
          code: "runtime_verification_failed",
          message: "Bruno could not verify the private Operator workspace. Try again.",
        };
      }
    },
  };
}

async function lockOperator(tx: OperatorRuntimeTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:operator-runtime:${operatorId}`}, 0))`,
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function ensureNativeHermesConfig(configPath: string): Promise<void> {
  try {
    const stats = await lstat(configPath);
    if (!stats.isFile() || stats.nlink !== 1) throw new Error("unsafe Hermes config");
    return;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }

  await writeFile(configPath, "model:\n  provider: hermes\n  default: configured-by-hermes\n", {
    encoding: "utf8",
    mode: 0o644,
    flag: "wx",
  });
}
