import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export type OperatorSecretKeyring = {
  activeVersion: string;
  keys: Map<string, Buffer>;
};

export type EncryptedOperatorSecret = {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
};

export class OperatorSecretKeyringError extends Error {
  constructor(message = "Operator secret keyring is not configured safely.") {
    super(message);
    this.name = "OperatorSecretKeyringError";
  }
}

export class OperatorSecretDecryptionError extends Error {
  constructor() {
    super("Operator secret could not be decrypted.");
    this.name = "OperatorSecretDecryptionError";
  }
}

export function parseOperatorSecretKeyring(
  env: Record<string, string | undefined> = process.env,
): OperatorSecretKeyring {
  const activeVersion = env.BRUNO_CONNECTION_SECRET_ACTIVE_KEY_VERSION?.trim();
  const serializedKeys = env.BRUNO_CONNECTION_SECRET_KEYS_JSON?.trim();
  if (!activeVersion) {
    throw new OperatorSecretKeyringError(
      "BRUNO_CONNECTION_SECRET_ACTIVE_KEY_VERSION is required for connection secret writes.",
    );
  }
  if (!serializedKeys) {
    throw new OperatorSecretKeyringError(
      "BRUNO_CONNECTION_SECRET_KEYS_JSON is required for connection secret writes.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serializedKeys);
  } catch {
    throw new OperatorSecretKeyringError("BRUNO_CONNECTION_SECRET_KEYS_JSON must be valid JSON.");
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) {
    throw new OperatorSecretKeyringError(
      "BRUNO_CONNECTION_SECRET_KEYS_JSON must be a JSON object of key version to key material.",
    );
  }

  const keys = new Map<string, Buffer>();
  for (const [version, rawKey] of Object.entries(parsed)) {
    if (!version.trim() || /[\s"'`$;&|<>\\]/.test(version)) {
      throw new OperatorSecretKeyringError("Connection secret key versions must be safe tokens.");
    }
    if (typeof rawKey !== "string" || !rawKey.trim()) {
      throw new OperatorSecretKeyringError("Connection secret key material must be non-empty.");
    }
    const key = Buffer.from(rawKey.trim(), "base64url");
    if (key.length !== KEY_BYTES) {
      throw new OperatorSecretKeyringError("Connection secret keys must decode to 32 bytes.");
    }
    keys.set(version.trim(), key);
  }
  if (keys.size === 0 || !keys.has(activeVersion)) {
    throw new OperatorSecretKeyringError(
      "BRUNO_CONNECTION_SECRET_ACTIVE_KEY_VERSION must exist in BRUNO_CONNECTION_SECRET_KEYS_JSON.",
    );
  }
  return { activeVersion, keys };
}

export function encryptOperatorSecret(input: {
  value: string;
  scope: string;
  keyring: OperatorSecretKeyring;
  randomBytes?: (size: number) => Buffer;
}): EncryptedOperatorSecret {
  const key = input.keyring.keys.get(input.keyring.activeVersion);
  if (!key) throw new OperatorSecretKeyringError();
  const iv = (input.randomBytes ?? randomBytes)(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(buildAad(input.scope, input.keyring.activeVersion));
  const ciphertext = Buffer.concat([cipher.update(input.value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: input.keyring.activeVersion,
  };
}

export function decryptOperatorSecret(input: {
  encrypted: EncryptedOperatorSecret;
  scope: string;
  keyring: OperatorSecretKeyring;
}): string {
  const key = input.keyring.keys.get(input.encrypted.keyVersion);
  if (!key) throw new OperatorSecretDecryptionError();
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(input.encrypted.iv, "base64url"));
    decipher.setAAD(buildAad(input.scope, input.encrypted.keyVersion));
    decipher.setAuthTag(Buffer.from(input.encrypted.authTag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.encrypted.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new OperatorSecretDecryptionError();
  }
}

export function digestOperatorSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function buildAad(scope: string, keyVersion: string): Buffer {
  return Buffer.from(`bruno.operator.connection.${scope}.${keyVersion}`, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
