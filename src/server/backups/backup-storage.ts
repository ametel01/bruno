import "server-only";

import { createHash, createHmac } from "node:crypto";
import { EnvValidationError } from "@/src/env/validation";
import type { BackupStatus } from "@/src/server/backups/backup-manifest";

export type BackupStorageFailure = {
  ok: false;
  status: Extract<BackupStatus, "failed">;
  message: string;
};

export type BackupStorageUploadResult =
  | { ok: true; storageUri: string; byteLength: number }
  | BackupStorageFailure;

export type BackupStorageDownloadResult =
  | { ok: true; storageUri: string; body: Uint8Array; contentType: string | null }
  | BackupStorageFailure;

export type BackupStorageDeleteResult = { ok: true } | BackupStorageFailure;
export type BackupStoragePresenceResult = { ok: true; exists: boolean } | BackupStorageFailure;
export type BackupStorageDeletionSafetyResult =
  | { ok: true; versioning: "disabled" }
  | BackupStorageFailure;

export type BackupObjectStorage = {
  upload(input: BackupStorageUploadInput): Promise<BackupStorageUploadResult>;
  download(input: BackupStorageDownloadInput): Promise<BackupStorageDownloadResult>;
};

export type DeletableBackupObjectStorage = BackupObjectStorage & {
  delete(input: BackupStorageDownloadInput): Promise<BackupStorageDeleteResult>;
  exists(input: BackupStorageDownloadInput): Promise<BackupStoragePresenceResult>;
  verifyDeletionSafety(): Promise<BackupStorageDeletionSafetyResult>;
};

export type BackupStorageUploadInput = {
  key: string;
  body: Uint8Array;
  contentType?: string;
};

export type BackupStorageDownloadInput = {
  key: string;
};

export type S3CompatibleBackupStorageConfig = {
  endpointUrl: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

type FetchImplementation = typeof fetch;
const DEFAULT_S3_REQUEST_TIMEOUT_MS = 10_000;

type StoredBackupArtifact = {
  body: Uint8Array;
  contentType: string | null;
};

const STORAGE_ENV_NAMES = [
  "BRUNO_BACKUP_STORAGE_ENDPOINT_URL",
  "BRUNO_BACKUP_STORAGE_BUCKET",
  "BRUNO_BACKUP_STORAGE_REGION",
  "BRUNO_BACKUP_STORAGE_ACCESS_KEY_ID",
  "BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY",
] as const;

const SAFE_UPLOAD_FAILURE_MESSAGE =
  "Backup artifact upload failed. Check object storage configuration, credentials, permissions, and bucket availability.";
const SAFE_DOWNLOAD_FAILURE_MESSAGE =
  "Backup artifact download failed. Check object storage configuration, credentials, permissions, and artifact availability.";

export function readBackupStorageConfig(
  input: Record<string, string | undefined> = process.env,
): S3CompatibleBackupStorageConfig | null {
  const hasAnySetting = STORAGE_ENV_NAMES.some((name) => input[name] !== undefined);

  if (!hasAnySetting) {
    return null;
  }

  const endpointUrl = readRequiredSetting(input, "BRUNO_BACKUP_STORAGE_ENDPOINT_URL");
  const bucket = readRequiredSetting(input, "BRUNO_BACKUP_STORAGE_BUCKET");
  const region = readRequiredSetting(input, "BRUNO_BACKUP_STORAGE_REGION");
  const accessKeyId = readRequiredSetting(input, "BRUNO_BACKUP_STORAGE_ACCESS_KEY_ID");
  const secretAccessKey = readRequiredSetting(input, "BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY");

  return {
    endpointUrl: validateBackupStorageEndpoint(endpointUrl),
    bucket: validateBackupStorageBucket(bucket),
    region: validateBackupStorageRegion(region),
    accessKeyId,
    secretAccessKey,
  };
}

export function createBackupObjectStorage(
  config = readBackupStorageConfig(),
): DeletableBackupObjectStorage | null {
  return config ? new S3CompatibleBackupObjectStorage(config) : null;
}

/**
 * Recovery Archives must live on managed object storage whose TLS hostname proves
 * that it is independent from the Founder Operator Droplet. Arbitrary S3-compatible
 * endpoints remain valid for ordinary backups, but cannot satisfy this boundary.
 */
export function assertIndependentRecoveryArchiveStorage(
  config: S3CompatibleBackupStorageConfig,
): void {
  const hostname = new URL(config.endpointUrl).hostname.toLowerCase();
  const managedProviderHost = [
    /(^|\.)digitaloceanspaces\.com$/,
    /(^|\.)s3([.-][a-z0-9-]+)*\.amazonaws\.com$/,
    /(^|\.)r2\.cloudflarestorage\.com$/,
    /(^|\.)backblazeb2\.com$/,
  ].some((pattern) => pattern.test(hostname));
  if (!managedProviderHost) {
    throw new EnvValidationError([
      "BRUNO_BACKUP_STORAGE_ENDPOINT_URL must identify supported managed object storage independent from the Operator Droplet for Recovery Archives.",
    ]);
  }
}

export function backupStorageFailure(
  operation: "upload" | "download" | "delete" | "exists" | "deletion_safety",
): BackupStorageFailure {
  return {
    ok: false,
    status: "failed",
    message: operation === "upload" ? SAFE_UPLOAD_FAILURE_MESSAGE : SAFE_DOWNLOAD_FAILURE_MESSAGE,
  };
}

export class FakeBackupObjectStorage implements DeletableBackupObjectStorage {
  private readonly artifacts = new Map<string, StoredBackupArtifact>();

  constructor(private readonly bucket = "bruno-test-backups") {}

  async upload(input: BackupStorageUploadInput): Promise<BackupStorageUploadResult> {
    const keyResult = validateBackupArtifactKey(input.key);

    if (!keyResult.ok) {
      return backupStorageFailure("upload");
    }

    this.artifacts.set(keyResult.key, {
      body: new Uint8Array(input.body),
      contentType: input.contentType ?? null,
    });

    return {
      ok: true,
      storageUri: buildBackupStorageUri(this.bucket, keyResult.key),
      byteLength: input.body.byteLength,
    };
  }

  async download(input: BackupStorageDownloadInput): Promise<BackupStorageDownloadResult> {
    const keyResult = validateBackupArtifactKey(input.key);

    if (!keyResult.ok) {
      return backupStorageFailure("download");
    }

    const artifact = this.artifacts.get(keyResult.key);

    if (!artifact) {
      return backupStorageFailure("download");
    }

    return {
      ok: true,
      storageUri: buildBackupStorageUri(this.bucket, keyResult.key),
      body: new Uint8Array(artifact.body),
      contentType: artifact.contentType,
    };
  }

  async delete(input: BackupStorageDownloadInput): Promise<BackupStorageDeleteResult> {
    const keyResult = validateBackupArtifactKey(input.key);
    if (!keyResult.ok) return backupStorageFailure("delete");
    this.artifacts.delete(keyResult.key);
    return { ok: true };
  }

  async exists(input: BackupStorageDownloadInput): Promise<BackupStoragePresenceResult> {
    const keyResult = validateBackupArtifactKey(input.key);
    if (!keyResult.ok) return backupStorageFailure("exists");
    return { ok: true, exists: this.artifacts.has(keyResult.key) };
  }

  async verifyDeletionSafety(): Promise<BackupStorageDeletionSafetyResult> {
    return { ok: true, versioning: "disabled" };
  }
}

export class S3CompatibleBackupObjectStorage implements DeletableBackupObjectStorage {
  private readonly endpoint: URL;
  private readonly fetchImplementation: FetchImplementation;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly config: S3CompatibleBackupStorageConfig,
    dependencies: { fetchImplementation?: FetchImplementation; requestTimeoutMs?: number } = {},
  ) {
    this.endpoint = new URL(config.endpointUrl);
    this.fetchImplementation = dependencies.fetchImplementation ?? fetch;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? DEFAULT_S3_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0) {
      throw new Error("S3-compatible request timeout must be positive and finite.");
    }
  }

  async upload(input: BackupStorageUploadInput): Promise<BackupStorageUploadResult> {
    const keyResult = validateBackupArtifactKey(input.key);

    if (!keyResult.ok) {
      return backupStorageFailure("upload");
    }

    const body = new Uint8Array(input.body);
    const request = this.createSignedRequest({
      method: "PUT",
      key: keyResult.key,
      body,
      contentType: input.contentType ?? "application/octet-stream",
    });

    try {
      const response = await this.executeRequest(request, async (value) => value);

      if (!response.ok) {
        return backupStorageFailure("upload");
      }

      return {
        ok: true,
        storageUri: buildBackupStorageUri(this.config.bucket, keyResult.key),
        byteLength: body.byteLength,
      };
    } catch {
      return backupStorageFailure("upload");
    }
  }

  async download(input: BackupStorageDownloadInput): Promise<BackupStorageDownloadResult> {
    const keyResult = validateBackupArtifactKey(input.key);

    if (!keyResult.ok) {
      return backupStorageFailure("download");
    }

    const request = this.createSignedRequest({
      method: "GET",
      key: keyResult.key,
      body: new Uint8Array(),
    });

    try {
      const response = await this.executeRequest(request, async (value) => ({
        ok: value.ok,
        body: await value.arrayBuffer(),
        contentType: value.headers.get("content-type"),
      }));

      if (!response.ok) {
        return backupStorageFailure("download");
      }

      return {
        ok: true,
        storageUri: buildBackupStorageUri(this.config.bucket, keyResult.key),
        body: new Uint8Array(response.body),
        contentType: response.contentType,
      };
    } catch {
      return backupStorageFailure("download");
    }
  }

  async delete(input: BackupStorageDownloadInput): Promise<BackupStorageDeleteResult> {
    const keyResult = validateBackupArtifactKey(input.key);
    if (!keyResult.ok) return backupStorageFailure("delete");
    try {
      const response = await this.executeRequest(
        this.createSignedRequest({ method: "DELETE", key: keyResult.key, body: new Uint8Array() }),
        async (value) => value,
      );
      return response.ok ? { ok: true } : backupStorageFailure("delete");
    } catch {
      return backupStorageFailure("delete");
    }
  }

  async exists(input: BackupStorageDownloadInput): Promise<BackupStoragePresenceResult> {
    const keyResult = validateBackupArtifactKey(input.key);
    if (!keyResult.ok) return backupStorageFailure("exists");
    try {
      const response = await this.executeRequest(
        this.createSignedRequest({ method: "HEAD", key: keyResult.key, body: new Uint8Array() }),
        async (value) => value,
      );
      if (response.status === 404) return { ok: true, exists: false };
      return response.ok ? { ok: true, exists: true } : backupStorageFailure("exists");
    } catch {
      return backupStorageFailure("exists");
    }
  }

  async verifyDeletionSafety(): Promise<BackupStorageDeletionSafetyResult> {
    try {
      const response = await this.executeRequest(
        this.createSignedRequest({
          method: "GET",
          key: "",
          query: "versioning=",
          body: new Uint8Array(),
        }),
        async (value) => ({ ok: value.ok, body: await value.text() }),
      );
      if (!response.ok) return backupStorageFailure("deletion_safety");
      if (!isUnversionedBucketConfiguration(response.body)) {
        return backupStorageFailure("deletion_safety");
      }
      return { ok: true, versioning: "disabled" };
    } catch {
      return backupStorageFailure("deletion_safety");
    }
  }

  private async executeRequest<T>(
    request: Request,
    readResponse: (response: Response) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("S3-compatible request deadline exceeded.")),
      this.requestTimeoutMs,
    );
    try {
      const response = await this.fetchImplementation(
        new Request(request, { signal: controller.signal }),
      );
      return await readResponse(response);
    } finally {
      clearTimeout(timeout);
    }
  }

  private createSignedRequest(input: {
    method: "DELETE" | "GET" | "HEAD" | "PUT";
    key: string;
    body: Uint8Array;
    contentType?: string;
    query?: string;
  }): Request {
    const url = new URL(this.endpoint);
    url.pathname = joinUrlPath(url.pathname, this.config.bucket, input.key);
    url.search = input.query ? `?${input.query}` : "";

    const now = new Date();
    const amzDate = toAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(input.body);
    const host = url.host;
    const headers = new Headers({
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    });

    if (input.contentType) {
      headers.set("content-type", input.contentType);
    }

    const signedHeaders = [...headers.keys()].sort().join(";");
    const canonicalHeaders = [...headers.keys()]
      .sort()
      .map((name) => `${name}:${headers.get(name)?.trim() ?? ""}\n`)
      .join("");
    const canonicalRequest = [
      input.method,
      url.pathname,
      input.query ?? "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = hmacHex(
      getSignatureKey(this.config.secretAccessKey, dateStamp, this.config.region),
      stringToSign,
    );

    headers.set(
      "authorization",
      `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    );

    const requestInit: RequestInit = {
      method: input.method,
      headers,
    };

    if (input.method === "PUT") {
      requestInit.body = copyToArrayBuffer(input.body);
    }

    return new Request(url, requestInit);
  }
}

export function buildBackupStorageUri(bucket: string, key: string): string {
  const keyResult = validateBackupArtifactKey(key);

  if (!keyResult.ok) {
    throw new Error("Backup storage key is invalid.");
  }

  return `s3://${validateBackupStorageBucket(bucket)}/${keyResult.key}`;
}

function readRequiredSetting(
  input: Record<string, string | undefined>,
  name: (typeof STORAGE_ENV_NAMES)[number],
): string {
  const value = input[name]?.trim();

  if (!value) {
    throw new EnvValidationError([`${name} is required when backup object storage is configured.`]);
  }

  return value;
}

function validateBackupStorageEndpoint(value: string): string {
  let parsed: URL;

  try {
    parsed = new URL(value);
  } catch {
    throw new EnvValidationError(["BRUNO_BACKUP_STORAGE_ENDPOINT_URL must be a valid URL."]);
  }

  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new EnvValidationError([
      "BRUNO_BACKUP_STORAGE_ENDPOINT_URL must not include credentials, query strings, or fragments.",
    ]);
  }

  if (parsed.protocol !== "https:" && !isLoopbackHttp(parsed)) {
    throw new EnvValidationError([
      "BRUNO_BACKUP_STORAGE_ENDPOINT_URL must use HTTPS unless it targets a loopback host for local tests.",
    ]);
  }

  parsed.pathname = trimTrailingSlash(parsed.pathname);
  return parsed.toString().replace(/\/$/, "");
}

function validateBackupStorageBucket(value: string): string {
  if (
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value) ||
    value.includes("..") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(value)
  ) {
    throw new EnvValidationError([
      "BRUNO_BACKUP_STORAGE_BUCKET must be a valid S3-compatible bucket name.",
    ]);
  }

  return value;
}

function validateBackupStorageRegion(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value)) {
    throw new EnvValidationError([
      "BRUNO_BACKUP_STORAGE_REGION must contain only lowercase letters, numbers, and hyphens.",
    ]);
  }

  return value;
}

function validateBackupArtifactKey(key: string): { ok: true; key: string } | { ok: false } {
  const normalizedKey = key.trim();

  if (
    normalizedKey.length === 0 ||
    normalizedKey.length > 1024 ||
    normalizedKey.startsWith("/") ||
    normalizedKey.includes("..") ||
    hasControlCharacter(normalizedKey)
  ) {
    return { ok: false };
  }

  return { ok: true, key: normalizedKey };
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);

    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) {
      return true;
    }
  }

  return false;
}

function isLoopbackHttp(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "::1" || url.hostname === "localhost")
  );
}

function isUnversionedBucketConfiguration(value: string): boolean {
  const withoutDeclaration = value
    .trim()
    .replace(/^<\?xml\s+version="1\.0"(?:\s+encoding="UTF-8")?\s*\?>\s*/, "");
  return /^<VersioningConfiguration(?: xmlns="http:\/\/s3\.amazonaws\.com\/doc\/2006-03-01\/")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)$/.test(
    withoutDeclaration,
  );
}

function trimTrailingSlash(pathname: string): string {
  return pathname === "/" ? "" : pathname.replace(/\/+$/, "");
}

function joinUrlPath(basePath: string, bucket: string, key: string): string {
  const encodedSegments = [bucket, ...key.split("/")].map((segment) => encodeURIComponent(segment));
  const normalizedBasePath = trimTrailingSlash(basePath);
  return `${normalizedBasePath}/${encodedSegments.join("/")}`;
}

function toAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function copyToArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(value);
  return buffer;
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key: Buffer, value: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function getSignatureKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}
