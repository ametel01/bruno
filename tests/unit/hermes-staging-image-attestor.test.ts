import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  type AttestHermesStagingPublishedImageInput,
  attestHermesStagingPublishedImage,
} from "@/src/server/staging/hermes-staging-image-attestor";

const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const DOCKER_INDEX = "application/vnd.docker.distribution.manifest.list.v2+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const OCI_CONFIG = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER = "application/vnd.oci.image.layer.v1.tar+gzip";
const DOCKER_MANIFEST = "application/vnd.docker.distribution.manifest.v2+json";
const DOCKER_CONFIG = "application/vnd.docker.container.image.v1+json";
const DOCKER_LAYER = "application/vnd.docker.image.rootfs.diff.tar.gzip";
const SOURCE_REVISION = "0123456789abcdef0123456789abcdef01234567";
const WORKFLOW_RUN_ID = 987_654_321;
const TOKEN = "public-ghcr-token-value";

type FetchCall = { url: string; init: RequestInit };

type FixtureOptions = {
  directManifest?: boolean;
  dockerMediaTypes?: boolean;
  requireAuth?: boolean;
  authChallenge?: string;
  amd64Count?: number;
  amd64Variant?: string;
  extraRuntimePlatform?: { architecture: string; os: string };
  sourceLabel?: string;
  revisionLabel?: string;
  workflow?: Record<string, unknown>;
};

function digest(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function jsonResponse(
  body: string,
  input: {
    contentType: string;
    contentDigest?: string;
    status?: number;
    headers?: Record<string, string>;
  },
): Response {
  return new Response(body, {
    status: input.status ?? 200,
    headers: {
      "content-type": input.contentType,
      "content-length": String(new TextEncoder().encode(body).byteLength),
      ...(input.contentDigest ? { "docker-content-digest": input.contentDigest } : {}),
      ...input.headers,
    },
  });
}

function createFixture(options: FixtureOptions = {}) {
  const configMediaType = options.dockerMediaTypes ? DOCKER_CONFIG : OCI_CONFIG;
  const manifestMediaType = options.dockerMediaTypes ? DOCKER_MANIFEST : OCI_MANIFEST;
  const indexMediaType = options.dockerMediaTypes ? DOCKER_INDEX : OCI_INDEX;
  const layerMediaType = options.dockerMediaTypes ? DOCKER_LAYER : OCI_LAYER;
  const configBody = JSON.stringify({
    architecture: "amd64",
    os: "linux",
    config: {
      Labels: {
        "org.opencontainers.image.source":
          options.sourceLabel ?? "https://github.com/ametel01/bruno",
        "org.opencontainers.image.revision": options.revisionLabel ?? SOURCE_REVISION,
      },
    },
  });
  const configDigest = digest(configBody);
  const manifestBody = JSON.stringify({
    schemaVersion: 2,
    mediaType: manifestMediaType,
    config: {
      mediaType: configMediaType,
      digest: configDigest,
      size: new TextEncoder().encode(configBody).byteLength,
    },
    layers: [
      {
        mediaType: layerMediaType,
        digest: `sha256:${"d".repeat(64)}`,
        size: 123,
      },
    ],
  });
  const manifestDigest = digest(manifestBody);
  const amd64Count = options.amd64Count ?? 1;
  const manifests: Record<string, unknown>[] = Array.from({ length: amd64Count }, () => ({
    mediaType: manifestMediaType,
    digest: manifestDigest,
    size: new TextEncoder().encode(manifestBody).byteLength,
    platform: {
      architecture: "amd64",
      os: "linux",
      ...(options.amd64Variant ? { variant: options.amd64Variant } : {}),
    },
  }));
  manifests.push({
    mediaType: manifestMediaType,
    digest: `sha256:${"e".repeat(64)}`,
    size: 321,
    platform: { architecture: "unknown", os: "unknown" },
  });
  if (options.extraRuntimePlatform) {
    manifests.push({
      mediaType: manifestMediaType,
      digest: `sha256:${"f".repeat(64)}`,
      size: 456,
      platform: options.extraRuntimePlatform,
    });
  }
  const indexBody = JSON.stringify({ schemaVersion: 2, mediaType: indexMediaType, manifests });
  const releaseBody = options.directManifest ? manifestBody : indexBody;
  const releaseDigest = digest(releaseBody);
  const workflow = {
    id: WORKFLOW_RUN_ID,
    path: ".github/workflows/publish-agent-image.yml@main",
    head_sha: SOURCE_REVISION,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    repository: { full_name: "ametel01/bruno" },
    ...options.workflow,
  };
  const calls: FetchCall[] = [];
  let challenged = false;

  const fetchImpl = (async (url, init = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, init });

    if (
      requestUrl ===
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aametel01%2Fagentbay-hermes%3Apull"
    ) {
      return Response.json({ token: TOKEN });
    }

    if (requestUrl === `https://ghcr.io/v2/ametel01/agentbay-hermes/manifests/${releaseDigest}`) {
      if (options.requireAuth && !challenged) {
        challenged = true;
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate":
              options.authChallenge ??
              'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:ametel01/agentbay-hermes:pull"',
          },
        });
      }
      return jsonResponse(releaseBody, {
        contentType: options.directManifest ? manifestMediaType : indexMediaType,
        contentDigest: releaseDigest,
      });
    }

    if (
      !options.directManifest &&
      requestUrl === `https://ghcr.io/v2/ametel01/agentbay-hermes/manifests/${manifestDigest}`
    ) {
      return jsonResponse(manifestBody, {
        contentType: manifestMediaType,
        contentDigest: manifestDigest,
      });
    }

    if (requestUrl === `https://ghcr.io/v2/ametel01/agentbay-hermes/blobs/${configDigest}`) {
      return jsonResponse(configBody, {
        contentType: "application/octet-stream",
        contentDigest: configDigest,
      });
    }

    if (
      requestUrl === `https://api.github.com/repos/ametel01/bruno/actions/runs/${WORKFLOW_RUN_ID}`
    ) {
      return Response.json(workflow);
    }

    throw new Error("unexpected test URL");
  }) as typeof fetch;

  const input: AttestHermesStagingPublishedImageInput = {
    canonicalRef: `ghcr.io/ametel01/agentbay-hermes@${releaseDigest}`,
    sourceRevision: SOURCE_REVISION,
    workflowRunId: WORKFLOW_RUN_ID,
    signal: new AbortController().signal,
  };

  return {
    input,
    fetchImpl,
    calls,
    releaseDigest,
    manifestDigest,
    releaseBody,
  };
}

describe("Hermes staging published-image attestor", () => {
  it("confirms one OCI linux/amd64 manifest through the fixed public GHCR challenge and workflow", async () => {
    const fixture = createFixture({ requireAuth: true });
    const result = await attestHermesStagingPublishedImage(fixture.input, {
      fetchImpl: fixture.fetchImpl,
    });

    expect(result).toEqual({
      kind: "confirmed",
      releaseDigest: fixture.releaseDigest,
      amd64ManifestDigest: fixture.manifestDigest,
      sourceRevision: SOURCE_REVISION,
      workflowRunId: WORKFLOW_RUN_ID,
    });
    expect(fixture.calls.map(({ url }) => url)).toEqual([
      `https://ghcr.io/v2/ametel01/agentbay-hermes/manifests/${fixture.releaseDigest}`,
      "https://ghcr.io/token?service=ghcr.io&scope=repository%3Aametel01%2Fagentbay-hermes%3Apull",
      `https://ghcr.io/v2/ametel01/agentbay-hermes/manifests/${fixture.releaseDigest}`,
      `https://ghcr.io/v2/ametel01/agentbay-hermes/manifests/${fixture.manifestDigest}`,
      expect.stringContaining("https://ghcr.io/v2/ametel01/agentbay-hermes/blobs/"),
      `https://api.github.com/repos/ametel01/bruno/actions/runs/${WORKFLOW_RUN_ID}`,
    ]);

    for (const { init } of fixture.calls) {
      expect(init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Headers(fixture.calls[1]?.init.headers).has("authorization")).toBe(false);
    expect(new Headers(fixture.calls[2]?.init.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(new Headers(fixture.calls.at(-1)?.init.headers).has("authorization")).toBe(false);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(Object.keys(result)).toEqual([
      "kind",
      "releaseDigest",
      "amd64ManifestDigest",
      "sourceRevision",
      "workflowRunId",
    ]);
  });

  it("accepts a Docker v2 release manifest directly after its config proves linux/amd64", async () => {
    const fixture = createFixture({ directManifest: true, dockerMediaTypes: true });

    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({
      kind: "confirmed",
      releaseDigest: fixture.releaseDigest,
      amd64ManifestDigest: fixture.releaseDigest,
      sourceRevision: SOURCE_REVISION,
      workflowRunId: WORKFLOW_RUN_ID,
    });
  });

  it("accepts a Docker v2 manifest list with one exact linux/amd64 runtime manifest", async () => {
    const fixture = createFixture({ dockerMediaTypes: true });

    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({
      kind: "confirmed",
      releaseDigest: fixture.releaseDigest,
      amd64ManifestDigest: fixture.manifestDigest,
      sourceRevision: SOURCE_REVISION,
      workflowRunId: WORKFLOW_RUN_ID,
    });
  });

  it("accepts reordered fixed GHCR bearer attributes without widening their values", async () => {
    const fixture = createFixture({
      requireAuth: true,
      authChallenge:
        'Bearer scope="repository:ametel01/agentbay-hermes:pull",realm="https://ghcr.io/token",service="ghcr.io"',
    });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toMatchObject({ kind: "confirmed", releaseDigest: fixture.releaseDigest });
  });

  it("rejects malformed trust-root inputs without performing a request", async () => {
    const fetchImpl = vi.fn();

    for (const input of [
      {
        canonicalRef: `ghcr.io/ametel01/agentbay-hermes:staging@sha256:${"a".repeat(64)}`,
        sourceRevision: SOURCE_REVISION,
        workflowRunId: WORKFLOW_RUN_ID,
      },
      {
        canonicalRef: `ghcr.io/other/agentbay-hermes@sha256:${"a".repeat(64)}`,
        sourceRevision: SOURCE_REVISION,
        workflowRunId: WORKFLOW_RUN_ID,
      },
      {
        canonicalRef: `ghcr.io/ametel01/agentbay-hermes@sha256:${"a".repeat(64)}`,
        sourceRevision: "A".repeat(40),
        workflowRunId: WORKFLOW_RUN_ID,
      },
      {
        canonicalRef: `ghcr.io/ametel01/agentbay-hermes@sha256:${"a".repeat(64)}`,
        sourceRevision: SOURCE_REVISION,
        workflowRunId: 0,
      },
    ]) {
      await expect(
        attestHermesStagingPublishedImage(
          { ...input, signal: new AbortController().signal },
          { fetchImpl: fetchImpl as typeof fetch },
        ),
      ).resolves.toEqual({ kind: "mismatch", code: "invalid_attestation_input" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [0, "runtime_manifest_missing"],
    [2, "runtime_manifest_ambiguous"],
  ] as const)("requires exactly one linux/amd64 runtime manifest (%s)", async (count, code) => {
    const fixture = createFixture({ amd64Count: count });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({ kind: "mismatch", code });
  });

  it("rejects an amd64 variant instead of silently treating it as the production platform", async () => {
    const fixture = createFixture({ amd64Variant: "v3" });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({ kind: "mismatch", code: "runtime_platform_mismatch" });
  });

  it("rejects a multiplatform release that cannot come from the fixed amd64-only workflow", async () => {
    const fixture = createFixture({
      extraRuntimePlatform: { architecture: "arm64", os: "linux" },
    });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({ kind: "mismatch", code: "runtime_platform_mismatch" });
  });

  it("rejects registry redirects and any bearer challenge outside the exact GHCR token URL", async () => {
    const redirectFixture = createFixture();
    const redirectFetch = vi.fn(async () =>
      Response.redirect("https://evil.example.test/manifest", 302),
    );
    await expect(
      attestHermesStagingPublishedImage(redirectFixture.input, {
        fetchImpl: redirectFetch as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_redirect_rejected" });

    const challengeFixture = createFixture({
      requireAuth: true,
      authChallenge:
        'Bearer realm="https://tokens.evil.example/token",service="ghcr.io",scope="repository:ametel01/agentbay-hermes:pull"',
    });
    await expect(
      attestHermesStagingPublishedImage(challengeFixture.input, {
        fetchImpl: challengeFixture.fetchImpl,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_auth_challenge_invalid" });
    expect(challengeFixture.calls).toHaveLength(1);
  });

  it("requires both response digest metadata and exact response bytes", async () => {
    const fixture = createFixture();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/manifests/")) {
        return jsonResponse(`${fixture.releaseBody} `, {
          contentType: OCI_INDEX,
          contentDigest: fixture.releaseDigest,
        });
      }
      return await fixture.fetchImpl(url, init);
    });

    await expect(
      attestHermesStagingPublishedImage(fixture.input, {
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_digest_mismatch" });

    const missingHeaderFetch = vi.fn(async () =>
      jsonResponse(fixture.releaseBody, { contentType: OCI_INDEX }),
    );
    await expect(
      attestHermesStagingPublishedImage(fixture.input, {
        fetchImpl: missingHeaderFetch as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_digest_mismatch" });
  });

  it("rejects malformed registry JSON even when its claimed digest matches its bytes", async () => {
    const body = "{";
    const releaseDigest = digest(body);
    const input: AttestHermesStagingPublishedImageInput = {
      canonicalRef: `ghcr.io/ametel01/agentbay-hermes@${releaseDigest}`,
      sourceRevision: SOURCE_REVISION,
      workflowRunId: WORKFLOW_RUN_ID,
      signal: new AbortController().signal,
    };
    const fetchImpl = vi.fn(async () =>
      jsonResponse(body, {
        contentType: OCI_INDEX,
        contentDigest: releaseDigest,
      }),
    );

    await expect(
      attestHermesStagingPublishedImage(input, { fetchImpl: fetchImpl as typeof fetch }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_response_invalid" });
  });

  it.each([
    ["https://github.com/other/repo", SOURCE_REVISION],
    ["https://github.com/ametel01/bruno", "f".repeat(40)],
  ])("requires exact source and revision labels", async (sourceLabel, revisionLabel) => {
    const fixture = createFixture({ sourceLabel, revisionLabel });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({ kind: "mismatch", code: "image_labels_mismatch" });
  });

  it.each([
    { path: ".github/workflows/other.yml" },
    { head_sha: "f".repeat(40) },
    { head_branch: "release" },
    { event: "workflow_dispatch" },
    { conclusion: "failure" },
    { status: "in_progress", conclusion: null },
    { id: WORKFLOW_RUN_ID + 1 },
    { repository: { full_name: "other/repository" } },
  ])("rejects a workflow run that does not match the fixed successful publication %#", async (workflow) => {
    const fixture = createFixture({ workflow });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, { fetchImpl: fixture.fetchImpl }),
    ).resolves.toEqual({ kind: "mismatch", code: "workflow_attestation_mismatch" });
  });

  it("bounds declared and streamed response bodies", async () => {
    const fixture = createFixture();
    const declaredFetch = vi.fn(async () =>
      jsonResponse("{}", {
        contentType: OCI_INDEX,
        contentDigest: fixture.releaseDigest,
        headers: { "content-length": String(1024 * 1024 + 1) },
      }),
    );
    await expect(
      attestHermesStagingPublishedImage(fixture.input, {
        fetchImpl: declaredFetch as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_response_invalid" });

    const streamedFetch = vi.fn(async () => {
      const chunk = new Uint8Array(1024 * 1024 + 1);
      return new Response(
        new ReadableStream({ start: (controller) => controller.enqueue(chunk) }),
        {
          headers: {
            "content-type": OCI_INDEX,
            "docker-content-digest": fixture.releaseDigest,
          },
        },
      );
    });
    await expect(
      attestHermesStagingPublishedImage(fixture.input, {
        fetchImpl: streamedFetch as typeof fetch,
      }),
    ).resolves.toEqual({ kind: "mismatch", code: "registry_response_invalid" });
  });

  it("returns only a closed timeout or caller-abort result", async () => {
    const fixture = createFixture();
    const hangingFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("private timeout detail", "AbortError")),
            { once: true },
          );
        }),
    );
    await expect(
      attestHermesStagingPublishedImage(fixture.input, {
        fetchImpl: hangingFetch as typeof fetch,
        requestTimeoutMs: 1,
      }),
    ).resolves.toEqual({ kind: "unknown", code: "request_timeout" });

    const controller = new AbortController();
    controller.abort("private abort detail");
    await expect(
      attestHermesStagingPublishedImage(
        { ...fixture.input, signal: controller.signal },
        {
          fetchImpl: hangingFetch as typeof fetch,
        },
      ),
    ).resolves.toEqual({ kind: "unknown", code: "request_aborted" });
  });

  it("contains no Docker, pull, or subprocess execution path", async () => {
    const source = await readFile("src/server/staging/hermes-staging-image-attestor.ts", "utf8");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toMatch(/docker\s+(?:pull|inspect)/i);
  });
});
