import { describe, expect, it, vi } from "vitest";
import * as cronRoute from "@/app/api/internal/hermes-staging/reconcile/route";
import { GET } from "@/app/api/internal/hermes-staging/reconcile/route";

const URL = "https://staging.example.test/api/internal/hermes-staging/reconcile";
const CRON_SECRET = "cron_secret_abcdefghijklmnopqrstuvwxyz012345";
const ACCEPTANCE_SECRET = "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345";
const RUN_ID = "019fc4dd-fcf0-7b13-8e71-d0610b539eb4";
const ENABLED_CONFIG = {
  ok: true as const,
  enabled: true as const,
  baseUrl: "https://staging.example.test",
  bearerSecret: ACCEPTANCE_SECRET,
};
const SAFE_RUN = {
  runId: RUN_ID,
  phase: "preflight",
  desiredOutcome: "acceptance",
  nextAction: { kind: "none" },
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
  nextAttemptAt: null,
  completedAt: null,
};

function authorizedRequest(url = URL) {
  return new Request(url, {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

describe("GET /api/internal/hermes-staging/reconcile", () => {
  it("exports only GET and authenticates before any reconciliation", async () => {
    expect("POST" in cronRoute).toBe(false);
    expect("PUT" in cronRoute).toBe(false);
    expect("DELETE" in cronRoute).toBe(false);

    const reconcile = vi.fn();
    const readAcceptanceConfig = vi.fn(() => ENABLED_CONFIG);
    const response = await GET(new Request(URL), undefined, {
      readAcceptanceConfig,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile,
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        code: "acceptance_cron_unauthorized",
        message: "Hermes staging acceptance cron authorization is invalid.",
      },
    });
    expect(readAcceptanceConfig).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("rejects invalid cron configuration before reading acceptance state or reconciling", async () => {
    const reconcile = vi.fn();
    const readAcceptanceConfig = vi.fn(() => ENABLED_CONFIG);
    const response = await GET(authorizedRequest(), undefined, {
      readAcceptanceConfig,
      readCronConfig: () => ({ ok: false, reason: "cron_configuration_invalid" }),
      reconcile,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "acceptance_cron_configuration_invalid",
        message: "Hermes staging acceptance cron is not configured safely.",
      },
    });
    expect(readAcceptanceConfig).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled", () => ({ ok: true as const, enabled: false as const })],
    [
      "invalid",
      () => ({
        ok: false as const,
        reason: "hermes_staging_acceptance_configuration_invalid" as const,
      }),
    ],
  ])("forces cleanup reconciliation when acceptance configuration is %s", async (_label, readConfig) => {
    const reconcile = vi.fn(async () => ({
      processed: 1,
      outcome: "cleanup_pending",
      run: { ...SAFE_RUN, desiredOutcome: "cleanup" },
    }));
    const response = await GET(authorizedRequest(), undefined, {
      readAcceptanceConfig: readConfig,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      processed: 1,
      outcome: "cleanup_pending",
      run: { runId: RUN_ID, desiredOutcome: "cleanup" },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({ allowForward: false });
  });

  it("advances at most one due run and reconstructs only the safe projection", async () => {
    const reconcile = vi.fn(async () => ({
      processed: 1,
      outcome: "advanced",
      run: { ...SAFE_RUN, privateProviderResponse: "must-never-cross-route" },
      private: "must-never-cross-route",
    }));
    const response = await GET(authorizedRequest(), undefined, {
      readAcceptanceConfig: () => ENABLED_CONFIG,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile,
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      processed: 1,
      outcome: "advanced",
      run: { runId: RUN_ID },
    });
    expect(text).not.toContain("must-never-cross-route");
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({ allowForward: true });
  });

  it("rejects request controls and invalid internal contracts without a second claim", async () => {
    const reconcile = vi.fn(async () => ({ processed: 2, outcome: "advanced", run: SAFE_RUN }));
    const query = await GET(authorizedRequest(`${URL}?runId=${RUN_ID}`), undefined, {
      readAcceptanceConfig: () => ENABLED_CONFIG,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile,
    });
    expect(query.status).toBe(400);
    expect(reconcile).not.toHaveBeenCalled();

    const invalid = await GET(authorizedRequest(), undefined, {
      readAcceptanceConfig: () => ENABLED_CONFIG,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile,
    });
    expect(invalid.status).toBe(500);
    expect(await invalid.json()).toEqual({
      error: {
        code: "acceptance_contract_invalid",
        message: "Hermes staging acceptance returned an invalid safe projection.",
      },
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(reconcile).toHaveBeenCalledWith({ allowForward: true });
  });

  it("redacts thrown reconciliation details", async () => {
    const response = await GET(authorizedRequest(), undefined, {
      readAcceptanceConfig: () => ENABLED_CONFIG,
      readCronConfig: () => ({ ok: true, secret: CRON_SECRET }),
      reconcile: async () => {
        throw new Error("private-provider-payload");
      },
    });
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toContain("acceptance_cron_reconcile_failed");
    expect(text).not.toContain("private-provider-payload");
  });
});
