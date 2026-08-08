import { describe, expect, it, vi } from "vitest";
import * as exhaustedListRoute from "@/app/api/internal/agent-deployments/wakeups/exhausted/route";
import { GET as listExhausted } from "@/app/api/internal/agent-deployments/wakeups/exhausted/route";
import * as exhaustedDetailRoute from "@/app/api/internal/agent-deployments/wakeups/exhausted/[wakeupId]/route";
import {
  GET as inspectExhausted,
  POST as replayExhausted,
} from "@/app/api/internal/agent-deployments/wakeups/exhausted/[wakeupId]/route";

const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEF012345";
const WAKEUP_ID = "00000000-0000-4000-8000-000000001001";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000001002";
const NOW = new Date("2026-08-08T04:00:00.000Z");
const EVIDENCE = {
  wakeupId: WAKEUP_ID,
  deploymentId: DEPLOYMENT_ID,
  generation: 3,
  dueAt: "2026-08-08T03:58:00.000Z",
  state: "exhausted" as const,
  publishAttemptCount: 12,
  safeReason: "publish_attempts_exhausted",
  exhaustedAt: "2026-08-08T03:59:00.000Z",
};

describe("operator deployment wakeup exhaustion routes", () => {
  it("exports only protected read/list and read/replay methods", () => {
    expect("POST" in exhaustedListRoute).toBe(false);
    expect("PUT" in exhaustedListRoute).toBe(false);
    expect("DELETE" in exhaustedListRoute).toBe(false);
    expect("PUT" in exhaustedDetailRoute).toBe(false);
    expect("PATCH" in exhaustedDetailRoute).toBe(false);
    expect("DELETE" in exhaustedDetailRoute).toBe(false);
  });

  it("fails closed before inspection when operator service auth is unavailable or invalid", async () => {
    const listWakeups = vi.fn();
    const unavailable = await listExhausted(
      new Request("http://localhost/api/internal/agent-deployments/wakeups/exhausted"),
      undefined,
      {
        readConfig: () => ({ ok: false, reason: "cron_configuration_invalid" }),
        listWakeups,
      },
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: {
        code: "wakeup_operator_configuration_invalid",
        message: "Wakeup operator access is not configured safely.",
      },
    });

    const unauthorized = await inspectExhausted(
      operatorRequest(`/${WAKEUP_ID}`, "GET", `Bearer ${SECRET.slice(0, -1)}x`),
      context(WAKEUP_ID),
      {
        readConfig: cronConfig,
        inspectWakeup: vi.fn(),
      },
    );
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: {
        code: "wakeup_operator_unauthorized",
        message: "Wakeup operator authorization is invalid.",
      },
    });
    expect(listWakeups).not.toHaveBeenCalled();
  });

  it("lists and inspects exact sanitized evidence with no-store caching", async () => {
    const listConnection = fakeConnection();
    const listed = await listExhausted(operatorRequest("", "GET"), undefined, {
      readConfig: cronConfig,
      createConnection: () => listConnection.connection,
      listWakeups: vi.fn(async () => [EVIDENCE]),
    });
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(await listed.json()).toEqual({ wakeups: [EVIDENCE] });
    expect(listConnection.close).not.toHaveBeenCalled();

    const detailConnection = fakeConnection();
    const inspected = await inspectExhausted(
      operatorRequest(`/${WAKEUP_ID}`, "GET"),
      context(WAKEUP_ID),
      {
        readConfig: cronConfig,
        createConnection: () => detailConnection.connection,
        inspectWakeup: vi.fn(async () => EVIDENCE),
      },
    );
    expect(inspected.status).toBe(200);
    const inspectedBody = await inspected.json();
    expect(inspectedBody).toEqual({ wakeup: EVIDENCE });
    expect(JSON.stringify(inspectedBody)).not.toMatch(/token|owner|providerMessage/i);
    expect(detailConnection.close).not.toHaveBeenCalled();
  });

  it("rejects query/body controls and malformed or absent inspection identities", async () => {
    const inspectWakeup = vi.fn();
    const query = await listExhausted(operatorRequest("?limit=private", "GET"), undefined, {
      readConfig: cronConfig,
      listWakeups: vi.fn(),
    });
    expect(query.status).toBe(400);

    const malformed = await inspectExhausted(
      operatorRequest("/not-a-uuid", "GET"),
      context("not-a-uuid"),
      { readConfig: cronConfig, inspectWakeup },
    );
    expect(malformed.status).toBe(400);
    expect(inspectWakeup).not.toHaveBeenCalled();

    const missingConnection = fakeConnection();
    const missing = await inspectExhausted(
      operatorRequest(`/${WAKEUP_ID}`, "GET"),
      context(WAKEUP_ID),
      {
        readConfig: cronConfig,
        createConnection: () => missingConnection.connection,
        inspectWakeup: vi.fn(async () => null),
      },
    );
    expect(missing.status).toBe(404);

    const body = await replayExhausted(
      new Request(
        `http://localhost/api/internal/agent-deployments/wakeups/exhausted/${WAKEUP_ID}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${SECRET}` },
          body: "{}",
        },
      ),
      context(WAKEUP_ID),
      { readConfig: cronConfig, replayWakeup: vi.fn() },
    );
    expect(body.status).toBe(400);
  });

  it("commits replay before publishing the new fenced generation", async () => {
    const calls: string[] = [];
    const replayConnection = fakeConnection(calls);
    const wakeup = {
      deploymentId: DEPLOYMENT_ID,
      generation: 4,
      dueAt: NOW.toISOString(),
    };
    const response = await replayExhausted(
      operatorRequest(`/${WAKEUP_ID}`, "POST"),
      context(WAKEUP_ID),
      {
        readConfig: cronConfig,
        createConnection: () => replayConnection.connection,
        replayWakeup: vi.fn(async () => {
          calls.push("replay");
          return { ok: true as const, exhaustedWakeupId: WAKEUP_ID, wakeup };
        }),
        publishWakeup: vi.fn(async (payload) => {
          calls.push("publish");
          expect(payload).toEqual(wakeup);
          return "published" as const;
        }),
        now: () => NOW,
      },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, wakeup });
    expect(calls).toEqual(["transaction:start", "replay", "transaction:commit", "publish"]);
  });

  it.each([
    ["not_found", 404, "exhausted_wakeup_not_found"],
    ["not_exhausted", 409, "exhausted_wakeup_not_replayable"],
    ["deployment_terminal", 409, "exhausted_wakeup_deployment_terminal"],
    ["superseded", 409, "exhausted_wakeup_superseded"],
  ] as const)("maps replay %s without exposing the wakeup identity", async (reason, status, code) => {
    const replayConnection = fakeConnection();
    const response = await replayExhausted(
      operatorRequest(`/${WAKEUP_ID}`, "POST"),
      context(WAKEUP_ID),
      {
        readConfig: cronConfig,
        createConnection: () => replayConnection.connection,
        replayWakeup: vi.fn(async () => ({ ok: false as const, reason })),
        now: () => NOW,
      },
    );
    const body = await response.json();

    expect(response.status).toBe(status);
    expect(body.error.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain(WAKEUP_ID);
  });
});

function operatorRequest(suffix: string, method: "GET" | "POST", authorization?: string): Request {
  return new Request(`http://localhost/api/internal/agent-deployments/wakeups/exhausted${suffix}`, {
    method,
    headers: { authorization: authorization ?? `Bearer ${SECRET}` },
  });
}

function context(wakeupId: string) {
  return { params: Promise.resolve({ wakeupId }) };
}

function cronConfig() {
  return { ok: true, secret: SECRET } as const;
}

function fakeConnection(calls: string[] = []) {
  const close = vi.fn(async () => {
    calls.push("close");
  });
  const transaction = async <T>(callback: (tx: object) => Promise<T>): Promise<T> => {
    calls.push("transaction:start");
    const result = await callback({});
    calls.push("transaction:commit");
    return result;
  };
  return {
    close,
    connection: { db: { transaction }, close } as never,
  };
}
