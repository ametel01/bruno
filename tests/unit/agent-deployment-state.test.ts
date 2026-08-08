import { describe, expect, it } from "vitest";
import {
  AgentDeploymentDtoError,
  mapAgentDeploymentRowToDto,
} from "@/src/server/agents/deployment-dto";
import {
  AGENT_DEPLOYMENT_STAGES,
  checkAgentDeploymentTransition,
  normalizeDeploymentErrorDetail,
  normalizeDeploymentIdempotencyKey,
  parseAgentDeploymentStage,
  validateDeploymentLeaseDurationMs,
} from "@/src/server/agents/deployment-state";

const BASE_ROW = {
  id: "00000000-0000-4000-8000-000000000301",
  agentId: "00000000-0000-4000-8000-000000000201",
  stage: "pending",
  configRevision: "cfg-123",
  attemptCount: 0,
  errorCode: null,
  errorDetail: null,
  nextAttemptAt: null,
  startedAt: null,
  completedAt: null,
  failedAt: null,
  createdAt: new Date("2026-08-03T01:00:00.000Z"),
  updatedAt: new Date("2026-08-03T01:00:00.000Z"),
};

describe("agent deployment state contract", () => {
  it("parses exactly the eight persisted stages", () => {
    for (const stage of AGENT_DEPLOYMENT_STAGES) {
      expect(parseAgentDeploymentStage(stage)).toEqual({ ok: true, value: stage });
    }

    expect(parseAgentDeploymentStage("queued")).toEqual({ ok: false });
    expect(parseAgentDeploymentStage("READY")).toEqual({ ok: false });
    expect(parseAgentDeploymentStage(null)).toEqual({ ok: false });
  });

  it("allows only the linear forward graph plus the existing-runner skip", () => {
    expect(checkAgentDeploymentTransition("pending", "provisioning_runner")).toEqual({
      ok: true,
      kind: "transition",
    });
    expect(checkAgentDeploymentTransition("pending", "configuring_hermes")).toEqual({
      ok: true,
      kind: "transition",
    });
    expect(checkAgentDeploymentTransition("connecting_telegram", "ready")).toEqual({
      ok: true,
      kind: "transition",
    });
    expect(checkAgentDeploymentTransition("starting_gateway", "connecting_telegram")).toEqual({
      ok: true,
      kind: "transition",
    });
    expect(checkAgentDeploymentTransition("starting_gateway", "starting_gateway")).toEqual({
      ok: true,
      kind: "same_stage",
    });

    expect(checkAgentDeploymentTransition("pending", "starting_gateway")).toEqual({
      ok: false,
      reason: "invalid_transition",
    });
    expect(checkAgentDeploymentTransition("verifying_model", "starting_gateway")).toEqual({
      ok: false,
      reason: "invalid_transition",
    });
    expect(checkAgentDeploymentTransition("ready", "failed")).toEqual({
      ok: false,
      reason: "terminal_deployment",
    });
    expect(checkAgentDeploymentTransition("failed", "failed")).toEqual({
      ok: false,
      reason: "terminal_deployment",
    });
  });

  it("normalizes idempotency keys by trimming only outer whitespace and preserving case", () => {
    expect(normalizeDeploymentIdempotencyKey("  Same-Key-123  ")).toEqual({
      ok: true,
      value: "Same-Key-123",
    });
    expect(normalizeDeploymentIdempotencyKey(" short ")).toEqual({
      ok: false,
      reason: "invalid_idempotency_key",
    });
  });

  it("bounds leases and safe error details", () => {
    expect(validateDeploymentLeaseDurationMs(1)).toBe(true);
    expect(validateDeploymentLeaseDurationMs(5 * 60 * 1000)).toBe(true);
    expect(validateDeploymentLeaseDurationMs(0)).toBe(false);
    expect(validateDeploymentLeaseDurationMs(5 * 60 * 1000 + 1)).toBe(false);

    expect(normalizeDeploymentErrorDetail("  retry later  ")).toEqual({
      ok: true,
      value: "retry later",
    });
    expect(normalizeDeploymentErrorDetail("")).toEqual({
      ok: false,
      reason: "invalid_error_detail",
    });
    expect(normalizeDeploymentErrorDetail("x".repeat(501))).toEqual({
      ok: false,
      reason: "invalid_error_detail",
    });
  });

  it("maps DTOs without internal owner, idempotency, or lease fields", () => {
    const dto = mapAgentDeploymentRowToDto({
      ...BASE_ROW,
      stage: "failed",
      errorCode: "runner_unavailable",
      errorDetail: "Runner is not online.",
      startedAt: new Date("2026-08-03T01:01:00.000Z"),
      failedAt: new Date("2026-08-03T01:02:00.000Z"),
    });

    expect(dto).toEqual({
      id: BASE_ROW.id,
      agentId: BASE_ROW.agentId,
      stage: "failed",
      configRevision: "cfg-123",
      attemptCount: 0,
      error: {
        code: "runner_unavailable",
        detail: "Runner is not online.",
      },
      nextAttemptAt: null,
      startedAt: "2026-08-03T01:01:00.000Z",
      completedAt: null,
      failedAt: "2026-08-03T01:02:00.000Z",
      acceptedAt: null,
      createdAt: "2026-08-03T01:00:00.000Z",
      updatedAt: "2026-08-03T01:00:00.000Z",
    });
    expect(JSON.stringify(dto)).not.toMatch(/userId|idempotency|lease|endpoint|secret/i);
  });

  it("rejects persisted DTO rows that violate stage, error, revision, or timestamp invariants", () => {
    expect(() => mapAgentDeploymentRowToDto({ ...BASE_ROW, configRevision: " cfg-123" })).toThrow(
      AgentDeploymentDtoError,
    );
    expect(() =>
      mapAgentDeploymentRowToDto({
        ...BASE_ROW,
        stage: "ready",
        completedAt: new Date("2026-08-03T01:02:00.000Z"),
        errorCode: "still_present",
      }),
    ).toThrow(AgentDeploymentDtoError);
    expect(() =>
      mapAgentDeploymentRowToDto({
        ...BASE_ROW,
        stage: "failed",
        failedAt: new Date("2026-08-03T01:02:00.000Z"),
        errorCode: "BadCode",
      }),
    ).toThrow(AgentDeploymentDtoError);
    expect(() =>
      mapAgentDeploymentRowToDto({
        ...BASE_ROW,
        startedAt: new Date("2026-08-03T01:03:00.000Z"),
        completedAt: new Date("2026-08-03T01:02:00.000Z"),
        stage: "ready",
      }),
    ).toThrow(AgentDeploymentDtoError);
  });
});
