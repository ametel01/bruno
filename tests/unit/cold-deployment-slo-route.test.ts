import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/cold-deployment-slo/evaluate/route";

const URL = "https://bruno.example.test/api/internal/cold-deployment-slo/evaluate";
const SECRET = "cron-secret-abcdefghijklmnopqrstuvwxyz012345";

describe("GET /api/internal/cold-deployment-slo/evaluate", () => {
  it("fails closed when signing is unavailable or cron authorization is invalid", async () => {
    const unavailable = await GET(new Request(URL), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      readSigning: () => null,
    });
    expect(unavailable.status).toBe(503);

    const unauthorized = await GET(new Request(URL), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      readSigning: () => ({ keyId: "cold-slo", privateKeyPem: "private" }),
      authorize: () => false,
    });
    expect(unauthorized.status).toBe(401);
  });

  it("publishes only sanitized retained evaluation status", async () => {
    const evaluate = vi.fn().mockResolvedValue({
      reportDigest: `sha256:${"a".repeat(64)}`,
      signature: "must-not-be-returned",
      signingKeyId: "cold-slo",
      objectiveSeconds: 300,
      eligibleCount: 100,
      readyWithinObjective: 96,
      pendingCount: 0,
      proven: true,
      incidentOpened: false,
      apiAcceptance: {
        sampleSize: 100,
        accepted: 99,
        rejected: 1,
        outcomeUnknown: 0,
        pending: 0,
        availability: 0.99,
      },
    });
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readCron: () => ({ ok: true, secret: SECRET }),
        readSigning: () => ({ keyId: "cold-slo", privateKeyPem: "private" }),
        authorize: () => true,
        evaluate,
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      evaluation: {
        reportDigest: `sha256:${"a".repeat(64)}`,
        objectiveSeconds: 300,
        eligibleCount: 100,
        readyWithinObjective: 96,
        pendingCount: 0,
        proven: true,
        incidentOpened: false,
        apiAcceptance: {
          sampleSize: 100,
          accepted: 99,
          rejected: 1,
          outcomeUnknown: 0,
          pending: 0,
          availability: 0.99,
        },
      },
    });
    expect(JSON.stringify(await evaluate.mock.results[0]?.value)).not.toContain("private");
  });

  it("rejects request controls", async () => {
    const response = await GET(new Request(`${URL}?force=true`), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      readSigning: () => ({ keyId: "cold-slo", privateKeyPem: "private" }),
      authorize: () => true,
    });
    expect(response.status).toBe(400);
  });
});
