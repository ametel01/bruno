import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isProviderTrialCallbackProbeResponse,
  isProviderTrialSnapshotAvailable,
  isSafeProviderTrialCallbackBaseUrl,
  PROVIDER_TRIAL_ARTIFACT_PATHS,
  PROVIDER_TRIAL_AUTHORIZATION,
} from "@/src/server/agents/provider-trial-operator-config";

const COMMAND = [
  "--conditions",
  "react-server",
  "scripts/run-provider-trial.ts",
  "preflight",
] as const;

describe("Provider Trial operator CLI", () => {
  it("requires a public HTTPS callback base URL", () => {
    expect(isSafeProviderTrialCallbackBaseUrl("https://bruno.example/")).toBe(true);
    expect(isSafeProviderTrialCallbackBaseUrl("http://localhost:3000")).toBe(false);
    expect(isSafeProviderTrialCallbackBaseUrl("https://127.0.0.1/")).toBe(false);
    expect(isSafeProviderTrialCallbackBaseUrl("https://bruno.example/callback")).toBe(false);
  });

  it("accepts only the public runner registration validation response", () => {
    const expected = { ok: false, error: { code: "validation_failed" } };
    expect(isProviderTrialCallbackProbeResponse(400, expected)).toBe(true);
    expect(isProviderTrialCallbackProbeResponse(302, expected)).toBe(false);
    expect(isProviderTrialCallbackProbeResponse(400, { ok: false, error: { code: "login" } })).toBe(
      false,
    );
  });

  it("requires the exact authorized snapshot to be available in the authorized region", () => {
    const expected = { imageId: "241009503", region: "sfo3" };
    expect(
      isProviderTrialSnapshotAvailable(
        200,
        { id: 241009503, status: "available", regions: ["sfo3"] },
        expected,
      ),
    ).toBe(true);
    expect(isProviderTrialSnapshotAvailable(404, null, expected)).toBe(false);
    expect(
      isProviderTrialSnapshotAvailable(
        200,
        { id: 241009504, status: "available", regions: ["sfo3"] },
        expected,
      ),
    ).toBe(false);
    expect(
      isProviderTrialSnapshotAvailable(
        200,
        { id: 241009503, status: "available", regions: ["nyc3"] },
        expected,
      ),
    ).toBe(false);
  });

  it("pins the fresh issue #299 authorization generation", () => {
    expect(PROVIDER_TRIAL_AUTHORIZATION).toEqual({
      id: "issue-299-20260814-g9",
      generation: 9,
    });
  });

  it("uses generation-scoped evidence paths without replacing retained verification keys", () => {
    expect(PROVIDER_TRIAL_ARTIFACT_PATHS).toEqual({
      credential: ".env.provider-trial.local",
      gateEvidence: ".vercel/provider-trial-evidence/issue-299-g9-prerequisite-gates.json",
      signingPrivateKey: ".vercel/provider-trial-evidence/issue-299-g9-ed25519-private.pem",
      signingPublicKey: ".vercel/provider-trial-evidence/issue-299-g9-ed25519-public.pem",
    });
  });

  it("provides a cleanup-only recovery command without renewing deployment authorization", () => {
    const source = readFileSync("scripts/run-provider-trial.ts", "utf8");

    expect(source).toContain('command === "reconcile-cleanup"');
    expect(source).toContain('command === "pause-unavailable-snapshot"');
    expect(source).toContain("reconcileProviderTrialCleanup(");
    expect(source).toContain('effects: "authorized_cleanup_only"');
    expect(source).toContain('"gate_impossible"');
  });

  it("fails closed with zero effects and names every missing configuration field", () => {
    const result = spawnSync("bun", COMMAND, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      command: "preflight",
      effects: 0,
      ok: false,
      issues: [
        "authorization_id",
        "authorization_generation",
        "cohort_key",
        "live_confirmation",
        "digitalocean_token",
        "deployment_choices",
        "model_fixture",
        "signing_key",
        "prerequisite_gates",
        "credential_cleanup",
        "telegram_fixture",
      ],
    });
    expect(result.stdout).not.toContain("undefined");
  });

  it("rejects a fully populated environment that differs from the approved scope", () => {
    const result = spawnSync("bun", COMMAND, {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        BRUNO_PROVIDER_TRIAL_AUTHORIZATION_ID: "different-authorization",
        BRUNO_PROVIDER_TRIAL_AUTHORIZATION_GENERATION: "3",
        BRUNO_PROVIDER_TRIAL_COHORT_KEY: "issue-299-provider-trial-20260813-g3",
        BRUNO_PROVIDER_TRIAL_LIVE_SIDE_EFFECT_CONFIRMATION:
          "authorize-issue-299-live-provider-trial",
        NEXT_PUBLIC_APP_URL: "https://bruno.example/",
        BRUNO_DIGITALOCEAN_TOKEN: "do-not-print-this-provider-token-value",
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
        BRUNO_DIGITALOCEAN_REGION: "nyc3",
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-2vcpu-4gb",
        BRUNO_RUNNER_IMAGE: `ghcr.io/ametel01/bruno-runner@sha256:${"1".repeat(64)}`,
        BRUNO_RUNNER_BEARER_TOKEN: "do-not-print-this-runner-bearer-value",
        BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
        BRUNO_AGENT_SECRET_KEYS_JSON: '{"v1":"do-not-print-this-keyring-value"}',
        BRUNO_PROVIDER_TRIAL_ASSISTANT: "chatgpt",
        BRUNO_PROVIDER_TRIAL_MODEL_API_KEY: "do-not-print-this-model-key-value",
        BRUNO_PROVIDER_TRIAL_SIGNING_KEY_ID: "issue-299",
        BRUNO_PROVIDER_TRIAL_SIGNING_PRIVATE_KEY_PATH: "/tmp/issue-299.pem",
        BRUNO_PROVIDER_TRIAL_GATE_EVIDENCE_PATH: "/tmp/issue-299-gates.json",
        BRUNO_PROVIDER_TRIAL_CREDENTIAL_FILE_PATH: "/tmp/issue-299.env",
        BRUNO_PROVIDER_TRIAL_TELEGRAM_BOT_TOKEN: "do-not-print-this-telegram-token-value",
        BRUNO_PROVIDER_TRIAL_TELEGRAM_USER_ID: "123456",
        BRUNO_PROVIDER_TRIAL_TELEGRAM_CHAT_ID: "123456",
      },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      command: "preflight",
      effects: 0,
      ok: false,
      issues: ["approved_scope"],
    });
    expect(result.stdout).not.toContain("do-not-print-this");
  });
});
