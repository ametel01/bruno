import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const COMMAND = ["--conditions", "react-server", "scripts/run-production-rollout.ts"] as const;

describe("production rollout operator CLI", () => {
  it("fails closed without protected authorization or credentials", () => {
    const result = spawnSync("bun", [...COMMAND, "preflight", "optimized"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: "bruno.production-rollout.preflight.v1",
      command: "preflight",
      step: "optimized",
      effects: 0,
      ok: false,
      issues: [
        "authorization",
        "protected_environment",
        "provider_credentials",
        "qstash_credentials",
        "snapshot_evidence",
        "release_evidence",
        "configuration",
      ],
    });
  });

  it("prints a sanitized zero-effect plan for the complete rollback sequence", () => {
    const result = spawnSync("bun", [...COMMAND, "plan"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "test",
        DO_NOT_PRINT: "secret-canary",
      },
    });

    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      schemaVersion: "bruno.production-rollout.plan.v1",
      authorizationId: "issue-300-20260815-g2",
      effects: 0,
      maximumExerciseSpendCents: 0,
    });
    expect(output.steps).toHaveLength(13);
    expect(output.steps.at(-1)).toMatchObject({
      name: "optimized",
      generation: 27,
      coldProvisioningHaltReason: null,
    });
    expect(result.stdout).not.toContain("secret-canary");
  });

  it("turns repeated functional failures into an executable rollback decision", () => {
    const directory = mkdtempSync(join(tmpdir(), "bruno-rollout-signals-"));
    const inputPath = join(directory, "signals.json");
    try {
      writeFileSync(
        inputPath,
        JSON.stringify({
          activeDeploymentGenerations: [2, 3],
          signals: [
            { kind: "functional_failure", feature: "dispatch" },
            { kind: "functional_failure", feature: "dispatch" },
          ],
        }),
      );
      const result = spawnSync("bun", [...COMMAND, "evaluate", "qstash", inputPath], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { PATH: process.env.PATH, NODE_ENV: "test" },
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: "bruno.production-rollout.signal-decision.v1",
        effects: 0,
        decision: {
          action: "rollback",
          feature: "dispatch",
          targetDefaults: { dispatchMode: "cron" },
          preserveActiveDeploymentGenerations: [2, 3],
        },
      });
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("fails closed when signal evidence is malformed", () => {
    const result = spawnSync("bun", [...COMMAND, "evaluate", "qstash", "missing.json"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { PATH: process.env.PATH, NODE_ENV: "test" },
    });

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effects: 0,
      decision: { action: "halt", haltReason: "artifact_identity_violation" },
    });
  });
});
