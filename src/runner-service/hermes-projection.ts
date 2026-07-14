import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
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

export type HermesStatePaths = Pick<
  HermesProjectionResult,
  "agentRoot" | "hermesHome" | "workspace"
>;

const GUARDED_FILES = ["config.yaml", ".env", "SOUL.md", "agentbay-config-revision.json"] as const;

export async function projectHermesHome(
  spec: AgentLaunchSpec,
  options: HermesProjectionOptions = {},
): Promise<HermesProjectionResult> {
  const state = await prepareHermesState(spec.agent.id, options);
  const { hermesHome } = state;

  const configPath = resolve(hermesHome, "config.yaml");
  const envPath = resolve(hermesHome, ".env");
  const soulPath = resolve(hermesHome, "SOUL.md");
  const revisionPath = resolve(hermesHome, "agentbay-config-revision.json");

  for (const fileName of GUARDED_FILES) {
    await rejectSymlinkIfExists(resolve(hermesHome, fileName));
  }

  const config = await readExistingFile(configPath);

  if (!config?.trim()) {
    throw new HermesSetupRequiredError();
  }

  const existingEnv = (await readExistingFile(envPath)) ?? "";
  await atomicWrite(envPath, mergeHermesEnv(existingEnv, spec), 0o600, options.ownership);
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
    ...state,
    configPath,
    envPath,
    soulPath,
    revisionPath,
  };
}

export async function prepareHermesState(
  agentId: string,
  options: HermesProjectionOptions = {},
): Promise<HermesStatePaths> {
  const stateRoot = resolve(
    options.stateRoot ?? process.env.AGENTBAY_HERMES_STATE_ROOT ?? DEFAULT_HERMES_STATE_ROOT,
  );
  const agentRoot = resolve(stateRoot, agentId);
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

  return {
    agentRoot,
    hermesHome,
    workspace,
  };
}

function renderHermesEnv(spec: AgentLaunchSpec): string {
  return [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    `API_SERVER_KEY=${envValue(spec.secrets.apiServerKey)}`,
    "",
  ].join("\n");
}

export function mergeHermesEnv(existing: string, spec: AgentLaunchSpec): string {
  const managedKeys = new Set(["API_SERVER_ENABLED", "API_SERVER_HOST", "API_SERVER_KEY"]);
  const preserved = existing
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
      return !match?.[1] || !managedKeys.has(match[1]);
    });

  while (preserved.at(-1) === "") {
    preserved.pop();
  }

  return `${preserved.length > 0 ? `${preserved.join("\n")}\n` : ""}${renderHermesEnv(spec)}`;
}

export class HermesSetupRequiredError extends Error {
  constructor() {
    super("Hermes setup is required.");
    this.name = "HermesSetupRequiredError";
  }
}

function envValue(value: string): string {
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

async function readExistingFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

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
  for (const fileName of GUARDED_FILES) {
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
