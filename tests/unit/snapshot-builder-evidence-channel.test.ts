import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createSnapshotBuilderEvidenceChannel,
  SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER,
} from "@/src/server/runners/snapshot-builder-evidence-channel";

const BOOT_RESULT = {
  ok: true,
  builderResourceId: "7654321",
  runnerImage: `ghcr.io/ametel01/bruno-runner:abc@sha256:${"a".repeat(64)}`,
  defaultAgentImage: `docker.io/library/busybox@sha256:${"b".repeat(64)}`,
  hermesImage: `nousresearch/hermes-agent@sha256:${"c".repeat(64)}`,
  bootContractVersion: "bruno.runner.boot.v1",
  components: { docker: "passed" },
  completedAt: "2026-08-10T00:00:00.000Z",
};

const SANITATION_RESULT = {
  ok: true,
  builderResourceId: "7654321",
  forbiddenPathsAbsent: true,
  hostileMarkersAbsent: true,
  completedAt: "2026-08-10T00:00:01.000Z",
};
const AUTHENTICATION_SECRET = "d".repeat(64);

describe("snapshot builder GitHub evidence channel", () => {
  it("matches the cross-runtime canonical HMAC golden vector", () => {
    expect(completedPayload().authenticationTag).toBe(
      "380984be2067c0c3964e4fb48fd67c73f46fc53c20078cceb88b47be556211a1",
    );
  });

  it("accepts one exact completed github-actions comment for this run and nonce", async () => {
    const payload = completedPayload();
    const channel = createSnapshotBuilderEvidenceChannel({
      token: "github-token-test-value",
      repository: "ametel01/bruno",
      issueNumber: 294,
      runId: "31339201376",
      nonce: "11111111-1111-4111-8111-111111111111",
      authenticationSecret: AUTHENTICATION_SECRET,
      fetch: async () =>
        Response.json([
          comment(progressPayload(), "github-actions[bot]", 10),
          comment(payload, "github-actions[bot]", 11),
          comment(payload, "ametel01", 12),
        ]),
    });

    expect(channel.publisher).toMatchObject({
      repository: "ametel01/bruno",
      issueNumber: 294,
      runId: "31339201376",
      nonce: "11111111-1111-4111-8111-111111111111",
      authenticationSecret: AUTHENTICATION_SECRET,
    });

    await expect(
      channel.read({ providerResourceId: "7654321" }, { signal: new AbortController().signal }),
    ).resolves.toEqual({
      ok: true,
      value: {
        bootResult: BOOT_RESULT,
        sanitationResult: SANITATION_RESULT,
        sourceUrl: "https://github.com/ametel01/bruno/issues/294#issuecomment-11",
      },
    });
  });

  it("fails closed on duplicate completed comments", async () => {
    const payload = completedPayload();
    const channel = createSnapshotBuilderEvidenceChannel({
      token: "github-token-test-value",
      repository: "ametel01/bruno",
      issueNumber: 294,
      runId: "31339201376",
      nonce: "11111111-1111-4111-8111-111111111111",
      authenticationSecret: AUTHENTICATION_SECRET,
      fetch: async () =>
        Response.json([
          comment(payload, "github-actions[bot]", 11),
          comment(payload, "github-actions[bot]", 12),
        ]),
    });

    await expect(
      channel.read({ providerResourceId: "7654321" }, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "builder_evidence_not_ready",
    });
  });

  it("fails closed when completed evidence is modified after authentication", async () => {
    const payload = completedPayload();
    payload.bootResult = { ...BOOT_RESULT, runnerImage: "tampered" };
    const channel = createSnapshotBuilderEvidenceChannel({
      token: "github-token-test-value",
      repository: "ametel01/bruno",
      issueNumber: 294,
      runId: "31339201376",
      nonce: "11111111-1111-4111-8111-111111111111",
      authenticationSecret: AUTHENTICATION_SECRET,
      fetch: async () => Response.json([comment(payload, "github-actions[bot]", 11)]),
    });

    await expect(
      channel.read({ providerResourceId: "7654321" }, { signal: new AbortController().signal }),
    ).resolves.toMatchObject({ ok: false, reason: "builder_evidence_not_ready" });
  });

  it("does not call GitHub after cancellation", async () => {
    let called = false;
    const controller = new AbortController();
    controller.abort();
    const channel = createSnapshotBuilderEvidenceChannel({
      token: "github-token-test-value",
      repository: "ametel01/bruno",
      issueNumber: 294,
      runId: "31339201376",
      nonce: "11111111-1111-4111-8111-111111111111",
      fetch: async () => {
        called = true;
        return Response.json([]);
      },
    });

    await expect(
      channel.read({ providerResourceId: "7654321" }, { signal: controller.signal }),
    ).resolves.toMatchObject({ ok: false, reason: "builder_evidence_not_ready" });
    expect(called).toBe(false);
  });
});

function completedPayload() {
  const payload = {
    contractVersion: "bruno.runner.snapshot-builder-evidence.v1",
    repository: "ametel01/bruno",
    issueNumber: 294,
    runId: "31339201376",
    nonce: "11111111-1111-4111-8111-111111111111",
    stage: "complete",
    builderResourceId: "7654321",
    bootResult: BOOT_RESULT,
    sanitationResult: SANITATION_RESULT,
  };
  return {
    ...payload,
    authenticationTag: createHmac("sha256", Buffer.from(AUTHENTICATION_SECRET, "hex"))
      .update(canonicalJson(payload))
      .digest("hex"),
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function progressPayload() {
  const { nonce: _nonce, authenticationTag: _authenticationTag, ...payload } = completedPayload();
  return { ...payload, stage: "images_preloaded" };
}

function comment(payload: unknown, login: string, id: number) {
  return {
    id,
    html_url: `https://github.com/ametel01/bruno/issues/294#issuecomment-${id}`,
    user: { login },
    body: `${SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER}\n${JSON.stringify(payload)}`,
  };
}
