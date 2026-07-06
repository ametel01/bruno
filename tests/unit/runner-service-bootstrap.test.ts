import { describe, expect, it } from "vitest";
import { bootstrapRegisteredRunner } from "@/src/runner-service/bootstrap";

describe("runner service bootstrap registration", () => {
  it("exchanges the one-time registration token and reports online through the heartbeat endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await bootstrapRegisteredRunner({
      env: {
        AGENTBAY_APP_URL: "https://app.agentbay.test",
        AGENTBAY_RUNNER_REGISTRATION_TOKEN: "agb_reg_1234567890123456789012345678901234567890123",
        AGENTBAY_RUNNER_ENDPOINT_URL: "https://runner.agentbay.test",
        AGENTBAY_RUNNER_NAME: "Cloud Runner 1",
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });

        if (String(url).endsWith("/runner/v1/register")) {
          return Response.json(
            {
              ok: true,
              runner: { id: "00000000-0000-4000-8000-000000000153" },
              credential: {
                token: "agb_run_1234567890123456789012345678901234567890123",
                prefix: "agb_run_12345678",
              },
            },
            { status: 201 },
          );
        }

        if (String(url).endsWith("/runner/v1/heartbeat")) {
          return Response.json({ ok: true }, { status: 200 });
        }

        return Response.json({ ok: false }, { status: 404 });
      },
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      url: "https://app.agentbay.test/runner/v1/register",
      init: {
        method: "POST",
      },
    });
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      endpointUrl: "https://runner.agentbay.test",
      name: "Cloud Runner 1",
    });
    expect(calls[1]).toMatchObject({
      url: "https://app.agentbay.test/runner/v1/heartbeat",
      init: {
        method: "POST",
        headers: {
          authorization: "Bearer agb_run_1234567890123456789012345678901234567890123",
          "content-type": "application/json",
        },
      },
    });
    expect(JSON.parse(String(calls[1]?.init.body))).toMatchObject({
      runnerId: "00000000-0000-4000-8000-000000000153",
      status: "online",
    });
  });

  it("uses existing runner credentials when already registered", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const result = await bootstrapRegisteredRunner({
      env: {
        AGENTBAY_APP_URL: "https://app.agentbay.test/",
        AGENTBAY_RUNNER_ENDPOINT_URL: "https://runner.agentbay.test",
        AGENTBAY_RUNNER_ID: "00000000-0000-4000-8000-000000000154",
        AGENTBAY_RUNNER_CREDENTIAL: "agb_run_existing",
      },
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json({ ok: true }, { status: 200 });
      },
    });

    expect(result).toEqual({
      ok: true,
      runnerId: "00000000-0000-4000-8000-000000000154",
      status: "online",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://app.agentbay.test/runner/v1/heartbeat",
    ]);
    expect(calls[0]?.init.headers).toEqual({
      authorization: "Bearer agb_run_existing",
      "content-type": "application/json",
    });
  });

  it("fails closed without bootstrap registration or credential environment", async () => {
    const result = await bootstrapRegisteredRunner({
      env: {
        AGENTBAY_APP_URL: "https://app.agentbay.test",
        AGENTBAY_RUNNER_ENDPOINT_URL: "https://runner.agentbay.test",
      },
      fetch: async () => Response.json({ ok: false }, { status: 500 }),
    });

    expect(result).toEqual({ ok: false, reason: "not_configured" });
  });
});
