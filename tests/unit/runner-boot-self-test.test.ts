import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildRunnerBootLaunchSpec,
  createDockerRunnerBootSelfTestExecutor,
  createRunnerBootReadinessController,
  projectRunnerBootFixtureHermesHome,
  RunnerBootSelfTestError,
  type RunnerBootFixture,
  type RunnerBootSelfTestExecutor,
} from "@/src/runner-service/boot-self-test";
import { parseRunnerBootSnapshot } from "@/src/runner-service/runner-contracts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("runner boot self-test", () => {
  it("projects the synthetic fixture for the Hermes workload identity", async () => {
    const root = await temporaryRoot();
    const directoryOwnership: Array<{ path: string; uid: number; gid: number }> = [];
    const fileOwnership: Array<{ uid: number; gid: number }> = [];
    const agentId = "00000000-0000-4000-8000-000000000123";

    const projection = await projectRunnerBootFixtureHermesHome({
      fakeModelContainer: "bruno-boot-abcdef012345-model",
      spec: buildRunnerBootLaunchSpec({ agentId, configRevision: "boot-test" }),
      stateRoot: root,
      fs: {
        chown: async (path, uid, gid) => {
          directoryOwnership.push({ path, uid, gid });
        },
        handleChown: async (_handle, uid, gid) => {
          fileOwnership.push({ uid, gid });
        },
      },
    });

    expect(directoryOwnership).toEqual(
      [projection.agentRoot, projection.hermesHome, projection.workspace].map((path) => ({
        path,
        uid: 10_000,
        gid: 10_000,
      })),
    );
    expect(fileOwnership).toEqual(Array.from({ length: 4 }, () => ({ uid: 10_000, gid: 10_000 })));
  });

  it("persists ready only after every capability and cleanup passes", async () => {
    const { controller, calls, snapshotPath } = await createHarness();

    await Promise.all([controller.start(), controller.start()]);

    expect(calls).toEqual([
      "recover",
      "docker",
      "launch",
      "health",
      "canary",
      "cleanup",
      "recover",
    ]);
    const snapshot = parseRunnerBootSnapshot(JSON.parse(await readFile(snapshotPath, "utf8")));
    expect(snapshot).toMatchObject({
      status: "ready",
      failureReason: null,
      components: {
        docker: "passed",
        hermesFixture: "passed",
        detailedHealth: "passed",
        modelCanary: "passed",
        telegramConfig: "passed",
        cleanup: "passed",
      },
    });
    await expect(controller.read()).resolves.toEqual(snapshot);
  });

  it("uses only safe enum evidence and always cleans up after hostile failures", async () => {
    const secret = "sk-hostile-fixture-secret";
    const { controller, calls } = await createHarness({
      async probeDetailedHealth() {
        throw new Error(`${secret}\ncontainer stderr owned-by-another-user`);
      },
    });

    await controller.start();

    const snapshot = await controller.read();
    expect(snapshot).toMatchObject({
      status: "failed",
      failureReason: "detailed_health_failed",
      components: { detailedHealth: "failed", cleanup: "passed" },
    });
    expect(calls).toContain("cleanup");
    expect(JSON.stringify(snapshot)).not.toContain(secret);
    expect(JSON.stringify(snapshot)).not.toContain("owned-by-another-user");
  });

  it("recovers from a transient model canary failure before declaring boot failed", async () => {
    let canaryAttempts = 0;
    const { controller } = await createHarness({
      async runCanary() {
        canaryAttempts += 1;
        if (canaryAttempts === 1) {
          throw new RunnerBootSelfTestError("canary_failed");
        }
      },
    });

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "ready",
      failureReason: null,
      components: { modelCanary: "passed", cleanup: "passed" },
    });
    expect(canaryAttempts).toBe(2);
  });

  it("skips the model canary when production boot disables it", async () => {
    const { controller, calls } = await createHarness({}, 1_000, 1_000, {
      modelCanaryEnabled: false,
    });

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "ready",
      failureReason: null,
      components: {
        docker: "passed",
        hermesFixture: "passed",
        detailedHealth: "passed",
        modelCanary: "skipped",
        telegramConfig: "passed",
        cleanup: "passed",
      },
    });
    expect(calls).not.toContain("canary");
  });

  it("enforces the total deadline even when a fixture operation ignores abort", async () => {
    const { controller, calls } = await createHarness(
      { launchFixture: async () => await new Promise<RunnerBootFixture>(() => undefined) },
      10,
    );

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "failed",
      failureReason: "deadline_exceeded",
      components: { hermesFixture: "failed", cleanup: "passed" },
    });
    expect(calls).toContain("cleanup");
  });

  it("reports cleanup failure without exposing its error", async () => {
    const { controller } = await createHarness({
      async cleanup() {
        throw new RunnerBootSelfTestError("cleanup_failed");
      },
    });

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "failed",
      failureReason: "cleanup_failed",
      components: { cleanup: "failed" },
    });
  });

  it("bounds cleanup even when the cleanup operation ignores abort", async () => {
    const { controller } = await createHarness(
      { cleanup: async () => await new Promise<void>(() => undefined) },
      1_000,
      10,
    );

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "failed",
      failureReason: "cleanup_failed",
      components: { cleanup: "failed" },
    });
  });

  it("attributes synthetic Telegram configuration failures to that component", async () => {
    const { controller } = await createHarness({
      async launchFixture() {
        throw new RunnerBootSelfTestError("telegram_config_failed");
      },
    });

    await controller.start();

    await expect(controller.read()).resolves.toMatchObject({
      status: "failed",
      failureReason: "telegram_config_failed",
      components: { hermesFixture: "failed", telegramConfig: "failed", cleanup: "passed" },
    });
  });

  it("recovers only valid owned descriptors after process restart", async () => {
    const root = await temporaryRoot();
    const validId = "00000000-0000-4000-8000-000000000111";
    const hostileId = "00000000-0000-4000-8000-000000000222";
    const validRoot = join(root, "fixtures", validId);
    const hostileRoot = join(root, "fixtures", hostileId);
    await mkdir(validRoot, { recursive: true });
    await mkdir(hostileRoot, { recursive: true });
    await writeFile(
      join(validRoot, "fixture.json"),
      JSON.stringify({
        agentId: "00000000-0000-4000-8000-000000000333",
        fakeModelContainer: "bruno-boot-abcdef012345-model",
        network: "bruno-boot-abcdef012345",
      }),
    );
    await writeFile(
      join(hostileRoot, "fixture.json"),
      JSON.stringify({
        agentId: "../../../another-agent",
        fakeModelContainer: "user-container",
        network: "bridge",
      }),
    );
    const calls: string[][] = [];
    const executor = createDockerRunnerBootSelfTestExecutor({
      root,
      docker: async (_executable, args) => {
        calls.push([...args]);
        return { stdout: args[0] === "ps" ? "a".repeat(64) : "", stderr: "" };
      },
    });

    await executor.recover(new AbortController().signal);

    await expect(stat(validRoot)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(hostileRoot)).resolves.toBeDefined();
    expect(calls).toContainEqual([
      "ps",
      "--all",
      "--quiet",
      "--filter",
      "label=bruno.agent_id=00000000-0000-4000-8000-000000000333",
      "--filter",
      "label=bruno.boot_fixture=v1",
    ]);
    expect(JSON.stringify(calls)).not.toContain("user-container");
    expect(JSON.stringify(calls)).not.toContain("bridge");
  });
});

async function createHarness(
  overrides: Partial<RunnerBootSelfTestExecutor> = {},
  timeoutMs = 1_000,
  cleanupTimeoutMs = 1_000,
  controllerOptions: { modelCanaryEnabled?: boolean } = {},
) {
  const root = await temporaryRoot();
  const snapshotPath = join(root, "boot.json");
  const calls: string[] = [];
  const fixture = {
    agentId: "00000000-0000-4000-8000-000000000123",
    configRevision: "boot-test",
    fakeModelContainer: "bruno-boot-abcdef012345-model",
    network: "bruno-boot-abcdef012345",
    operationId: "00000000-0000-4000-8000-000000000456",
    root,
    runner: {} as RunnerBootFixture["runner"],
  };
  const executor: RunnerBootSelfTestExecutor = {
    async recover() {
      calls.push("recover");
    },
    async verifyDockerAndRelease() {
      calls.push("docker");
    },
    async launchFixture() {
      calls.push("launch");
      return fixture;
    },
    async probeDetailedHealth() {
      calls.push("health");
    },
    async runCanary() {
      calls.push("canary");
    },
    async cleanup() {
      calls.push("cleanup");
    },
    ...overrides,
  };
  const controller = createRunnerBootReadinessController({
    executor,
    snapshotPath,
    timeoutMs,
    cleanupTimeoutMs,
    canaryRetryDelayMs: 0,
    ...controllerOptions,
    now: vi
      .fn<() => Date>()
      .mockReturnValueOnce(new Date("2026-08-04T00:00:00.000Z"))
      .mockReturnValue(new Date("2026-08-04T00:00:01.000Z")),
  });
  return { calls, controller, snapshotPath };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bruno-runner-boot-"));
  roots.push(root);
  return root;
}
