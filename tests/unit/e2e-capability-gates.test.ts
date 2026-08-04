import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  CI_E2E_SELECTORS,
  type E2ECommand,
  FULL_E2E_CAPABILITY_MESSAGE,
  planE2ECommand,
  runE2E,
} from "@/scripts/run-e2e";

const EXPECTED_CI_SELECTORS = [
  "tests/e2e/health-route.spec.ts",
  "tests/e2e/root-route.spec.ts:45",
  "tests/e2e/root-route.spec.ts:60",
  "tests/e2e/root-route.spec.ts:2187",
  "tests/e2e/automatic-ready.spec.ts",
  "tests/e2e/runtime-presentation.spec.ts",
];

describe("E2E capability gates", () => {
  it("single-sources the exact credential-free selectors through the CI package command", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");

    expect(CI_E2E_SELECTORS).toEqual(EXPECTED_CI_SELECTORS);
    expect(packageJson.scripts["test:e2e:ci"]).toContain("scripts/run-e2e.ts ci");
    expect(packageJson.scripts["test:e2e"]).toContain("scripts/run-e2e.ts full");
    expect(packageJson.scripts.verify).not.toContain("test:e2e");
    expect(packageJson.scripts["verify:e2e"]).toBe("bun run verify && bun run test:e2e");
    expect(workflow).toContain("run: bun run test:e2e:ci");

    for (const selector of EXPECTED_CI_SELECTORS) {
      expect(workflow).not.toContain(selector);
    }

    const plan = planE2ECommand("ci", {}, { cwd: "/repo", platform: "linux" });
    expect(plan).toEqual({
      ok: true,
      command: {
        command: "/repo/node_modules/.bin/playwright",
        args: ["test", ...EXPECTED_CI_SELECTORS],
      },
    });
  });

  it.each([
    ["absent provider", {}],
    [
      "blank provider token",
      {
        AGENTBAY_DIGITALOCEAN_TOKEN: " ",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-value-must-not-print",
      },
    ],
    [
      "missing runner token",
      {
        AGENTBAY_DIGITALOCEAN_TOKEN: "provider-value-must-not-print",
      },
    ],
    [
      "invalid optional provider setting",
      {
        AGENTBAY_DIGITALOCEAN_TOKEN: "provider-value-must-not-print",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-value-must-not-print",
        AGENTBAY_DIGITALOCEAN_REGION: "invalid region value-must-not-print",
      },
    ],
  ])("fails once before Playwright for %s", async (_caseName, env) => {
    const commands: E2ECommand[] = [];
    const errors: string[] = [];

    const exitCode = await runE2E("full", env, {
      cwd: "/repo",
      platform: "linux",
      runCommand: async (command) => {
        commands.push(command);
        return 0;
      },
      writeError: (message) => errors.push(message),
    });

    expect(exitCode).toBe(1);
    expect(commands).toEqual([]);
    expect(errors).toEqual([FULL_E2E_CAPABILITY_MESSAGE]);
    expect(errors.join(" ")).not.toContain("value-must-not-print");
  });

  it.each([
    [
      "DigitalOcean",
      {
        AGENTBAY_DIGITALOCEAN_TOKEN: "synthetic-provider-token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "synthetic-runner-token",
        AGENTBAY_RUNNER_IMAGE: `ghcr.io/ametel01/agentbay-runner:sha-test@sha256:${"a".repeat(64)}`,
      },
    ],
    [
      "local Docker",
      {
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
        AGENTBAY_RUNNER_BEARER_TOKEN: "synthetic-runner-token",
        AGENTBAY_LOCAL_CLOUD_RUNNER_START_DELAY_MS: "0",
      },
    ],
  ])("delegates %s capability to the complete unfiltered Playwright suite", async (_name, env) => {
    const runCommand = vi.fn(async () => 0);

    await expect(
      runE2E("full", env, {
        cwd: "/repo",
        platform: "linux",
        runCommand,
      }),
    ).resolves.toBe(0);

    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith({
      command: "/repo/node_modules/.bin/playwright",
      args: ["test"],
    });
  });
});
