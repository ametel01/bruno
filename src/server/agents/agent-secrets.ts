import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentSecrets, agents } from "@/src/server/db/schema";
import type * as schema from "@/src/server/db/schema";

export const AGENT_SECRET_KINDS = [
  "openrouter_api_key",
  "telegram_bot_token",
  "telegram_allowed_users",
  "api_server_key",
] as const;

export const USER_MANAGED_AGENT_SECRET_KINDS = [
  "openrouter_api_key",
  "telegram_bot_token",
  "telegram_allowed_users",
] as const;

export type AgentSecretKind = (typeof AGENT_SECRET_KINDS)[number];
export type UserManagedAgentSecretKind = (typeof USER_MANAGED_AGENT_SECRET_KINDS)[number];

export type AgentSecretStatus = {
  kind: AgentSecretKind;
  configured: boolean;
  fingerprint: string | null;
  status: "active" | "revoked" | null;
  createdAt: string | null;
  updatedAt: string | null;
  rotatedAt: string | null;
  revokedAt: string | null;
};

export type AgentSecretReferenceMap = Record<string, { kind: "vault"; ref: string }>;

export type AgentSecretMutationResult =
  | {
      ok: true;
      secret: AgentSecretStatus;
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found" | "validation_failed";
      issues?: Array<{ field: string; message: string }>;
    };

export type AgentSecretListResult =
  | {
      ok: true;
      secrets: AgentSecretStatus[];
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id" | "agent_not_found";
    };

type AgentSecretsTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

type AgentSecretRow = typeof agentSecrets.$inferSelect;

type AgentSecretKeyring = {
  activeVersion: string;
  keys: Map<string, Buffer>;
};

type AgentSecretDependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  randomBytes?: (size: number) => Buffer;
};

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class AgentSecretKeyringError extends Error {
  constructor(message = "Agent secret keyring is not configured safely.") {
    super(message);
    this.name = "AgentSecretKeyringError";
  }
}

export class AgentSecretDecryptionError extends Error {
  constructor() {
    super("Agent secret could not be decrypted.");
    this.name = "AgentSecretDecryptionError";
  }
}

export class AgentSecretPersistenceError extends Error {
  constructor(cause?: unknown) {
    super("Agent secret persistence failed.");
    this.name = "AgentSecretPersistenceError";
    this.cause = cause;
  }
}

export function isAgentSecretKind(value: unknown): value is AgentSecretKind {
  return typeof value === "string" && AGENT_SECRET_KINDS.includes(value as AgentSecretKind);
}

export function isUserManagedAgentSecretKind(value: unknown): value is UserManagedAgentSecretKind {
  return (
    typeof value === "string" &&
    USER_MANAGED_AGENT_SECRET_KINDS.includes(value as UserManagedAgentSecretKind)
  );
}

export function parseAgentSecretKeyring(
  env: Record<string, string | undefined> = process.env,
): AgentSecretKeyring {
  const activeVersion = env.AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION?.trim();
  const serializedKeys = env.AGENTBAY_AGENT_SECRET_KEYS_JSON?.trim();

  if (!activeVersion) {
    throw new AgentSecretKeyringError(
      "AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION is required for agent secret writes.",
    );
  }

  if (!serializedKeys) {
    throw new AgentSecretKeyringError(
      "AGENTBAY_AGENT_SECRET_KEYS_JSON is required for agent secret writes.",
    );
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(serializedKeys);
  } catch {
    throw new AgentSecretKeyringError("AGENTBAY_AGENT_SECRET_KEYS_JSON must be valid JSON.");
  }

  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new AgentSecretKeyringError(
      "AGENTBAY_AGENT_SECRET_KEYS_JSON must be a JSON object of key version to key material.",
    );
  }

  const keys = new Map<string, Buffer>();

  for (const [version, rawKey] of Object.entries(parsed)) {
    const normalizedVersion = version.trim();

    if (!normalizedVersion || /[\s"'`$;&|<>\\]/.test(normalizedVersion)) {
      throw new AgentSecretKeyringError("Agent secret key versions must be non-empty safe tokens.");
    }

    if (typeof rawKey !== "string" || !rawKey.trim()) {
      throw new AgentSecretKeyringError("Agent secret key material must be non-empty strings.");
    }

    const key = decodeBase64Key(rawKey.trim());

    if (key.length !== AES_256_KEY_BYTES) {
      throw new AgentSecretKeyringError("Agent secret keys must decode to 32 bytes.");
    }

    keys.set(normalizedVersion, key);
  }

  if (keys.size === 0 || !keys.has(activeVersion)) {
    throw new AgentSecretKeyringError(
      "AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION must exist in AGENTBAY_AGENT_SECRET_KEYS_JSON.",
    );
  }

  return { activeVersion, keys };
}

export async function listAgentSecretStatusesForUser(
  userId: string,
  agentId: string,
  dependencies: Pick<AgentSecretDependencies, "createConnection"> = {},
): Promise<AgentSecretListResult> {
  const agentIdValidation = validateAgentId(agentId);

  if (!agentIdValidation.ok) {
    return agentIdValidation;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const agentExists = await selectOwnedActiveAgent(tx, {
        agentId: agentIdValidation.agentId,
        userId,
      });

      if (!agentExists) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      const rows = await selectActiveSecretRows(tx, agentIdValidation.agentId);

      return { ok: true, secrets: buildSecretStatuses(rows) } as const;
    });
  } catch (error) {
    throw new AgentSecretPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function replaceAgentSecretForUser(
  userId: string,
  agentId: string,
  input: { kind: AgentSecretKind; value: unknown },
  dependencies: AgentSecretDependencies = {},
): Promise<AgentSecretMutationResult> {
  const agentIdValidation = validateAgentId(agentId);

  if (!agentIdValidation.ok) {
    return agentIdValidation;
  }

  const valueValidation = validateAgentSecretValue(input.kind, input.value);

  if (!valueValidation.ok) {
    return { ok: false, reason: "validation_failed", issues: valueValidation.issues };
  }

  const keyring = parseAgentSecretKeyring(dependencies.env);
  const activeKey = keyring.keys.get(keyring.activeVersion);

  if (!activeKey) {
    throw new AgentSecretKeyringError();
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  const encrypted = encryptAgentSecretValue({
    agentId: agentIdValidation.agentId,
    kind: input.kind,
    keyVersion: keyring.activeVersion,
    key: activeKey,
    value: valueValidation.value,
    randomBytes: dependencies.randomBytes ?? randomBytes,
  });

  try {
    return await connection.db.transaction(async (tx) => {
      const agentExists = await selectOwnedActiveAgent(tx, {
        agentId: agentIdValidation.agentId,
        userId,
      });

      if (!agentExists) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      const existingRows = await selectActiveSecretRows(tx, agentIdValidation.agentId, input.kind);

      await revokeActiveSecretRows(tx, {
        agentId: agentIdValidation.agentId,
        kind: input.kind,
        now,
      });

      const [created] = await tx
        .insert(agentSecrets)
        .values({
          agentId: agentIdValidation.agentId,
          kind: input.kind,
          ciphertext: encrypted.ciphertext,
          iv: encrypted.iv,
          authTag: encrypted.authTag,
          keyVersion: keyring.activeVersion,
          fingerprint: encrypted.fingerprint,
          status: "active",
          createdAt: now,
          updatedAt: now,
          rotatedAt: existingRows.length > 0 ? now : null,
          revokedAt: null,
        })
        .returning();

      if (!created) {
        throw new Error("Agent secret insert returned no rows.");
      }

      return { ok: true, secret: toSecretStatus(created) } as const;
    });
  } catch (error) {
    throw new AgentSecretPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function generateApiServerKeyForUser(
  userId: string,
  agentId: string,
  dependencies: AgentSecretDependencies = {},
): Promise<AgentSecretMutationResult> {
  const generated = createGeneratedApiServerKey(dependencies.randomBytes ?? randomBytes);

  return replaceAgentSecretForUser(
    userId,
    agentId,
    { kind: "api_server_key", value: generated },
    dependencies,
  );
}

export async function revokeAgentSecretForUser(
  userId: string,
  agentId: string,
  input: { kind: AgentSecretKind },
  dependencies: AgentSecretDependencies = {},
): Promise<AgentSecretMutationResult> {
  const agentIdValidation = validateAgentId(agentId);

  if (!agentIdValidation.ok) {
    return agentIdValidation;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    return await connection.db.transaction(async (tx) => {
      const agentExists = await selectOwnedActiveAgent(tx, {
        agentId: agentIdValidation.agentId,
        userId,
      });

      if (!agentExists) {
        return { ok: false, reason: "agent_not_found" } as const;
      }

      await revokeActiveSecretRows(tx, {
        agentId: agentIdValidation.agentId,
        kind: input.kind,
        now,
      });

      return { ok: true, secret: emptySecretStatus(input.kind) } as const;
    });
  } catch (error) {
    throw new AgentSecretPersistenceError(error);
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function revokeActiveAgentSecretsInTransaction(
  tx: AgentSecretsTransaction,
  input: { agentId: string; now: Date },
): Promise<void> {
  await tx
    .update(agentSecrets)
    .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
    .where(and(eq(agentSecrets.agentId, input.agentId), eq(agentSecrets.status, "active")));
}

export async function listActiveAgentSecretReferencesInTransaction(
  tx: AgentSecretsTransaction,
  agentId: string,
): Promise<AgentSecretReferenceMap> {
  const rows = await selectActiveSecretRows(tx, agentId);
  const references: AgentSecretReferenceMap = {};

  for (const row of rows) {
    references[row.kind] = {
      kind: "vault",
      ref: `agent-secret:${row.kind}:${row.fingerprint}`,
    };
  }

  return references;
}

export function decryptAgentSecretValueForTest(row: AgentSecretRow, keyring: AgentSecretKeyring) {
  return decryptAgentSecretValue(row, keyring);
}

function encryptAgentSecretValue(input: {
  agentId: string;
  kind: AgentSecretKind;
  keyVersion: string;
  key: Buffer;
  value: string;
  randomBytes: (size: number) => Buffer;
}): {
  ciphertext: string;
  iv: string;
  authTag: string;
  fingerprint: string;
} {
  const iv = input.randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, input.key, iv);

  cipher.setAAD(buildAad(input));

  const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: authTag.toString("base64url"),
    fingerprint: fingerprintAgentSecret(input.kind, input.value, input.key),
  };
}

function decryptAgentSecretValue(row: AgentSecretRow, keyring: AgentSecretKeyring): string {
  const key = keyring.keys.get(row.keyVersion);

  if (!key) {
    throw new AgentSecretDecryptionError();
  }

  try {
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, decodeBase64Value(row.iv));

    decipher.setAAD(
      buildAad({
        agentId: row.agentId,
        kind: row.kind,
        keyVersion: row.keyVersion,
      }),
    );
    decipher.setAuthTag(decodeBase64Value(row.authTag));

    return Buffer.concat([
      decipher.update(decodeBase64Value(row.ciphertext)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new AgentSecretDecryptionError();
  }
}

function fingerprintAgentSecret(kind: AgentSecretKind, value: string, key: Buffer): string {
  return createHmac("sha256", key)
    .update(kind)
    .update("\0")
    .update(value)
    .digest("hex")
    .slice(0, 16);
}

function validateAgentSecretValue(
  kind: AgentSecretKind,
  value: unknown,
):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      issues: Array<{ field: string; message: string }>;
    } {
  const normalized = normalizeSecretValue(kind, value);

  if (!normalized.ok) {
    return normalized;
  }

  if (hasControlCharacter(normalized.value)) {
    return {
      ok: false,
      issues: [{ field: "value", message: "Secret values must not contain control characters." }],
    };
  }

  if (kind === "openrouter_api_key" && !/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(normalized.value)) {
    return {
      ok: false,
      issues: [{ field: "value", message: "OpenRouter API key format is invalid." }],
    };
  }

  if (kind === "telegram_bot_token" && !/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(normalized.value)) {
    return {
      ok: false,
      issues: [{ field: "value", message: "Telegram bot token format is invalid." }],
    };
  }

  if (kind === "api_server_key" && !/^agb_agent_[A-Za-z0-9_-]{32,}$/.test(normalized.value)) {
    return {
      ok: false,
      issues: [{ field: "value", message: "Agent API server key format is invalid." }],
    };
  }

  return normalized;
}

function normalizeSecretValue(
  kind: AgentSecretKind,
  value: unknown,
):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      issues: Array<{ field: string; message: string }>;
    } {
  if (kind === "telegram_allowed_users") {
    return normalizeTelegramAllowedUsers(value);
  }

  if (typeof value !== "string") {
    return {
      ok: false,
      issues: [{ field: "value", message: "Secret value must be a string." }],
    };
  }

  const normalizedValue = value.trim();

  if (!normalizedValue) {
    return {
      ok: false,
      issues: [{ field: "value", message: "Secret value must not be blank." }],
    };
  }

  return { ok: true, value: normalizedValue };
}

function normalizeTelegramAllowedUsers(value: unknown):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
      issues: Array<{ field: string; message: string }>;
    } {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];

  if (rawValues.length === 0) {
    return {
      ok: false,
      issues: [
        { field: "value", message: "Telegram allowed users must be a comma-separated list." },
      ],
    };
  }

  const normalizedValues: string[] = [];

  for (const rawValue of rawValues) {
    const normalizedValue = String(rawValue).trim();

    if (!normalizedValue) {
      continue;
    }

    if (normalizedValue === "*" || !/^\d{1,20}$/.test(normalizedValue)) {
      return {
        ok: false,
        issues: [
          {
            field: "value",
            message: "Telegram allowed users must contain only numeric Telegram user IDs.",
          },
        ],
      };
    }

    normalizedValues.push(normalizedValue);
  }

  const uniqueValues = [...new Set(normalizedValues)];

  if (uniqueValues.length === 0) {
    return {
      ok: false,
      issues: [{ field: "value", message: "Telegram allowed users must not be blank." }],
    };
  }

  return { ok: true, value: uniqueValues.join(",") };
}

function createGeneratedApiServerKey(randomBytesFn: (size: number) => Buffer): string {
  return `agb_agent_${randomBytesFn(32).toString("base64url")}`;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}

function decodeBase64Key(value: string): Buffer {
  return decodeBase64Value(value);
}

function decodeBase64Value(value: string): Buffer {
  const normalized = value.trim();

  if (!BASE64URL_PATTERN.test(normalized.replace(/=+$/, ""))) {
    throw new AgentSecretKeyringError("Agent secret key material must be base64 encoded.");
  }

  return Buffer.from(normalized, "base64");
}

function buildAad(input: { agentId: string; kind: AgentSecretKind; keyVersion: string }): Buffer {
  return Buffer.from(`agent:${input.agentId}:kind:${input.kind}:version:${input.keyVersion}`);
}

async function selectOwnedActiveAgent(
  tx: AgentSecretsTransaction,
  input: { agentId: string; userId: string },
): Promise<boolean> {
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(
      and(eq(agents.id, input.agentId), eq(agents.userId, input.userId), isNull(agents.deletedAt)),
    )
    .limit(1);

  return Boolean(agent);
}

async function selectActiveSecretRows(
  tx: AgentSecretsTransaction,
  agentId: string,
  kind?: AgentSecretKind,
): Promise<AgentSecretRow[]> {
  return await tx
    .select()
    .from(agentSecrets)
    .where(
      and(
        eq(agentSecrets.agentId, agentId),
        eq(agentSecrets.status, "active"),
        ...(kind ? [eq(agentSecrets.kind, kind)] : []),
      ),
    );
}

async function revokeActiveSecretRows(
  tx: AgentSecretsTransaction,
  input: { agentId: string; kind: AgentSecretKind; now: Date },
): Promise<void> {
  await tx
    .update(agentSecrets)
    .set({ status: "revoked", revokedAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(agentSecrets.agentId, input.agentId),
        eq(agentSecrets.kind, input.kind),
        eq(agentSecrets.status, "active"),
      ),
    );
}

function buildSecretStatuses(rows: AgentSecretRow[]): AgentSecretStatus[] {
  const rowsByKind = new Map(rows.map((row) => [row.kind, row]));

  return AGENT_SECRET_KINDS.map((kind) => {
    const row = rowsByKind.get(kind);

    return row ? toSecretStatus(row) : emptySecretStatus(kind);
  });
}

function toSecretStatus(row: AgentSecretRow): AgentSecretStatus {
  return {
    kind: row.kind,
    configured: row.status === "active",
    fingerprint: row.fingerprint,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    rotatedAt: row.rotatedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

function emptySecretStatus(kind: AgentSecretKind): AgentSecretStatus {
  return {
    kind,
    configured: false,
    fingerprint: null,
    status: null,
    createdAt: null,
    updatedAt: null,
    rotatedAt: null,
    revokedAt: null,
  };
}

function validateAgentId(agentId: string):
  | {
      ok: true;
      agentId: string;
    }
  | {
      ok: false;
      reason: "missing_agent_id" | "malformed_agent_id";
    } {
  const normalizedAgentId = agentId.trim();

  if (!normalizedAgentId) {
    return { ok: false, reason: "missing_agent_id" };
  }

  if (!isValidAgentId(normalizedAgentId)) {
    return { ok: false, reason: "malformed_agent_id" };
  }

  return { ok: true, agentId: normalizedAgentId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeCompareAgentSecretFingerprint(left: string, right: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(left) || !/^[0-9a-f]{16}$/.test(right)) {
    return false;
  }

  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
