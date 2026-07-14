import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import { DEFAULT_HERMES_STATE_ROOT } from "@/src/runner-service/constants";

export type HermesProjectionResult = {
  agentRoot: string;
  hermesHome: string;
  workspace: string;
  configPath: string;
  envPath: string;
  soulPath: string;
  revisionPath: string;
};

export type HermesProjectionOptions = {
  stateRoot?: string;
  ownership?: {
    uid: number;
    gid: number;
  };
};

const MANAGED_FILES = ["config.yaml", ".env", "SOUL.md", "agentbay-config-revision.json"] as const;

export async function projectHermesHome(
  spec: AgentLaunchSpec,
  options: HermesProjectionOptions = {},
): Promise<HermesProjectionResult> {
  const stateRoot = resolve(
    options.stateRoot ?? process.env.AGENTBAY_HERMES_STATE_ROOT ?? DEFAULT_HERMES_STATE_ROOT,
  );
  const agentRoot = resolve(stateRoot, spec.agent.id);
  const hermesHome = resolve(agentRoot, "hermes");
  const workspace = resolve(agentRoot, "workspace");

  assertChildPath(stateRoot, agentRoot);
  assertChildPath(agentRoot, hermesHome);
  assertChildPath(agentRoot, workspace);
  await rejectSymlinkIfExists(stateRoot);
  await rejectSymlinkIfExists(agentRoot);
  await mkdir(hermesHome, { recursive: true, mode: 0o700 });
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await rejectSymlinkIfExists(hermesHome);
  await rejectSymlinkIfExists(workspace);

  const configPath = resolve(hermesHome, "config.yaml");
  const envPath = resolve(hermesHome, ".env");
  const soulPath = resolve(hermesHome, "SOUL.md");
  const revisionPath = resolve(hermesHome, "agentbay-config-revision.json");

  for (const fileName of MANAGED_FILES) {
    await rejectSymlinkIfExists(resolve(hermesHome, fileName));
  }

  await atomicWrite(configPath, renderHermesConfig(spec), 0o644, options.ownership);
  await atomicWrite(envPath, renderHermesEnv(spec), 0o600, options.ownership);
  await atomicWrite(soulPath, `${spec.prompt.soul.trim()}\n`, 0o644, options.ownership);
  await atomicWrite(
    revisionPath,
    `${JSON.stringify(
      {
        version: spec.version,
        requestId: spec.requestId,
        agentId: spec.agent.id,
        configRevision: spec.agent.configRevision,
        image: spec.image.ref,
      },
      null,
      2,
    )}\n`,
    0o644,
    options.ownership,
  );
  await pruneObsoleteManagedTemps(hermesHome);

  return {
    agentRoot,
    hermesHome,
    workspace,
    configPath,
    envPath,
    soulPath,
    revisionPath,
  };
}

export function renderHermesConfig(spec: AgentLaunchSpec): string {
  return [
    "model:",
    `  provider: ${yamlScalar(spec.model.provider)}`,
    `  model: ${yamlScalar(spec.model.model)}`,
    "terminal:",
    `  cwd: ${yamlScalar(spec.runtime.terminalCwd)}`,
    "tools:",
    "  enabled:",
    ...spec.tools.enabled.map((tool) => `    - ${yamlScalar(tool)}`),
    "  disabled:",
    ...spec.tools.disabled.map((tool) => `    - ${yamlScalar(tool)}`),
    "browser:",
    `  enabled: ${spec.runtime.browserEnabled ? "true" : "false"}`,
    "unattended:",
    `  loop_limit: ${spec.runtime.unattendedLoopLimit}`,
    "schedule:",
    `  mode: ${yamlScalar(spec.schedule.mode)}`,
    `  cron: ${spec.schedule.cron ? yamlScalar(spec.schedule.cron) : "null"}`,
    `  timezone: ${yamlScalar(spec.schedule.timezone)}`,
    "api_server:",
    "  enabled: true",
    "  auth:",
    "    env: API_SERVER_KEY",
    "messaging:",
    "  telegram:",
    "    enabled: true",
    "    polling: true",
    "    token_env: TELEGRAM_BOT_TOKEN",
    "    allowed_users_env: TELEGRAM_ALLOWED_USERS",
    "providers:",
    "  openrouter:",
    "    api_key_env: OPENROUTER_API_KEY",
    "",
  ].join("\n");
}

export function renderHermesEnv(spec: AgentLaunchSpec): string {
  return [
    `OPENROUTER_API_KEY=${envValue(spec.secrets.openrouterApiKey)}`,
    `TELEGRAM_BOT_TOKEN=${envValue(spec.secrets.telegramBotToken)}`,
    `TELEGRAM_ALLOWED_USERS=${envValue(spec.secrets.telegramAllowedUsers)}`,
    `API_SERVER_KEY=${envValue(spec.secrets.apiServerKey)}`,
    "",
  ].join("\n");
}

function envValue(value: string): string {
  return JSON.stringify(value);
}

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

async function atomicWrite(
  path: string,
  content: string,
  mode: number,
  ownership: HermesProjectionOptions["ownership"],
): Promise<void> {
  assertChildPath(dirname(path), path);
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  const handle = await open(tempPath, "wx", mode);

  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();

    if (ownership) {
      await writeFileOwnership(tempPath, ownership);
    }

    await rename(tempPath, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeFileOwnership(
  path: string,
  ownership: NonNullable<HermesProjectionOptions["ownership"]>,
): Promise<void> {
  const { chown } = await import("node:fs/promises");

  await chown(path, ownership.uid, ownership.gid);
}

async function pruneObsoleteManagedTemps(hermesHome: string): Promise<void> {
  for (const fileName of MANAGED_FILES) {
    await rm(resolve(hermesHome, `${fileName}.tmp`), { force: true }).catch(() => undefined);
  }
}

async function rejectSymlinkIfExists(path: string): Promise<void> {
  try {
    const stats = await lstat(path);

    if (stats.isSymbolicLink()) {
      throw new Error("Hermes projection path must not be a symbolic link.");
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

function assertChildPath(parent: string, child: string): void {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  const childRelative = relative(normalizedParent, normalizedChild);

  if (
    childRelative === "" ||
    childRelative.startsWith("..") ||
    childRelative.includes(`..${sep}`)
  ) {
    throw new Error("Hermes projection path escaped the managed root.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
