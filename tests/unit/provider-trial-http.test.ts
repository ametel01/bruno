import { describe, expect, it } from "vitest";
import { fetchProviderTrialJson } from "@/src/server/agents/provider-trial-http";

describe("Provider Trial HTTP probe", () => {
  it("retries a transient timeout before accepting the observed JSON response", async () => {
    let attempts = 0;
    const delays: number[] = [];
    const fetchImpl = async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new DOMException("The operation timed out.", "TimeoutError");
      }
      return new Response(JSON.stringify({ account: { uuid: "observed-account" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const result = await fetchProviderTrialJson(
      "https://provider.example/account",
      { authorization: "Bearer secret-not-logged" },
      {
        attempts: 3,
        fetchImpl: fetchImpl as typeof fetch,
        retryDelayMs: 25,
        sleep: async (milliseconds) => {
          delays.push(milliseconds);
        },
        timeoutMs: 10,
      },
    );

    expect(result).toEqual({
      status: 200,
      body: { account: { uuid: "observed-account" } },
    });
    expect(attempts).toBe(2);
    expect(delays).toEqual([25]);
  });

  it("retries a transient provider status before accepting a successful observation", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return attempts === 1
        ? new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503 })
        : new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const result = await fetchProviderTrialJson(
      "https://provider.example/identity",
      { authorization: "Bearer secret-not-logged" },
      {
        attempts: 3,
        fetchImpl: fetchImpl as typeof fetch,
        retryDelayMs: 0,
        sleep: async () => undefined,
      },
    );

    expect(result).toEqual({ status: 200, body: { ok: true } });
    expect(attempts).toBe(2);
  });

  it("returns a non-retryable identity rejection without another request", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      return new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 });
    };

    const result = await fetchProviderTrialJson(
      "https://provider.example/identity",
      { authorization: "Bearer rejected-secret-not-logged" },
      { attempts: 3, fetchImpl: fetchImpl as typeof fetch },
    );

    expect(result).toEqual({ status: 401, body: { message: "unauthorized" } });
    expect(attempts).toBe(1);
  });

  it("rejects after exhausting transient transport failures", async () => {
    let attempts = 0;
    const fetchImpl = async () => {
      attempts += 1;
      throw new DOMException("The operation timed out.", "TimeoutError");
    };

    await expect(
      fetchProviderTrialJson(
        "https://provider.example/identity",
        { authorization: "Bearer timed-out-secret-not-logged" },
        {
          attempts: 3,
          fetchImpl: fetchImpl as typeof fetch,
          retryDelayMs: 0,
          sleep: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(attempts).toBe(3);
  });
});
