import { describe, expect, it } from "vitest";
import {
  RUNNER_REPLACEMENT_STATES,
  toSafeRunnerReplacementDto,
  transitionRunnerReplacement,
  type RunnerReplacementTransitionSource,
} from "@/src/server/runners/runner-replacement-state";

const NOW = new Date("2026-08-04T08:00:00.000Z");
const SOURCE_ID = "00000000-0000-4000-8000-000000005001";
const TARGET_ID = "00000000-0000-4000-8000-000000005002";

describe("runner replacement state", () => {
  it("advances through every committed state in order", () => {
    let current: RunnerReplacementTransitionSource = {
      sourceRunnerId: SOURCE_ID,
      state: "pending",
      generation: 0,
      targetRunnerId: null,
    };
    const observed = [current.state];

    for (let index = 0; index < 7; index += 1) {
      const transition = transitionRunnerReplacement({
        current,
        action:
          current.state === "provisioning_target"
            ? { kind: "advance", targetRunnerId: TARGET_ID }
            : { kind: "advance" },
        now: new Date(NOW.getTime() + index * 1_000),
      });
      expect(transition).not.toBeNull();
      current = transition as RunnerReplacementTransitionSource;
      observed.push(current.state);
    }

    expect(observed).toEqual(RUNNER_REPLACEMENT_STATES.filter((state) => state !== "failed"));
    expect(current).toMatchObject({
      state: "complete",
      generation: 7,
      targetRunnerId: TARGET_ID,
    });
  });

  it("requires a validated target before leaving target provisioning", () => {
    expect(
      transitionRunnerReplacement({
        current: {
          sourceRunnerId: SOURCE_ID,
          state: "provisioning_target",
          generation: 1,
          targetRunnerId: null,
        },
        action: { kind: "advance" },
        now: NOW,
      }),
    ).toBeNull();
  });

  it("schedules a same-state retry with a fresh generation fence", () => {
    const nextAttemptAt = new Date(NOW.getTime() + 30_000);
    expect(
      transitionRunnerReplacement({
        current: {
          sourceRunnerId: SOURCE_ID,
          state: "validating_target",
          generation: 4,
          targetRunnerId: TARGET_ID,
        },
        action: { kind: "retry", nextAttemptAt },
        now: NOW,
      }),
    ).toEqual({
      sourceRunnerId: SOURCE_ID,
      state: "validating_target",
      generation: 5,
      targetRunnerId: TARGET_ID,
      nextAttemptAt,
      terminalCode: null,
      terminalSummary: null,
      completedAt: null,
      failedAt: null,
    });
  });

  it("rejects retries in the past and transitions after terminal states", () => {
    expect(
      transitionRunnerReplacement({
        current: {
          sourceRunnerId: SOURCE_ID,
          state: "pending",
          generation: 0,
          targetRunnerId: null,
        },
        action: { kind: "retry", nextAttemptAt: new Date(NOW.getTime() - 1) },
        now: NOW,
      }),
    ).toBeNull();
    expect(
      transitionRunnerReplacement({
        current: {
          sourceRunnerId: SOURCE_ID,
          state: "complete",
          generation: 8,
          targetRunnerId: TARGET_ID,
        },
        action: { kind: "advance" },
        now: NOW,
      }),
    ).toBeNull();
  });

  it("maps failures to fixed safe summaries without accepting raw detail", () => {
    expect(
      transitionRunnerReplacement({
        current: {
          sourceRunnerId: SOURCE_ID,
          state: "validating_target",
          generation: 2,
          targetRunnerId: TARGET_ID,
        },
        action: { kind: "fail", code: "target_validation_failed" },
        now: NOW,
      }),
    ).toMatchObject({
      state: "failed",
      generation: 3,
      terminalCode: "target_validation_failed",
      terminalSummary: "Replacement runner validation did not pass.",
      failedAt: NOW,
    });
  });

  it("returns a bounded DTO and drops hostile internal fields", () => {
    const dto = toSafeRunnerReplacementDto({
      id: "00000000-0000-4000-8000-000000005001",
      sourceRunnerId: "00000000-0000-4000-8000-000000005003",
      targetRunnerId: TARGET_ID,
      reason: "boot_failure",
      state: "failed",
      terminalCode: "target_validation_failed",
      terminalSummary: "Replacement runner validation did not pass.",
      startedAt: NOW,
      completedAt: null,
      failedAt: NOW,
      providerError: "sk-hostile-provider-secret",
      leaseOwner: "internal-owner",
    } as Parameters<typeof toSafeRunnerReplacementDto>[0] & Record<string, unknown>);

    expect(dto).not.toBeNull();
    expect(Object.keys(dto ?? {}).sort()).toEqual([
      "completedAt",
      "failedAt",
      "id",
      "reason",
      "sourceRunnerId",
      "startedAt",
      "state",
      "targetRunnerId",
      "terminalCode",
      "terminalSummary",
    ]);
    expect(JSON.stringify(dto)).not.toContain("hostile-provider-secret");
    expect(JSON.stringify(dto)).not.toContain("internal-owner");
  });
});
