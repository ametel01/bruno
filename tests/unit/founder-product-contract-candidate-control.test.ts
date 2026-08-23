import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFounderReleaseCandidateControl,
  finalizeFounderReleaseCandidateControl,
  founderReleaseCandidateControlKey,
  founderReleaseCandidateControlName,
} from "@/scripts/founder-product-contract-candidate-control";
import { buildDeterministicFounderGeneralReleaseAuthorityFixture } from "@/src/testing/founder-general-release-authority";

const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-release-v1";
const NOW = new Date("2026-08-23T08:00:00.000Z");
const CANDIDATE_ENV = {
  VERCEL_GIT_COMMIT_SHA: REVISION,
  BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION: RUNTIME_REVISION,
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Founder release candidate control", () => {
  it.each([
    "create",
    "finalize",
  ])("loads the %s CLI path under plain Bun before fail-closed environment validation", (operation) => {
    const result = spawnSync(
      "bun",
      ["scripts/founder-product-contract-candidate-control.ts", operation],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("GITHUB_REPOSITORY is required.");
    expect(result.stderr).not.toContain("server-only");
  });

  it("derives one stable identity from source and protected runtime", () => {
    expect(founderReleaseCandidateControlKey(REVISION, RUNTIME_REVISION)).toBe(
      founderReleaseCandidateControlKey(REVISION, RUNTIME_REVISION),
    );
    expect(founderReleaseCandidateControlKey(REVISION, RUNTIME_REVISION)).not.toBe(
      founderReleaseCandidateControlKey(REVISION, "runtime-release-v2"),
    );
    expect(founderReleaseCandidateControlName(1234)).not.toBe(
      founderReleaseCandidateControlName(1235),
    );
  });

  it("creates the exact GitHub Actions control without evidence content", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await createFounderReleaseCandidateControl({
      repository: "ametel01/bruno",
      sourceRevision: REVISION,
      runtimeRevision: RUNTIME_REVISION,
      runId: 1234,
      token: "github-test-token",
      request: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: 42 });
      },
    });

    expect(result).toEqual({
      checkRunId: 42,
      externalId: founderReleaseCandidateControlKey(REVISION, RUNTIME_REVISION),
    });
    expect(requestBody).toMatchObject({
      name: founderReleaseCandidateControlName(1234),
      head_sha: REVISION,
      status: "in_progress",
      external_id: result.externalId,
      details_url: "https://github.com/ametel01/bruno/actions/runs/1234",
    });
    expect(JSON.stringify(requestBody)).not.toContain(RUNTIME_REVISION);
  });

  it("finalizes success only for an approved retained decision and successful prior job", async () => {
    const decisionPath = await writeDecision("approved");
    let requestBody: Record<string, unknown> | undefined;

    await finalizeFounderReleaseCandidateControl({
      repository: "ametel01/bruno",
      checkRunId: 42,
      decisionPath,
      priorJobStatus: "success",
      token: "github-test-token",
      env: CANDIDATE_ENV,
      now: NOW,
      request: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: 42 });
      },
    });

    expect(requestBody).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it.each([
    ["denied retained decision", "denied", "success"],
    ["failed prior job", "approved", "failure"],
  ])("finalizes failure and rejects a %s", async (_label, outcome, priorJobStatus) => {
    const decisionPath = await writeDecision(outcome);
    let requestBody: Record<string, unknown> | undefined;

    await expect(
      finalizeFounderReleaseCandidateControl({
        repository: "ametel01/bruno",
        checkRunId: 42,
        decisionPath,
        priorJobStatus,
        token: "github-test-token",
        env: CANDIDATE_ENV,
        now: NOW,
        request: async (_url, init) => {
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return jsonResponse({ id: 42 });
        },
      }),
    ).rejects.toThrow("denied this exact candidate");
    expect(requestBody).toMatchObject({ status: "completed", conclusion: "failure" });
  });

  it("fails closed when finalization is unavailable", async () => {
    const decisionPath = await writeDecision("approved");
    await expect(
      finalizeFounderReleaseCandidateControl({
        repository: "ametel01/bruno",
        checkRunId: 42,
        decisionPath,
        priorJobStatus: "success",
        token: "github-test-token",
        env: CANDIDATE_ENV,
        now: NOW,
        request: async () => new Response("unavailable", { status: 503 }),
      }),
    ).rejects.toThrow("could not be finalized");
  });

  it("fails when a successful PATCH commits but its response is lost", async () => {
    const decisionPath = await writeDecision("approved");
    let committedBody: Record<string, unknown> | undefined;

    await expect(
      finalizeFounderReleaseCandidateControl({
        repository: "ametel01/bruno",
        checkRunId: 42,
        decisionPath,
        priorJobStatus: "success",
        token: "github-test-token",
        env: CANDIDATE_ENV,
        now: NOW,
        request: async (_url, init) => {
          committedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          throw new TypeError("response lost after commit");
        },
      }),
    ).rejects.toThrow("response lost after commit");
    expect(committedBody).toMatchObject({ status: "completed", conclusion: "success" });
  });
});

async function writeDecision(outcome: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "bruno-candidate-control-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "decision.json");
  const decision =
    outcome === "approved"
      ? buildDeterministicFounderGeneralReleaseAuthorityFixture({
          sourceRevision: REVISION,
          runtimeRevision: RUNTIME_REVISION,
          decidedAt: NOW,
        })
      : JSON.stringify({
          schemaVersion: "bruno.founder-initial-general-release-decision.v1",
          outcome,
        });
  await writeFile(path, decision, "utf8");
  return path;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
