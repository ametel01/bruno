import { describe, expect, it } from "vitest";
import * as route from "@/app/api/internal/runner-release/required/route";
import { GET } from "@/app/api/internal/runner-release/required/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";
const SHA = "a".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const IMAGE = `ghcr.io/ametel01/agentbay-runner:${SHA}@${DIGEST}`;
const URL = "https://bruno.example/api/internal/runner-release/required";

describe("GET /api/internal/runner-release/required", () => {
  it("exports only GET and rejects missing authorization", async () => {
    expect("POST" in route).toBe(false);
    const response = await GET(new Request(URL), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      runnerImage: IMAGE,
      readRolloutBatchSize: () => 1,
    });
    expect(response.status).toBe(401);
  });

  it("returns only the immutable required release and gradual rollout state", async () => {
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readCron: () => ({ ok: true, secret: SECRET }),
        runnerImage: IMAGE,
        readRolloutBatchSize: () => 1,
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      ok: true,
      requiredRelease: {
        imageReference: IMAGE,
        imageDigest: DIGEST,
        version: SHA,
        bootContractVersion: "bruno.runner.boot.v1",
      },
      rollout: { batchSize: 1, halted: false },
    });
  });

  it("fails closed for mutable release or invalid rollout configuration", async () => {
    const request = () => new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } });
    const mutable = await GET(request(), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      runnerImage: "ghcr.io/ametel01/agentbay-runner:main",
      readRolloutBatchSize: () => 1,
    });
    expect(mutable.status).toBe(503);

    const invalid = await GET(request(), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      runnerImage: IMAGE,
      readRolloutBatchSize: () => {
        throw new Error("private configuration");
      },
    });
    expect(invalid.status).toBe(503);
    expect(JSON.stringify(await invalid.json())).not.toContain("private configuration");
  });
});
