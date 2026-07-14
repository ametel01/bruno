import { mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectHermesHome,
  prepareHermesState,
  mergeHermesEnv,
} from "@/src/runner-service/hermes-projection";
import { sampleLaunchSpec } from "@/tests/helpers/agent-launch-spec";

describe("Hermes home projection", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("preserves Hermes-owned setup and merges only AgentBay API settings", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentbay-hermes-projection-"));
    const spec = sampleLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const setupConfig = 'model:\n  provider: "openai-codex"\n  model: "gpt-5.4"\n';
    const setupEnv = "HERMES_SETUP_SENTINEL=preserved\n";
    await writeFile(join(state.hermesHome, "config.yaml"), setupConfig, "utf8");
    await writeFile(join(state.hermesHome, ".env"), setupEnv, "utf8");
    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(projected.configPath, "utf8");
    const env = await readFile(projected.envPath, "utf8");
    const soul = await readFile(projected.soulPath, "utf8");
    const revision = await readFile(projected.revisionPath, "utf8");
    const envMode = (await stat(projected.envPath)).mode & 0o777;

    expect(config).toBe(setupConfig);
    expect(env).toBe(mergeHermesEnv(setupEnv, spec));
    expect(soul).toBe(`${spec.prompt.soul}\n`);
    expect(JSON.parse(revision)).toMatchObject({
      version: spec.version,
      requestId: spec.requestId,
      agentId: spec.agent.id,
      configRevision: spec.agent.configRevision,
      image: spec.image.ref,
    });
    expect(config).toContain('provider: "openai-codex"');
    expect(env).toContain("HERMES_SETUP_SENTINEL=preserved");
    expect(env).toContain("API_SERVER_ENABLED=true");
    expect(env).toContain(`API_SERVER_KEY="${spec.secrets.apiServerKey}"`);
    expect(soul).not.toContain(spec.secrets.apiServerKey);
    expect(envMode).toBe(0o600);
  });

  it("is idempotent for the same revision and rejects managed-path symlinks", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentbay-hermes-projection-"));
    const spec = sampleLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    await writeFile(
      join(state.hermesHome, "config.yaml"),
      'model:\n  provider: "openai-codex"\n  model: "gpt-5.4"\n',
      "utf8",
    );
    const first = await projectHermesHome(spec, { stateRoot: tempRoot });
    const second = await projectHermesHome(spec, { stateRoot: tempRoot });

    expect(await readFile(first.configPath, "utf8")).toBe(
      await readFile(second.configPath, "utf8"),
    );

    await rm(first.envPath);
    await symlink("/tmp/outside-agentbay", first.envPath);
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow("symbolic link");
  });
});
