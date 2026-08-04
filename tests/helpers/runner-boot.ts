import type { RunnerBootReadinessController } from "@/src/runner-service/boot-self-test";
import {
  RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
  type RunnerBootSnapshot,
} from "@/src/runner-service/runner-contracts";

export function readyRunnerBootSnapshot(
  overrides: Partial<RunnerBootSnapshot> = {},
): RunnerBootSnapshot {
  return {
    ok: true,
    contractVersion: RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION,
    status: "ready",
    components: {
      docker: "passed",
      hermesFixture: "passed",
      detailedHealth: "passed",
      modelCanary: "passed",
      telegramConfig: "passed",
      cleanup: "passed",
    },
    failureReason: null,
    startedAt: "2026-08-04T00:00:00.000Z",
    completedAt: "2026-08-04T00:00:01.000Z",
    ...overrides,
  };
}

export function readyRunnerBootController(): RunnerBootReadinessController {
  const snapshot = readyRunnerBootSnapshot();
  return {
    async read() {
      return snapshot;
    },
    async start() {},
  };
}
