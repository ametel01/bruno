import { describe, expect, it } from "vitest";
import {
  readLinuxAmd64ManifestDigest,
  validateHermesImageIdentity,
} from "@/src/runner-service/hermes-image-identity";

const INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `ghcr.io/ametel01/bruno-hermes:optimized-test@${INDEX_DIGEST}`;
const OCI_INDEX = "application/vnd.oci.image.index.v1+json";
const OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json";

function imageIndex(manifests: unknown[]) {
  return JSON.stringify({ schemaVersion: 2, mediaType: OCI_INDEX, manifests });
}

function manifestDescriptor(
  input: {
    digest?: string;
    mediaType?: string;
    platform?: Record<string, unknown>;
    size?: number;
  } = {},
) {
  return {
    digest: input.digest ?? AMD64_DIGEST,
    mediaType: input.mediaType ?? OCI_MANIFEST,
    size: input.size ?? 1_024,
    platform: input.platform ?? { os: "linux", architecture: "amd64" },
  };
}

describe("Hermes image identity", () => {
  it("allows an exact Bruno.Ai GHCR index and platform digest", () => {
    expect(validateHermesImageIdentity(IMAGE, AMD64_DIGEST)).toEqual({
      reference: IMAGE,
      indexDigest: INDEX_DIGEST,
      amd64ManifestDigest: AMD64_DIGEST,
    });
  });

  it("rejects other repositories and missing platform identity", () => {
    expect(
      validateHermesImageIdentity(`ghcr.io/example/bruno-hermes@${INDEX_DIGEST}`, AMD64_DIGEST),
    ).toBeNull();
    expect(validateHermesImageIdentity(IMAGE, undefined)).toBeNull();
  });

  it("resolves exactly one linux/amd64 child from an OCI index", () => {
    expect(
      readLinuxAmd64ManifestDigest(
        imageIndex([
          manifestDescriptor({
            digest: `sha256:${"c".repeat(64)}`,
            platform: { os: "linux", architecture: "arm64" },
          }),
          manifestDescriptor(),
        ]),
      ),
    ).toBe(AMD64_DIGEST);
  });

  it("rejects malformed, absent, and ambiguous platform descriptors", () => {
    expect(() => readLinuxAmd64ManifestDigest("not-json")).toThrow("invalid JSON");
    expect(() => readLinuxAmd64ManifestDigest(imageIndex([]))).toThrow("one exact linux/amd64");
    expect(() =>
      readLinuxAmd64ManifestDigest(imageIndex([manifestDescriptor(), manifestDescriptor()])),
    ).toThrow("one exact linux/amd64");
  });

  it("rejects non-index documents and non-image descriptors", () => {
    expect(() =>
      readLinuxAmd64ManifestDigest(
        JSON.stringify({ schemaVersion: 1, mediaType: OCI_INDEX, manifests: [] }),
      ),
    ).toThrow("valid OCI or Docker image index");
    expect(() =>
      readLinuxAmd64ManifestDigest(
        JSON.stringify({ schemaVersion: 2, mediaType: "application/json", manifests: [] }),
      ),
    ).toThrow("valid OCI or Docker image index");
    expect(() =>
      readLinuxAmd64ManifestDigest(
        imageIndex([
          manifestDescriptor({ mediaType: "application/vnd.oci.artifact.manifest.v1+json" }),
        ]),
      ),
    ).toThrow("valid image manifest descriptor");
  });

  it("rejects invalid descriptor sizes and non-exact platform shapes", () => {
    expect(() =>
      readLinuxAmd64ManifestDigest(imageIndex([manifestDescriptor({ size: 0 })])),
    ).toThrow("valid image manifest descriptor");
    expect(() =>
      readLinuxAmd64ManifestDigest(
        imageIndex([
          manifestDescriptor({ platform: { os: "linux", architecture: "amd64", variant: "v1" } }),
        ]),
      ),
    ).toThrow("exact os and architecture");
    expect(() =>
      readLinuxAmd64ManifestDigest(
        imageIndex([
          manifestDescriptor(),
          manifestDescriptor({
            digest: `sha256:${"d".repeat(64)}`,
            platform: { os: 7, architecture: {} },
          }),
        ]),
      ),
    ).toThrow("non-empty os and architecture");
  });
});
