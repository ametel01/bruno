import { describe, expect, it } from "vitest";
import {
  buildDeploymentPresentation,
  deploymentExperienceStageState,
  deploymentStageListState,
  PUBLIC_AGENT_DEPLOYMENT_STAGES,
  parseSafeCreate202Body,
  parseSafeDeploymentGetBody,
  parseSafePublicDeployment,
} from "@/src/shared/agent-deployment-presentation";
import {
  foregroundPollingElapsedMs,
  pauseForegroundPollingWindow,
  resumeForegroundPollingWindow,
  startForegroundPollingWindow,
} from "@/src/shared/deployment-polling-state";
import { parseCanonicalTelegramAllowlist } from "@/src/shared/telegram-allowlist";

const AGENT_ID = "00000000-0000-4000-8000-000000000901";
const DEPLOYMENT_ID = "00000000-0000-4000-8000-000000000902";

describe("agent deployment presentation", () => {
  it("maps exact persisted stages without exposing raw error detail", () => {
    for (const stage of PUBLIC_AGENT_DEPLOYMENT_STAGES) {
      const deployment = deploymentDto({
        stage,
        ...(stage === "ready" ? { completedAt: "2026-08-03T06:00:00.000Z" } : {}),
        ...(stage === "failed"
          ? {
              error: {
                code: "telegram_not_connected",
                detail: "raw upstream detail must not survive",
              },
              failedAt: "2026-08-03T06:00:00.000Z",
            }
          : {}),
      });
      const parsed = parseSafePublicDeployment(deployment);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect(JSON.stringify(parsed.deployment)).not.toContain("raw upstream detail");
      const presentation = buildDeploymentPresentation({
        deployment: parsed.deployment,
        desiredStatus: "running",
        observedStatus: stage === "ready" ? "running" : "stopped",
      });

      expect(presentation.label).toMatch(
        /Preparing your agent|Connecting Telegram|Ready|Automatic setup could not recover/,
      );
    }
  });

  it("fails closed for unknown stages, extra deployment fields, and inconsistent ready status", () => {
    expect(parseSafePublicDeployment({ ...deploymentDto(), stage: "almost_ready" }).ok).toBe(false);
    expect(parseSafePublicDeployment({ ...deploymentDto(), leaseOwner: "worker" }).ok).toBe(false);

    const parsed = parseSafePublicDeployment(
      deploymentDto({ stage: "ready", completedAt: "2026-08-03T06:00:00.000Z" }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      buildDeploymentPresentation({
        deployment: parsed.deployment,
        desiredStatus: "running",
        observedStatus: "stopped",
      }).label,
    ).toBe("Preparing your agent");
  });

  it("validates exact 202 create and GET response envelopes", () => {
    const createBody = {
      agent: { id: AGENT_ID, name: "Agent" },
      deployment: deploymentDto(),
    };

    expect(parseSafeCreate202Body(createBody)).toMatchObject({
      ok: true,
      agentId: AGENT_ID,
    });
    expect(parseSafeCreate202Body({ ...createBody, idempotencyKey: "hidden-key" }).ok).toBe(false);
    expect(
      parseSafeCreate202Body({
        ...createBody,
        agent: { ...createBody.agent, secret: "hidden-secret" },
      }).ok,
    ).toBe(false);
    expect(parseSafeDeploymentGetBody({ deployment: deploymentDto() }, AGENT_ID)).toMatchObject({
      ok: true,
    });
    expect(
      parseSafeDeploymentGetBody(
        { deployment: deploymentDto(), leaseExpiresAt: "2026-08-03T06:00:00.000Z" },
        AGENT_ID,
      ).ok,
    ).toBe(false);
  });

  it("marks ordered stages from persisted state only", () => {
    const parsed = parseSafePublicDeployment(deploymentDto({ stage: "verifying_model" }));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const presentation = buildDeploymentPresentation({
      deployment: parsed.deployment,
      desiredStatus: "running",
      observedStatus: "stopped",
    });

    expect(deploymentStageListState(presentation, "pending")).toBe("completed");
    expect(deploymentStageListState(presentation, "verifying_model")).toBe("current");
    expect(deploymentStageListState(presentation, "connecting_telegram")).toBe("pending");
  });

  it("retains a client-observed nonterminal stage when the operation later fails", () => {
    const parsed = parseSafePublicDeployment(
      deploymentDto({
        stage: "failed",
        failedAt: "2026-08-03T06:00:00.000Z",
        error: { code: "deployment_cancelled", detail: "raw detail" },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const conservative = buildDeploymentPresentation({
      deployment: parsed.deployment,
      desiredStatus: "running",
      observedStatus: "stopped",
    });
    const observed = buildDeploymentPresentation({
      deployment: parsed.deployment,
      desiredStatus: "running",
      lastObservedStage: "verifying_model",
      observedStatus: "stopped",
    });

    expect(conservative.heading).toBe("Automatic setup could not recover");
    expect(deploymentStageListState(conservative, "pending")).toBe("pending");
    expect(observed.heading).toBe("Automatic setup could not recover");
    expect(deploymentStageListState(observed, "configuring_hermes")).toBe("completed");
    expect(deploymentStageListState(observed, "verifying_model")).toBe("blocked");
    expect(deploymentStageListState(observed, "connecting_telegram")).toBe("pending");
  });

  it("projects active replacement into one safe Preparing state without identifiers", () => {
    const parsed = parseSafePublicDeployment(
      deploymentDto({
        stage: "starting_gateway",
        error: {
          code: "runner_recovery_in_progress",
          detail: "runner=private-id droplet=private-resource endpoint=https://private.example",
        },
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const presentation = buildDeploymentPresentation({
      deployment: parsed.deployment,
      desiredStatus: "running",
      observedStatus: "starting",
    });

    expect(parsed.deployment.recovery).toEqual({ state: "preparing_capacity" });
    expect(presentation).toMatchObject({
      kind: "recovery",
      heading: "Preparing your agent",
      label: "Preparing your agent",
      description: "bruno is preparing replacement capacity automatically.",
    });
    expect(deploymentExperienceStageState(presentation, "preparing")).toBe("current");
    expect(JSON.stringify({ parsed: parsed.deployment, presentation })).not.toMatch(
      /private-id|private-resource|private\.example|droplet|endpoint/i,
    );
  });

  it("does not let desired status mask missing or malformed deployment state", () => {
    expect(
      buildDeploymentPresentation({
        deployment: null,
        desiredStatus: "stopped",
        observedStatus: "stopped",
      }).kind,
    ).toBe("manual");
    expect(
      buildDeploymentPresentation({
        deployment: null,
        desiredStatus: "running",
        observedStatus: "idle",
      }).kind,
    ).toBe("unavailable");

    const parsed = parseSafePublicDeployment(deploymentDto());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(
      buildDeploymentPresentation({
        deployment: parsed.deployment,
        desiredStatus: "stopped",
        observedStatus: "stopped",
      }).kind,
    ).toBe("stopped");
    expect(
      buildDeploymentPresentation({
        deployment: parsed.deployment,
        desiredStatus: "almost_running" as never,
        observedStatus: "running",
      }).kind,
    ).toBe("unavailable");
    expect(
      buildDeploymentPresentation({
        deployment: parsed.deployment,
        desiredStatus: "running",
        observedStatus: "almost_running" as never,
      }).kind,
    ).toBe("unavailable");
  });
});

describe("foreground polling state", () => {
  it("accumulates only active foreground time across pauses", () => {
    let window = startForegroundPollingWindow(1_000);

    expect(foregroundPollingElapsedMs(window, 11_000)).toBe(10_000);
    window = pauseForegroundPollingWindow(window, 11_000);
    expect(foregroundPollingElapsedMs(window, 41_000)).toBe(10_000);
    window = resumeForegroundPollingWindow(window, 41_000);
    expect(foregroundPollingElapsedMs(window, 46_000)).toBe(15_000);
  });

  it("makes resume idempotent and supports a fresh bounded window", () => {
    const active = resumeForegroundPollingWindow(startForegroundPollingWindow(1_000), 5_000);
    const reset = resumeForegroundPollingWindow(active, 20_000, { reset: true });

    expect(active).toEqual({ accumulatedMs: 0, activeStartedAt: 1_000 });
    expect(foregroundPollingElapsedMs(reset, 25_000)).toBe(5_000);
  });
});

describe("Telegram allowlist parsing", () => {
  it("preserves canonical strings and deduplicates in first-seen order", () => {
    expect(parseCanonicalTelegramAllowlist("123\n\n 456 \n123\n")).toEqual({
      ok: true,
      values: ["123", "456"],
    });
  });

  it.each([
    "",
    "   \n ",
    "0",
    "01",
    "-1",
    "+1",
    "1.2",
    "1e3",
    "1,2",
    "*",
    "abc",
  ])("rejects invalid allowlist input %#", (value) => {
    expect(parseCanonicalTelegramAllowlist(value).ok).toBe(false);
  });

  it("rejects more than 100 canonical entries", () => {
    const values = Array.from({ length: 101 }, (_, index) => String(index + 1)).join("\n");

    expect(parseCanonicalTelegramAllowlist(values)).toEqual({ ok: false, reason: "too_many" });
  });

  it("rejects more than 100 nonblank entries before dedupe", () => {
    const duplicateFlood = Array.from({ length: 101 }, () => "123").join("\n");

    expect(parseCanonicalTelegramAllowlist(duplicateFlood)).toEqual({
      ok: false,
      reason: "too_many",
    });
  });
});

function deploymentDto(
  overrides: Partial<{
    stage: string;
    error: { code: string; detail: string | null } | null;
    completedAt: string | null;
    failedAt: string | null;
  }> = {},
) {
  return {
    id: DEPLOYMENT_ID,
    agentId: AGENT_ID,
    stage: "pending",
    configRevision: "cfg-1784000000000",
    attemptCount: 0,
    error: null,
    nextAttemptAt: null,
    startedAt: null,
    completedAt: null,
    failedAt: null,
    createdAt: "2026-08-03T05:00:00.000Z",
    updatedAt: "2026-08-03T05:00:00.000Z",
    ...overrides,
  };
}
