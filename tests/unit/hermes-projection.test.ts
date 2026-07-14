import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectHermesHome,
  renderHermesConfig,
  renderHermesEnv,
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

  it("renders deterministic Hermes config without secrets and env with only allowlisted secrets", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentbay-hermes-projection-"));
    const spec = sampleLaunchSpec();
    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(projected.configPath, "utf8");
    const env = await readFile(projected.envPath, "utf8");
    const soul = await readFile(projected.soulPath, "utf8");
    const revision = await readFile(projected.revisionPath, "utf8");
    const envMode = (await stat(projected.envPath)).mode & 0o777;

    expect(config).toBe(renderHermesConfig(spec));
    expect(env).toBe(renderHermesEnv(spec));
    expect(soul).toBe(`${spec.prompt.soul}\n`);
    expect(JSON.parse(revision)).toMatchObject({
      version: spec.version,
      requestId: spec.requestId,
      agentId: spec.agent.id,
      configRevision: spec.agent.configRevision,
      image: spec.image.ref,
    });
    expect(config).toContain('provider: "openrouter"');
    expect(config).toContain('cwd: "/workspace"');
    expect(config).not.toContain(spec.secrets.openrouterApiKey);
    expect(config).not.toContain(spec.secrets.telegramBotToken);
    expect(soul).not.toContain(spec.secrets.openrouterApiKey);
    expect(env).toContain(`OPENROUTER_API_KEY="${spec.secrets.openrouterApiKey}"`);
    expect(env).toContain(`TELEGRAM_ALLOWED_USERS="${spec.secrets.telegramAllowedUsers}"`);
    expect(envMode).toBe(0o600);
  });

  it("is idempotent for the same revision and rejects managed-path symlinks", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "agentbay-hermes-projection-"));
    const spec = sampleLaunchSpec();
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
