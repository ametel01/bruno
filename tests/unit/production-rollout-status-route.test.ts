import { describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/internal/production-rollout/status/route";

const URL = "https://bruno.example.test/api/internal/production-rollout/status";
const SECRET = "cron-secret-abcdefghijklmnopqrstuvwxyz012345";

describe("GET /api/internal/production-rollout/status", () => {
  it("fails closed when cron configuration or authorization is invalid", async () => {
    const unavailable = await GET(new Request(URL), undefined, {
      readCron: () => ({ ok: false, reason: "cron_configuration_invalid" }),
    });
    expect(unavailable.status).toBe(503);

    const unauthorized = await GET(new Request(URL), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      authorize: () => false,
    });
    expect(unauthorized.status).toBe(401);
  });

  it("returns only sanitized configuration-generation and pinning evidence", async () => {
    const readStatus = vi.fn().mockResolvedValue({
      schemaVersion: "bruno.production-rollout.status.v1",
      current: {
        generation: 14,
        dispatchMode: "qstash",
        recoveryMaxPublishAttempts: 12,
        imageMode: "snapshot",
        validationMode: "release_attested",
        runnerSizeSlug: "s-1vcpu-2gb",
        credentialConfigurationValid: true,
        coldProvisioning: { enabled: true },
      },
      activeDeployments: {
        count: 3,
        generationCounts: [
          { generation: 8, count: 2 },
          { generation: 14, count: 1 },
        ],
        pinnedChoicesValid: true,
      },
      privateCanary: "must-not-be-returned",
    });
    const response = await GET(
      new Request(URL, { headers: { authorization: `Bearer ${SECRET}` } }),
      undefined,
      {
        readCron: () => ({ ok: true, secret: SECRET }),
        authorize: () => true,
        readStatus,
      },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      ok: true,
      status: {
        schemaVersion: "bruno.production-rollout.status.v1",
        current: {
          generation: 14,
          dispatchMode: "qstash",
          recoveryMaxPublishAttempts: 12,
          imageMode: "snapshot",
          validationMode: "release_attested",
          runnerSizeSlug: "s-1vcpu-2gb",
          credentialConfigurationValid: true,
          coldProvisioning: { enabled: true },
        },
        activeDeployments: {
          count: 3,
          generationCounts: [
            { generation: 8, count: 2 },
            { generation: 14, count: 1 },
          ],
          pinnedChoicesValid: true,
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain("must-not-be-returned");
  });

  it("rejects request controls", async () => {
    const response = await GET(new Request(`${URL}?generation=1`), undefined, {
      readCron: () => ({ ok: true, secret: SECRET }),
      authorize: () => true,
    });
    expect(response.status).toBe(400);
  });
});
