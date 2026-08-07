import "server-only";

import { createHash } from "node:crypto";

const REGISTRY_ORIGIN = "https://ghcr.io";
const REGISTRY_REPOSITORY = "ametel01/agentbay-hermes";
const REGISTRY_AUTH_URL = "https://ghcr.io/token";
const REGISTRY_SERVICE = "ghcr.io";
const REGISTRY_SCOPE = `repository:${REGISTRY_REPOSITORY}:pull`;
const IMAGE_REFERENCE_PATTERN = /^ghcr\.io\/ametel01\/agentbay-hermes@(sha256:[0-9a-f]{64})$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const EXPECTED_SOURCE = "https://github.com/ametel01/bruno";
const GITHUB_REPOSITORY = "ametel01/bruno";
const GITHUB_WORKFLOW_PATH = ".github/workflows/publish-agent-image.yml";
const GITHUB_WORKFLOW_PATH_AT_MAIN = `${GITHUB_WORKFLOW_PATH}@main`;
const GITHUB_API_ORIGIN = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 10_000;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const CONFIG_MAX_BYTES = 1024 * 1024;
const AUTH_MAX_BYTES = 16 * 1024;
const WORKFLOW_MAX_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar";
const OCI_LAYER_GZIP = "application/vnd.oci.image.layer.v1.tar+gzip";
const OCI_LAYER_ZSTD = "application/vnd.oci.image.layer.v1.tar+zstd";
const DOCKER_LAYER_GZIP = "application/vnd.docker.image.rootfs.diff.tar.gzip";

const INDEX_MEDIA_TYPES = new Set([OCI_INDEX, DOCKER_INDEX]);
const MANIFEST_MEDIA_TYPES = new Set([OCI_MANIFEST, DOCKER_MANIFEST]);
const CONFIG_MEDIA_TYPES = new Set([OCI_CONFIG, DOCKER_CONFIG]);
const LAYER_MEDIA_TYPES = new Set([OCI_LAYER, OCI_LAYER_GZIP, OCI_LAYER_ZSTD, DOCKER_LAYER_GZIP]);

export type HermesStagingImageAttestationMismatchCode =
  | "invalid_attestation_input"
  | "registry_redirect_rejected"
  | "registry_auth_challenge_invalid"
  | "registry_response_invalid"
  | "registry_digest_mismatch"
  | "runtime_manifest_missing"
  | "runtime_manifest_ambiguous"
  | "runtime_platform_mismatch"
  | "image_labels_mismatch"
  | "workflow_attestation_mismatch";

export type HermesStagingImageAttestationUnknownCode =
  | "registry_unavailable"
  | "github_unavailable"
  | "request_timeout"
  | "request_aborted";

export type HermesStagingImageAttestation =
  | {
      kind: "confirmed";
      releaseDigest: `sha256:${string}`;
      amd64ManifestDigest: `sha256:${string}`;
      sourceRevision: string;
      workflowRunId: number;
    }
  | {
      kind: "mismatch";
      code: HermesStagingImageAttestationMismatchCode;
    }
  | {
      kind: "unknown";
      code: HermesStagingImageAttestationUnknownCode;
    };

export type AttestHermesStagingPublishedImageInput = {
  canonicalRef: string;
  sourceRevision: string;
  workflowRunId: number;
  signal: AbortSignal;
};

type AttestorDependencies = {
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
};

type Descriptor = {
  mediaType: string;
  digest: `sha256:${string}`;
  size: number;
};

type RegistryDocument = {
  bytes: Uint8Array;
  contentType: string;
  value: Record<string, unknown>;
};

class SafeAttestationFailure extends Error {
  constructor(
    readonly kind: "mismatch" | "unknown",
    readonly code:
      | HermesStagingImageAttestationMismatchCode
      | HermesStagingImageAttestationUnknownCode,
  ) {
    super("Hermes staging image attestation failed safely.");
  }
}

export async function attestHermesStagingPublishedImage(
  input: AttestHermesStagingPublishedImageInput,
  dependencies: AttestorDependencies = {},
): Promise<HermesStagingImageAttestation> {
  const referenceMatch = IMAGE_REFERENCE_PATTERN.exec(input.canonicalRef);

  if (
    !referenceMatch ||
    !SOURCE_REVISION_PATTERN.test(input.sourceRevision) ||
    !Number.isSafeInteger(input.workflowRunId) ||
    input.workflowRunId <= 0
  ) {
    return { kind: "mismatch", code: "invalid_attestation_input" };
  }

  if (input.signal.aborted) {
    return { kind: "unknown", code: "request_aborted" };
  }

  const requestTimeoutMs = dependencies.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;

  if (
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > REQUEST_TIMEOUT_MS
  ) {
    return { kind: "mismatch", code: "invalid_attestation_input" };
  }

  const releaseDigest = referenceMatch[1] as `sha256:${string}`;
  const registry = new FixedGhcrClient({
    fetchImpl: dependencies.fetchImpl ?? fetch,
    signal: input.signal,
    requestTimeoutMs,
  });

  try {
    const releaseDocument = await registry.readManifest(releaseDigest);
    const amd64Manifest = await resolveAmd64Manifest({
      registry,
      releaseDigest,
      releaseDocument,
    });
    const configDescriptor = parseManifestConfig(amd64Manifest.document);
    const configDocument = await registry.readConfig(configDescriptor);

    verifyRuntimeConfig(configDocument, input.sourceRevision);
    await verifyWorkflowRun({
      fetchImpl: dependencies.fetchImpl ?? fetch,
      signal: input.signal,
      requestTimeoutMs,
      workflowRunId: input.workflowRunId,
      sourceRevision: input.sourceRevision,
    });

    return {
      kind: "confirmed",
      releaseDigest,
      amd64ManifestDigest: amd64Manifest.digest,
      sourceRevision: input.sourceRevision,
      workflowRunId: input.workflowRunId,
    };
  } catch (error) {
    const failure = classifyFailure(error, input.signal);
    return { kind: failure.kind, code: failure.code } as HermesStagingImageAttestation;
  }
}

class FixedGhcrClient {
  private bearerToken: string | null = null;

  constructor(
    private readonly dependencies: {
      fetchImpl: typeof fetch;
      signal: AbortSignal;
      requestTimeoutMs: number;
    },
  ) {}

  async readManifest(digest: `sha256:${string}`): Promise<RegistryDocument> {
    const response = await this.registryRequest(
      `${REGISTRY_ORIGIN}/v2/${REGISTRY_REPOSITORY}/manifests/${digest}`,
      [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(", "),
    );
    return await readRegistryJson(response, {
      expectedDigest: digest,
      maxBytes: MANIFEST_MAX_BYTES,
      allowedContentTypes: new Set([...INDEX_MEDIA_TYPES, ...MANIFEST_MEDIA_TYPES]),
    });
  }

  async readConfig(descriptor: Descriptor): Promise<Record<string, unknown>> {
    if (!CONFIG_MEDIA_TYPES.has(descriptor.mediaType) || descriptor.size > CONFIG_MAX_BYTES) {
      throw mismatch("registry_response_invalid");
    }

    const response = await this.registryRequest(
      `${REGISTRY_ORIGIN}/v2/${REGISTRY_REPOSITORY}/blobs/${descriptor.digest}`,
      `${descriptor.mediaType}, application/octet-stream`,
    );
    const bytes = await readRegistryBytes(response, {
      expectedDigest: descriptor.digest,
      expectedSize: descriptor.size,
      maxBytes: CONFIG_MAX_BYTES,
      allowedContentTypes: new Set([descriptor.mediaType, "application/octet-stream"]),
    });
    return parseJsonRecord(bytes);
  }

  private async registryRequest(url: string, accept: string): Promise<Response> {
    let response = await safeFetch(this.dependencies.fetchImpl, url, {
      signal: this.dependencies.signal,
      requestTimeoutMs: this.dependencies.requestTimeoutMs,
      accept,
      authorization: this.bearerToken ? `Bearer ${this.bearerToken}` : null,
      unavailableCode: "registry_unavailable",
    });

    if (isRedirect(response.status)) {
      throw mismatch("registry_redirect_rejected");
    }

    if (response.status === 401 && this.bearerToken === null) {
      this.bearerToken = await acquirePublicGhcrToken({
        fetchImpl: this.dependencies.fetchImpl,
        signal: this.dependencies.signal,
        requestTimeoutMs: this.dependencies.requestTimeoutMs,
        challenge: response.headers.get("www-authenticate"),
      });
      response = await safeFetch(this.dependencies.fetchImpl, url, {
        signal: this.dependencies.signal,
        requestTimeoutMs: this.dependencies.requestTimeoutMs,
        accept,
        authorization: `Bearer ${this.bearerToken}`,
        unavailableCode: "registry_unavailable",
      });
    }

    if (isRedirect(response.status)) {
      throw mismatch("registry_redirect_rejected");
    }

    if (response.status !== 200) {
      throw unknown("registry_unavailable");
    }

    return response;
  }
}

async function acquirePublicGhcrToken(input: {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  requestTimeoutMs: number;
  challenge: string | null;
}): Promise<string> {
  const challenge = parseGhcrChallenge(input.challenge);

  if (!challenge) {
    throw mismatch("registry_auth_challenge_invalid");
  }

  const tokenUrl = new URL(REGISTRY_AUTH_URL);
  tokenUrl.searchParams.set("service", REGISTRY_SERVICE);
  tokenUrl.searchParams.set("scope", REGISTRY_SCOPE);
  const response = await safeFetch(input.fetchImpl, tokenUrl.toString(), {
    signal: input.signal,
    requestTimeoutMs: input.requestTimeoutMs,
    accept: "application/json",
    authorization: null,
    unavailableCode: "registry_unavailable",
  });

  if (isRedirect(response.status)) {
    throw mismatch("registry_redirect_rejected");
  }

  if (response.status !== 200) {
    throw unknown("registry_unavailable");
  }

  const contentType = parseContentType(response.headers.get("content-type"));

  if (contentType !== "application/json") {
    throw mismatch("registry_response_invalid");
  }

  const value = parseJsonRecord(await readBoundedBytes(response, AUTH_MAX_BYTES));
  const token = hasOwn(value, "token") ? value.token : null;

  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
    throw mismatch("registry_response_invalid");
  }

  return token;
}

function parseGhcrChallenge(value: string | null): true | null {
  if (!value?.startsWith("Bearer ") || value.length > 2048) {
    return null;
  }

  const attributes = new Map<string, string>();

  for (const part of value.slice("Bearer ".length).split(/\s*,\s*/)) {
    const match = /^(realm|service|scope)="([^"]+)"$/.exec(part);

    if (!match || attributes.has(match[1] as string)) {
      return null;
    }

    attributes.set(match[1] as string, match[2] as string);
  }

  if (
    attributes.size !== 3 ||
    attributes.get("service") !== REGISTRY_SERVICE ||
    attributes.get("scope") !== REGISTRY_SCOPE
  ) {
    return null;
  }

  try {
    const realm = new URL(attributes.get("realm") ?? "");
    return realm.toString() === REGISTRY_AUTH_URL ? true : null;
  } catch {
    return null;
  }
}

async function resolveAmd64Manifest(input: {
  registry: FixedGhcrClient;
  releaseDigest: `sha256:${string}`;
  releaseDocument: RegistryDocument;
}): Promise<{ digest: `sha256:${string}`; document: RegistryDocument }> {
  if (MANIFEST_MEDIA_TYPES.has(input.releaseDocument.contentType)) {
    return { digest: input.releaseDigest, document: input.releaseDocument };
  }

  if (!INDEX_MEDIA_TYPES.has(input.releaseDocument.contentType)) {
    throw mismatch("registry_response_invalid");
  }

  const value = input.releaseDocument.value;

  if (
    value.schemaVersion !== 2 ||
    value.mediaType !== input.releaseDocument.contentType ||
    !Array.isArray(value.manifests) ||
    value.manifests.length === 0 ||
    value.manifests.length > 64
  ) {
    throw mismatch("registry_response_invalid");
  }

  const amd64Descriptors: Descriptor[] = [];

  for (const candidate of value.manifests) {
    if (!isPlainRecord(candidate) || !isPlainRecord(candidate.platform)) {
      throw mismatch("registry_response_invalid");
    }

    const descriptor = parseDescriptor(candidate, MANIFEST_MEDIA_TYPES);

    if (descriptor.size > MANIFEST_MAX_BYTES) {
      throw mismatch("registry_response_invalid");
    }

    if (candidate.platform.os === "unknown" && candidate.platform.architecture === "unknown") {
      continue;
    }

    if (candidate.platform.os !== "linux" || candidate.platform.architecture !== "amd64") {
      throw mismatch("runtime_platform_mismatch");
    }

    if (!hasExactKeys(candidate.platform, ["architecture", "os"])) {
      throw mismatch("runtime_platform_mismatch");
    }

    amd64Descriptors.push(descriptor);
  }

  if (amd64Descriptors.length === 0) {
    throw mismatch("runtime_manifest_missing");
  }

  if (amd64Descriptors.length !== 1) {
    throw mismatch("runtime_manifest_ambiguous");
  }

  const descriptor = amd64Descriptors[0] as Descriptor;
  const document = await input.registry.readManifest(descriptor.digest);

  if (
    document.bytes.byteLength !== descriptor.size ||
    document.contentType !== descriptor.mediaType
  ) {
    throw mismatch("registry_response_invalid");
  }

  return { digest: descriptor.digest, document };
}

function parseManifestConfig(document: RegistryDocument): Descriptor {
  const value = document.value;

  if (
    !MANIFEST_MEDIA_TYPES.has(document.contentType) ||
    value.schemaVersion !== 2 ||
    value.mediaType !== document.contentType ||
    !isPlainRecord(value.config) ||
    !Array.isArray(value.layers) ||
    value.layers.length === 0 ||
    value.layers.length > 256
  ) {
    throw mismatch("registry_response_invalid");
  }

  for (const layer of value.layers) {
    if (!isPlainRecord(layer)) {
      throw mismatch("registry_response_invalid");
    }
    parseDescriptor(layer, LAYER_MEDIA_TYPES);
  }

  return parseDescriptor(value.config, CONFIG_MEDIA_TYPES);
}

function parseDescriptor(
  value: Record<string, unknown>,
  mediaTypes: ReadonlySet<string>,
): Descriptor {
  if (
    typeof value.mediaType !== "string" ||
    !mediaTypes.has(value.mediaType) ||
    typeof value.digest !== "string" ||
    !DIGEST_PATTERN.test(value.digest) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size <= 0
  ) {
    throw mismatch("registry_response_invalid");
  }

  return {
    mediaType: value.mediaType,
    digest: value.digest as `sha256:${string}`,
    size: value.size,
  };
}

function verifyRuntimeConfig(value: Record<string, unknown>, sourceRevision: string): void {
  if (value.os !== "linux" || value.architecture !== "amd64" || hasOwn(value, "variant")) {
    throw mismatch("runtime_platform_mismatch");
  }

  if (
    !isPlainRecord(value.config) ||
    !isPlainRecord(value.config.Labels) ||
    value.config.Labels["org.opencontainers.image.source"] !== EXPECTED_SOURCE ||
    value.config.Labels["org.opencontainers.image.revision"] !== sourceRevision
  ) {
    throw mismatch("image_labels_mismatch");
  }
}

async function verifyWorkflowRun(input: {
  fetchImpl: typeof fetch;
  signal: AbortSignal;
  requestTimeoutMs: number;
  workflowRunId: number;
  sourceRevision: string;
}): Promise<void> {
  const url = `${GITHUB_API_ORIGIN}/repos/${GITHUB_REPOSITORY}/actions/runs/${input.workflowRunId}`;
  const response = await safeFetch(input.fetchImpl, url, {
    signal: input.signal,
    requestTimeoutMs: input.requestTimeoutMs,
    accept: "application/vnd.github+json",
    authorization: null,
    unavailableCode: "github_unavailable",
    extraHeaders: {
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "bruno-hermes-staging-attestor",
    },
  });

  if (isRedirect(response.status)) {
    throw mismatch("workflow_attestation_mismatch");
  }

  if (response.status !== 200) {
    throw unknown("github_unavailable");
  }

  if (parseContentType(response.headers.get("content-type")) !== "application/json") {
    throw mismatch("workflow_attestation_mismatch");
  }

  const value = parseJsonRecord(
    await readBoundedBytes(response, WORKFLOW_MAX_BYTES, "workflow_attestation_mismatch"),
    "workflow_attestation_mismatch",
  );
  const repository = hasOwn(value, "repository") ? value.repository : null;

  if (
    value.id !== input.workflowRunId ||
    (value.path !== GITHUB_WORKFLOW_PATH && value.path !== GITHUB_WORKFLOW_PATH_AT_MAIN) ||
    value.head_sha !== input.sourceRevision ||
    value.head_branch !== "main" ||
    value.event !== "push" ||
    value.status !== "completed" ||
    value.conclusion !== "success" ||
    !isPlainRecord(repository) ||
    repository.full_name !== GITHUB_REPOSITORY
  ) {
    throw mismatch("workflow_attestation_mismatch");
  }
}

async function readRegistryJson(
  response: Response,
  input: {
    expectedDigest: `sha256:${string}`;
    maxBytes: number;
    allowedContentTypes: ReadonlySet<string>;
  },
): Promise<RegistryDocument> {
  const bytes = await readRegistryBytes(response, input);
  const contentType = parseContentType(response.headers.get("content-type"));
  return { bytes, contentType: contentType as string, value: parseJsonRecord(bytes) };
}

async function readRegistryBytes(
  response: Response,
  input: {
    expectedDigest: `sha256:${string}`;
    expectedSize?: number;
    maxBytes: number;
    allowedContentTypes: ReadonlySet<string>;
  },
): Promise<Uint8Array> {
  const contentType = parseContentType(response.headers.get("content-type"));
  const responseDigest = response.headers.get("docker-content-digest");

  if (!contentType || !input.allowedContentTypes.has(contentType)) {
    throw mismatch("registry_response_invalid");
  }

  if (responseDigest !== input.expectedDigest) {
    throw mismatch("registry_digest_mismatch");
  }

  const bytes = await readBoundedBytes(response, input.maxBytes);

  if (input.expectedSize !== undefined && bytes.byteLength !== input.expectedSize) {
    throw mismatch("registry_response_invalid");
  }

  if (digestBytes(bytes) !== input.expectedDigest) {
    throw mismatch("registry_digest_mismatch");
  }

  return bytes;
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  input: {
    signal: AbortSignal;
    requestTimeoutMs: number;
    accept: string;
    authorization: string | null;
    unavailableCode: "registry_unavailable" | "github_unavailable";
    extraHeaders?: Record<string, string>;
  },
): Promise<Response> {
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.requestTimeoutMs)]);

  try {
    return await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal,
      headers: {
        Accept: input.accept,
        ...(input.authorization ? { Authorization: input.authorization } : {}),
        ...input.extraHeaders,
      },
    });
  } catch (error) {
    if (input.signal.aborted) {
      throw unknown("request_aborted");
    }

    if (isAbortError(error) || signal.aborted) {
      throw unknown("request_timeout");
    }

    throw unknown(input.unavailableCode);
  }
}

async function readBoundedBytes(
  response: Response,
  maxBytes: number,
  invalidCode: HermesStagingImageAttestationMismatchCode = "registry_response_invalid",
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");

  if (
    declaredLength !== null &&
    (!/^\d+$/.test(declaredLength) ||
      Number(declaredLength) <= 0 ||
      Number(declaredLength) > maxBytes)
  ) {
    throw mismatch(invalidCode);
  }

  if (!response.body) {
    throw mismatch(invalidCode);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw mismatch(invalidCode);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    throw mismatch(invalidCode);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function parseJsonRecord(
  bytes: Uint8Array,
  invalidCode: HermesStagingImageAttestationMismatchCode = "registry_response_invalid",
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (isPlainRecord(value)) {
      return value;
    }
  } catch {
    // Converted to a closed failure below.
  }

  throw mismatch(invalidCode);
}

function parseContentType(value: string | null): string | null {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType || null;
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isRedirect(status: number): boolean {
  return status >= 300 && status <= 399;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(value, key);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return (
    keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index])
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mismatch(code: HermesStagingImageAttestationMismatchCode): SafeAttestationFailure {
  return new SafeAttestationFailure("mismatch", code);
}

function unknown(code: HermesStagingImageAttestationUnknownCode): SafeAttestationFailure {
  return new SafeAttestationFailure("unknown", code);
}

function classifyFailure(
  error: unknown,
  inputSignal: AbortSignal,
): {
  kind: "mismatch" | "unknown";
  code: HermesStagingImageAttestationMismatchCode | HermesStagingImageAttestationUnknownCode;
} {
  if (error instanceof SafeAttestationFailure) {
    return { kind: error.kind, code: error.code };
  }

  return inputSignal.aborted
    ? { kind: "unknown", code: "request_aborted" }
    : { kind: "unknown", code: "registry_unavailable" };
}
