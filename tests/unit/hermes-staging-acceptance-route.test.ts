import { describe, expect, it, vi } from "vitest";
import * as acceptanceRoute from "@/app/api/internal/hermes-staging/acceptance/route";
import { POST } from "@/app/api/internal/hermes-staging/acceptance/route";
import { HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES } from "@/src/server/staging/hermes-staging-acceptance-transport";

const URL = "https://staging.example.test/api/internal/hermes-staging/acceptance";
const SECRET = "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345";
const RUN_ID = "019fc4dd-fcf0-7b13-8e71-d0610b539eb4";
const CHALLENGE_ID = "a191de38-f182-47ca-86e4-e532bf9f17ee";

const SAFE_RUN = {
  runId: RUN_ID,
  phase: "preflight",
  desiredOutcome: "acceptance",
  nextAction: { kind: "automatic", retryAt: "2026-08-03T12:00:00.000Z" },
  checks: {
    imageAttested: false,
    deploymentStagesObserved: false,
    initialReplyAttested: false,
    restartReady: false,
    restartImageAttested: false,
    postRestartReplyAttested: false,
    diagnosticsRedacted: false,
    intentionalStopStable: false,
    rollbackVerified: false,
  },
  cleanup: {
    agent: "not_created",
    workload: "not_created",
    firewall: "not_created",
    droplet: "not_created",
    runner: "not_created",
    secretsRevoked: false,
  },
  errorCode: null,
  nextAttemptAt: "2026-08-03T12:00:00.000Z",
  completedAt: null,
  privateProviderResponse: "must-never-cross-route",
};

const ENABLED_CONFIG = {
  ok: true as const,
  enabled: true as const,
  baseUrl: "https://staging.example.test",
  bearerSecret: SECRET,
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/hermes-staging/acceptance", () => {
  it("exports only POST and fails closed before reading a body or invoking orchestration", async () => {
    expect("GET" in acceptanceRoute).toBe(false);
    expect("PUT" in acceptanceRoute).toBe(false);
    expect("DELETE" in acceptanceRoute).toBe(false);

    const readBody = vi.fn(() => {
      throw new Error("body must not be read before authorization");
    });
    const command = vi.fn();
    const malformedRequest = {
      url: URL,
      headers: new Headers({ "content-type": "application/json" }),
      get body() {
        return readBody();
      },
    } as unknown as Request;
    const unauthorized = await POST(malformedRequest, undefined, {
      readConfig: () => ENABLED_CONFIG,
      command,
    });

    expect(unauthorized.status).toBe(401);
    expect(readBody).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();

    const disabled = await POST(request("{"), undefined, {
      readConfig: () => ({ ok: true, enabled: false }),
      command,
    });
    expect(disabled.status).toBe(404);
    expect(await disabled.json()).toEqual({
      error: {
        code: "acceptance_disabled",
        message: "Hermes staging acceptance is disabled.",
      },
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("requires exact content type, bounded bytes, and the closed command schema", async () => {
    const command = vi.fn();
    const dependencies = { readConfig: () => ENABLED_CONFIG, command };

    const wrongType = await POST(
      request({ command: "begin" }, { "content-type": "application/json; charset=utf-8" }),
      undefined,
      dependencies,
    );
    expect(wrongType.status).toBe(415);

    const oversized = await POST(
      request("x", { "content-length": String(HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES + 1) }),
      undefined,
      dependencies,
    );
    expect(oversized.status).toBe(413);

    const streamedOversized = await POST(
      request("x".repeat(HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES + 1)),
      undefined,
      dependencies,
    );
    expect(streamedOversized.status).toBe(413);

    for (const body of [
      "{",
      { command: "send_telegram", text: "private-message" },
      { command: "begin", rawReply: "private-message" },
      { command: "read", runId: "not-a-uuid" },
      {
        command: "attest_telegram_reply",
        runId: RUN_ID,
        challengeId: CHALLENGE_ID,
        attestationToken: "A".repeat(64),
      },
    ]) {
      const response = await POST(request(body), undefined, dependencies);
      expect(response.status).toBe(400);
    }

    expect(command).not.toHaveBeenCalled();
  });

  it("dispatches each closed command and returns only the reconstructed safe projection", async () => {
    const command = vi.fn(async () => SAFE_RUN);
    const read = vi.fn(async () => SAFE_RUN);
    const reconcileTarget = vi.fn(async () => ({
      processed: 1,
      outcome: "advanced",
      run: SAFE_RUN,
      private: "must-never-cross-route",
    }));
    const dependencies = {
      readConfig: () => ENABLED_CONFIG,
      command,
      read,
      reconcileTarget,
    };

    for (const body of [
      { command: "begin" },
      {
        command: "attest_telegram_reply",
        runId: RUN_ID,
        challengeId: CHALLENGE_ID,
        attestationToken: "a".repeat(64),
      },
      { command: "request_cleanup", runId: RUN_ID },
    ]) {
      const response = await POST(request(body), undefined, dependencies);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(text).not.toContain("must-never-cross-route");
      expect(JSON.parse(text)).toMatchObject({
        ok: true,
        run: { runId: RUN_ID, desiredOutcome: "acceptance" },
      });
    }

    const readResponse = await POST(
      request({ command: "read", runId: RUN_ID }),
      undefined,
      dependencies,
    );
    expect(readResponse.status).toBe(200);
    expect(read).toHaveBeenCalledWith(RUN_ID);

    const advanceResponse = await POST(
      request({ command: "advance", runId: RUN_ID }),
      undefined,
      dependencies,
    );
    const advanceText = await advanceResponse.text();
    expect(advanceResponse.status).toBe(200);
    expect(advanceText).not.toContain("must-never-cross-route");
    expect(JSON.parse(advanceText)).toMatchObject({
      ok: true,
      processed: 1,
      outcome: "advanced",
      run: { runId: RUN_ID },
    });
    expect(reconcileTarget).toHaveBeenCalledWith(RUN_ID);
  });

  it("conceals absent runs and invalid or thrown internal results", async () => {
    const absent = await POST(request({ command: "read", runId: RUN_ID }), undefined, {
      readConfig: () => ENABLED_CONFIG,
      read: async () => null,
    });
    expect(absent.status).toBe(404);

    for (const result of [
      { ...SAFE_RUN, phase: "provider-secret-phase" },
      { ...SAFE_RUN, errorCode: "provider-secret-error" },
    ]) {
      const response = await POST(request({ command: "begin" }), undefined, {
        readConfig: () => ENABLED_CONFIG,
        command: async () => result,
      });
      const text = await response.text();
      expect(response.status).toBe(500);
      expect(text).toContain("acceptance_contract_invalid");
      expect(text).not.toContain("provider-secret");
    }

    const failed = await POST(request({ command: "begin" }), undefined, {
      readConfig: () => ENABLED_CONFIG,
      command: async () => {
        throw new Error("private-provider-payload");
      },
    });
    const failedText = await failed.text();
    expect(failed.status).toBe(500);
    expect(failedText).toContain("acceptance_command_failed");
    expect(failedText).not.toContain("private-provider-payload");
  });
});
