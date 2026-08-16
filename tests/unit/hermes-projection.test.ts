import { execFile } from "node:child_process";
import { link, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  type HermesProjectionFilesystem,
  projectHermesHome,
  prepareHermesState,
  mergeHermesEnv,
} from "@/src/runner-service/hermes-projection";
import {
  sampleDirectManagedLaunchSpec,
  sampleLaunchSpec,
  sampleManagedLaunchSpec,
} from "@/tests/helpers/agent-launch-spec";

const execFileAsync = promisify(execFile);
const envReference = (name: string) => `$${`{${name}}`}`;

describe("Hermes home projection", () => {
  let tempRoot: string | null = null;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it.each([
    ["openai-api", "OPENAI_API_KEY"],
    ["anthropic", "ANTHROPIC_API_KEY"],
  ] as const)("projects direct %s configuration without other provider keys", async (provider, envKey) => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-direct-"));
    const spec = sampleDirectManagedLaunchSpec(provider);
    const result = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(result.configPath, "utf8");
    const env = await readFile(result.envPath, "utf8");

    expect(config).toContain(`provider: ${provider}`);
    expect(config).toContain(`default: ${spec.model.model}`);
    expect(env).toContain(`${envKey}="${spec.secrets.modelApiKey}"`);
    expect(env).not.toContain("OPENROUTER_API_KEY");
    expect(env).not.toContain(provider === "anthropic" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY");
  });

  it("preserves Hermes-owned setup and merges only Bruno.Ai API settings", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const setupConfig = 'model:\n  provider: "openai-codex"\n  model: "gpt-5.4"\n';
    const setupEnv =
      "HERMES_SETUP_SENTINEL=preserved\nOPENROUTER_API_KEY=wizard-owned\nTELEGRAM_BOT_TOKEN=wizard-owned\n";
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
      agentId: spec.agent.id,
      configRevision: spec.agent.configRevision,
      image: spec.image.ref,
    });
    expect(config).toContain('provider: "openai-codex"');
    expect(env).toContain("HERMES_SETUP_SENTINEL=preserved");
    expect(env).toContain("API_SERVER_ENABLED=true");
    expect(env).toContain(`API_SERVER_KEY="${spec.secrets.apiServerKey}"`);
    expect(env).toContain("OPENROUTER_API_KEY=wizard-owned");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=wizard-owned");
    expect(soul).not.toContain(spec.secrets.apiServerKey);
    expect(envMode).toBe(0o600);
  });

  it("is idempotent for the same revision and rejects managed-path symlinks", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
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
    await symlink("/tmp/outside-bruno", first.envPath);
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "safe regular file",
    );
  });

  it("projects a complete managed v3 config from a fresh root without setup", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(projected.configPath, "utf8");
    const env = await readFile(projected.envPath, "utf8");
    const soul = await readFile(projected.soulPath, "utf8");
    const revision = await readFile(projected.revisionPath, "utf8");

    expect(config).toContain("_config_version: 12");
    expect(config).toContain("provider: openrouter");
    expect(config).toContain("default: openai/gpt-4.1-mini");
    expect(config).toContain("api_server:");
    expect(config).toContain("telegram:");
    expect(config).toContain("unauthorized_dm_behavior: ignore");
    expect(config).not.toContain(spec.secrets.openrouterApiKey);
    expect(config).not.toContain(spec.secrets.telegramBotToken);
    expect(config).not.toContain(spec.secrets.apiServerKey);
    expect(soul).toBe(`${spec.prompt.soul}\n`);
    expect(soul).not.toContain(spec.secrets.openrouterApiKey);
    expect(JSON.parse(revision)).toEqual({
      version: "bruno.hermes.launch.v3",
      agentId: spec.agent.id,
      configRevision: spec.agent.configRevision,
      image: spec.image.ref,
    });
    expect(env).toBe(mergeHermesEnv("", spec));
    expect(env).toContain(`OPENROUTER_API_KEY="${spec.secrets.openrouterApiKey}"`);
    expect(env).toContain(
      `TELEGRAM_ALLOWED_USERS="${spec.secrets.telegramAllowedUsers.join(",")}"`,
    );
    expect(env).toContain("API_SERVER_PORT=8642");
  });

  it("preserves unrelated safe YAML while managed v3 removes aliases and legacy env keys", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec({
      agent: { ...sampleManagedLaunchSpec().agent, configRevision: "cfg-new-revision" },
    });
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    await writeFile(
      join(state.hermesHome, "config.yaml"),
      [
        "model:",
        "  provider: old-provider",
        "  temperature: 0.2",
        "terminal:",
        "  theme: matrix",
        "api_server:",
        "  enabled: false",
        "gateway:",
        "  platforms:",
        "    telegram:",
        "      enabled: false",
        "custom:",
        "  nested: preserved",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(state.hermesHome, ".env"),
      [
        "OPENROUTER_API_KEY=old",
        "export TELEGRAM_BOT_TOKEN=old",
        "TELEGRAM_ALLOWED_USERS=old",
        "WIZARD_SETTING=preserved",
        "",
      ].join("\n"),
      "utf8",
    );

    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(projected.configPath, "utf8");
    const env = await readFile(projected.envPath, "utf8");
    const firstConfig = config;

    await projectHermesHome(spec, { stateRoot: tempRoot });

    expect(await readFile(projected.configPath, "utf8")).toBe(firstConfig);
    expect(config).toContain("temperature: 0.2");
    expect(config).toContain("nested: preserved");
    expect(config).not.toContain("api_server:\n  enabled: false");
    expect(env).toContain("WIZARD_SETTING=preserved");
    expect(env).not.toContain("OPENROUTER_API_KEY=old");
    expect(env).not.toContain("TELEGRAM_BOT_TOKEN=old");
  });

  it("rejects unsafe YAML without replacing the old authoritative marker", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    await writeFile(join(state.hermesHome, "config.yaml"), "safe: true\n", "utf8");
    await writeFile(
      join(state.hermesHome, "bruno-config-revision.json"),
      '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
      "utf8",
    );
    await writeFile(join(state.hermesHome, "config.yaml"), "secret_token: plaintext\n", "utf8");

    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );
    expect(await readFile(join(state.hermesHome, "bruno-config-revision.json"), "utf8")).toBe(
      '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
    );
  });

  it("rejects secret-like YAML values unless they are exact env references", async () => {
    const invalidSecretConfigs = [
      "password: null\n",
      "api_key:\n  nested: safe\n",
      `token:\n  - ${envReference("TOKEN")}\n`,
      "credential: true\n",
      "authorization: 123\n",
      `private_key: ${envReference("KEY:-plaintext")}\n`,
      `secret: ${envReference("KEY-default")}\n`,
      "custom:\n  nested_token: env:TOKEN\n  password: null\n",
    ];

    for (const config of invalidSecretConfigs) {
      tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
      const spec = sampleManagedLaunchSpec();
      const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

      await writeFile(join(state.hermesHome, "config.yaml"), config, "utf8");
      await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
        "Hermes projection is invalid.",
      );
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }

    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

    await writeFile(
      join(state.hermesHome, "config.yaml"),
      `password: ${envReference("HERMES_PASSWORD")}\ncredential: env:HERMES_CREDENTIAL\n`,
      "utf8",
    );
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).resolves.toMatchObject({
      hermesHome: state.hermesHome,
    });
  });

  it("rejects YAML directives, markers, anchors, aliases, tags, merge keys, duplicates, and unsafe shapes", async () => {
    const deepYaml = `${Array.from({ length: 66 }, (_, index) => `${"  ".repeat(index)}k${index}:`).join("\n")}\n${"  ".repeat(66)}leaf: true\n`;
    const tooManyEntries = `${Array.from({ length: 4_097 }, (_, index) => `k${index}: ${index}`).join("\n")}\n`;
    const tooLarge = `safe: ${"x".repeat(256 * 1024)}\n`;
    const unsafeConfigs = [
      "%YAML 1.2\nsafe: true\n",
      "---\nsafe: true\n",
      "safe: true\n...\n",
      "base: &base\n  safe: true\n",
      "copy: *base\n",
      "custom: !!str tagged\n",
      "custom: !unsafe tagged\n",
      "base: &base\n  safe: true\nmerged:\n  <<: *base\n",
      "duplicate: one\nduplicate: two\n",
      "first: true\n---\nsecond: true\n",
      "? [list]\n: value\n",
      "__proto__:\n  polluted: true\n",
      "prototype: true\n",
      "constructor: true\n",
      "nan: .nan\n",
      deepYaml,
      tooManyEntries,
      tooLarge,
    ];

    for (const config of unsafeConfigs) {
      tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
      const spec = sampleManagedLaunchSpec();
      const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

      await writeFile(join(state.hermesHome, "config.yaml"), config, "utf8");
      await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
        "Hermes projection is invalid.",
      );
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("preserves safe unrelated YAML scalar text containing punctuation", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

    await writeFile(
      join(state.hermesHome, "config.yaml"),
      [
        'quoted_bang: "hello !important"',
        'quoted_glob: "use *glob"',
        'quoted_amp: "rock &roll"',
        "literal_note: |",
        "  Keep !important in docs.",
        "  Use *glob and rock &roll.",
        "",
      ].join("\n"),
      "utf8",
    );

    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const config = await readFile(projected.configPath, "utf8");

    expect(config).toContain("quoted_bang: hello !important");
    expect(config).toContain("quoted_glob: use *glob");
    expect(config).toContain("quoted_amp: rock &roll");
    expect(config).toContain("Keep !important in docs.");
    expect(config).toContain("Use *glob and rock &roll.");
  });

  it("normalizes CRLF/export/duplicate managed env and rejects malformed multiline managed env", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

    await writeFile(
      join(state.hermesHome, ".env"),
      [
        "export OPENROUTER_API_KEY=old\r",
        "TELEGRAM_BOT_TOKEN=old\r",
        "TELEGRAM_BOT_TOKEN=older\r",
        "UNRELATED=value\r",
        "",
      ].join("\n"),
      "utf8",
    );
    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });
    const env = await readFile(projected.envPath, "utf8");

    expect(env).toContain("UNRELATED=value\n");
    expect(env).not.toContain("old");
    expect(env).toContain(`TELEGRAM_BOT_TOKEN="${spec.secrets.telegramBotToken}"`);

    await writeFile(join(state.hermesHome, ".env"), "API_SERVER_KEY\n", "utf8");
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );

    await writeFile(join(state.hermesHome, ".env"), "UNRELATED=value \\\nNEXT=value\n", "utf8");
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );
  });

  it("rejects hard-linked final targets and cleans staged temp files without moving the marker", async () => {
    for (const fileName of ["config.yaml", ".env", "SOUL.md", "bruno-config-revision.json"]) {
      tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
      const spec = sampleManagedLaunchSpec();
      const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
      const source = join(state.hermesHome, `${fileName}.source`);

      await writeFile(source, fileName === "config.yaml" ? "safe: true\n" : "safe\n", "utf8");
      await link(source, join(state.hermesHome, fileName));
      await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
        "Hermes projection is invalid.",
      );
      expect((await readdir(state.hermesHome)).filter((entry) => entry.includes(".tmp-"))).toEqual(
        [],
      );
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("rejects symlinks at every projected target", async () => {
    for (const fileName of ["config.yaml", ".env", "SOUL.md", "bruno-config-revision.json"]) {
      tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
      const spec = sampleManagedLaunchSpec();
      const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

      await symlink("/tmp/outside-bruno", join(state.hermesHome, fileName));
      await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
        "Hermes projection is invalid.",
      );
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("rejects nonregular targets, non-directory state components, and oversized existing files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const fifoPath = join(state.hermesHome, ".env");
    await execFileAsync("mkfifo", [fifoPath]);
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );
    await rm(tempRoot, { recursive: true, force: true });

    tempRoot = await mkdtemp("/tmp/ahp-socket-");
    const socketState = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const socketPath = join(socketState.hermesHome, "SOUL.md");
    const server = createServer();

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
        "Hermes projection is invalid.",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await rm(tempRoot, { recursive: true, force: true });

    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    await writeFile(join(tempRoot, spec.agent.id), "not a directory", "utf8");
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );
    await rm(tempRoot, { recursive: true, force: true });

    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const oversizedState = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    await writeFile(
      join(oversizedState.hermesHome, "config.yaml"),
      `safe: ${"x".repeat(256 * 1024)}\n`,
      "utf8",
    );
    await expect(projectHermesHome(spec, { stateRoot: tempRoot })).rejects.toThrow(
      "Hermes projection is invalid.",
    );
  });

  it("sets exact directory and file modes for managed projection outputs", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const projected = await projectHermesHome(spec, { stateRoot: tempRoot });

    await expect(stat(projected.agentRoot)).resolves.toMatchObject({ mode: expect.any(Number) });
    expect((await stat(projected.agentRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(projected.hermesHome)).mode & 0o777).toBe(0o700);
    expect((await stat(projected.workspace)).mode & 0o777).toBe(0o700);
    expect((await stat(projected.configPath)).mode & 0o777).toBe(0o644);
    expect((await stat(projected.envPath)).mode & 0o777).toBe(0o600);
    expect((await stat(projected.soulPath)).mode & 0o777).toBe(0o644);
    expect((await stat(projected.revisionPath)).mode & 0o777).toBe(0o644);
  });

  it("uses injected ownership hooks for directories and all staged files", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const chownCalls: Array<{ path: string; uid: number; gid: number }> = [];
    const handleChownCalls: Array<{ uid: number; gid: number }> = [];

    await projectHermesHome(sampleManagedLaunchSpec(), {
      stateRoot: tempRoot,
      ownership: { uid: 10000, gid: 10000 },
      fs: {
        chown: async (path, uid, gid) => {
          chownCalls.push({ path, uid, gid });
        },
        handleChown: async (_handle, uid, gid) => {
          handleChownCalls.push({ uid, gid });
        },
      },
    });

    expect(chownCalls).toHaveLength(3);
    expect(chownCalls.map((call) => [call.uid, call.gid])).toEqual([
      [10000, 10000],
      [10000, 10000],
      [10000, 10000],
    ]);
    expect(handleChownCalls).toEqual([
      { uid: 10000, gid: 10000 },
      { uid: 10000, gid: 10000 },
      { uid: 10000, gid: 10000 },
      { uid: 10000, gid: 10000 },
    ]);
  });

  it("fails closed on owned temp collisions without removing preexisting temp paths", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const tempSuffix = Buffer.alloc(12, 0xab).toString("hex");
    const collidingTemp = join(state.hermesHome, `.config.yaml.tmp-${tempSuffix}`);

    await symlink("/tmp/outside-bruno", collidingTemp);
    await expect(
      projectHermesHome(spec, {
        stateRoot: tempRoot,
        fs: { randomBytes: () => Buffer.alloc(12, 0xab) },
      }),
    ).rejects.toThrow("Hermes projection is invalid.");
    expect((await readdir(state.hermesHome)).filter((entry) => entry.includes(tempSuffix))).toEqual(
      [`.config.yaml.tmp-${tempSuffix}`],
    );
  });

  it("cleans owned temps and preserves the old marker on injected stage and marker failures", async () => {
    const failureCases: Array<{
      name: string;
      fs: Partial<HermesProjectionFilesystem>;
    }> = [
      {
        name: "write",
        fs: {
          handleWriteFile: async () => {
            throw new Error("injected write failure");
          },
        },
      },
      {
        name: "chmod",
        fs: {
          handleChmod: async () => {
            throw new Error("injected chmod failure");
          },
        },
      },
      {
        name: "chown",
        fs: {
          handleChown: async () => {
            throw new Error("injected chown failure");
          },
        },
      },
      {
        name: "fsync",
        fs: {
          handleSync: async () => {
            throw new Error("injected fsync failure");
          },
        },
      },
      {
        name: "marker-rename",
        fs: {
          rename: async (from, to) => {
            if (String(to).endsWith("bruno-config-revision.json")) {
              throw new Error("injected marker rename failure");
            }
            await import("node:fs/promises").then(({ rename }) => rename(from, to));
          },
        },
      },
    ];

    for (const failureCase of failureCases) {
      tempRoot = await mkdtemp(join(tmpdir(), `bruno-hermes-${failureCase.name}-`));
      const spec = sampleManagedLaunchSpec();
      const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });

      await writeFile(
        join(state.hermesHome, "bruno-config-revision.json"),
        '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
        "utf8",
      );
      await expect(
        projectHermesHome(spec, {
          stateRoot: tempRoot,
          ownership: { uid: 10000, gid: 10000 },
          fs: {
            chown: async () => undefined,
            handleChown: async () => undefined,
            ...failureCase.fs,
          },
        }),
      ).rejects.toThrow("Hermes projection is invalid.");
      expect(await readFile(join(state.hermesHome, "bruno-config-revision.json"), "utf8")).toBe(
        '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
      );
      expect((await readdir(state.hermesHome)).filter((entry) => entry.includes(".tmp-"))).toEqual(
        [],
      );
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = null;
    }
  });

  it("repairs projection after marker-last interruption without deleting workspace data", async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "bruno-hermes-projection-"));
    const spec = sampleManagedLaunchSpec();
    const state = await prepareHermesState(spec.agent.id, { stateRoot: tempRoot });
    const workspaceSentinel = join(state.workspace, "sentinel.txt");
    let failedMarker = false;

    await writeFile(workspaceSentinel, "preserved", "utf8");
    await writeFile(
      join(state.hermesHome, "bruno-config-revision.json"),
      '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
      "utf8",
    );
    await expect(
      projectHermesHome(spec, {
        stateRoot: tempRoot,
        fs: {
          rename: async (from, to) => {
            if (!failedMarker && String(to).endsWith("bruno-config-revision.json")) {
              failedMarker = true;
              throw new Error("injected marker interruption");
            }
            await import("node:fs/promises").then(({ rename }) => rename(from, to));
          },
        },
      }),
    ).rejects.toThrow("Hermes projection is invalid.");
    expect(await readFile(join(state.hermesHome, "bruno-config-revision.json"), "utf8")).toBe(
      '{"version":"old","agentId":"old","configRevision":"old","image":"old"}\n',
    );

    const repaired = await projectHermesHome(spec, { stateRoot: tempRoot });

    expect(JSON.parse(await readFile(repaired.revisionPath, "utf8"))).toMatchObject({
      configRevision: spec.agent.configRevision,
    });
    expect(await readFile(workspaceSentinel, "utf8")).toBe("preserved");
  });
});
