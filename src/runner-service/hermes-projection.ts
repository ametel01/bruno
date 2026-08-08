import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { type Document, type Node, parseAllDocuments, stringify, visit } from "yaml";
import { DEFAULT_HERMES_STATE_ROOT } from "@/src/runner-service/constants";
import {
  type AgentLaunchSpec,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
  type ManagedAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";

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
  fs?: Partial<HermesProjectionFilesystem>;
  stateRoot?: string;
  ownership?: {
    uid: number;
    gid: number;
  };
};

export type HermesProjectionFilesystem = {
  chmod: typeof chmod;
  chown: (path: string, uid: number, gid: number) => Promise<void>;
  handleChmod: (handle: ProjectionFileHandle, mode: number) => Promise<void>;
  handleChown: (handle: ProjectionFileHandle, uid: number, gid: number) => Promise<void>;
  handleSync: (handle: ProjectionFileHandle) => Promise<void>;
  handleWriteFile: (handle: ProjectionFileHandle, content: string) => Promise<void>;
  mkdir: typeof mkdir;
  open: typeof open;
  randomBytes: typeof cryptoRandomBytes;
  rename: typeof rename;
  rm: typeof rm;
};

type ProjectionFileHandle = Awaited<ReturnType<typeof open>>;

export type HermesStatePaths = Pick<
  HermesProjectionResult,
  "agentRoot" | "hermesHome" | "workspace"
>;

type PlainYamlValue = null | string | number | boolean | PlainYamlArray | PlainYamlRecord;
type PlainYamlArray = PlainYamlValue[];
type PlainYamlRecord = {
  [key: string]: PlainYamlValue;
};

const DIRECTORY_MODE = 0o700;
const ENV_MODE = 0o600;
const PUBLIC_FILE_MODE = 0o644;
const GUARDED_FILES = ["config.yaml", ".env", "SOUL.md", "bruno-config-revision.json"] as const;
const MANAGED_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_USERS",
  "API_SERVER_KEY",
  "API_SERVER_ENABLED",
  "API_SERVER_HOST",
  "API_SERVER_PORT",
  "GATEWAY_ALLOW_ALL_USERS",
  "TELEGRAM_ALLOW_ALL_USERS",
] as const;
const MANAGED_ENV_KEY_SET = new Set<string>(MANAGED_ENV_KEYS);
const NATIVE_ENV_KEY_SET = new Set<string>([
  "API_SERVER_ENABLED",
  "API_SERVER_HOST",
  "API_SERVER_KEY",
]);
const MAX_CONFIG_YAML_BYTES = 256 * 1024;
const MAX_ENV_BYTES = 256 * 1024;
const MAX_COLLECTION_ENTRIES = 4_096;
const MAX_NESTING_DEPTH = 64;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const SECRET_KEY_PATTERN =
  /(^|_|\b)(token|password|credential|authorization|private[_-]?key|api[_-]?key|secret)(_|$|\b)/i;
const ENV_REFERENCE_PATTERN = /^(?:\$\{[A-Z_][A-Z0-9_]*\}|env:[A-Z_][A-Z0-9_]*)$/;
const OPENROUTER_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/;
const OPENAI_KEY_PATTERN = /^sk-(?!ant-|or-v1-)[A-Za-z0-9_-]{20,}$/;
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_BOT_TOKEN_PATTERN = /^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{20,}$/;
const API_SERVER_KEY_PATTERN = /^bruno_agent_[A-Za-z0-9_-]{32,}$/;
const NODE_FS: HermesProjectionFilesystem = {
  chmod,
  async chown(path, uid, gid) {
    const { chown: nodeChown } = await import("node:fs/promises");

    await nodeChown(path, uid, gid);
  },
  handleChmod: (handle, mode) => handle.chmod(mode),
  handleChown: (handle, uid, gid) => handle.chown(uid, gid),
  handleSync: (handle) => handle.sync(),
  handleWriteFile: (handle, content) => handle.writeFile(content, "utf8"),
  mkdir,
  open,
  randomBytes: cryptoRandomBytes,
  rename,
  rm,
};

export async function projectHermesHome(
  spec: AgentLaunchSpec,
  options: HermesProjectionOptions = {},
): Promise<HermesProjectionResult> {
  try {
    return await projectHermesHomeUnchecked(spec, options);
  } catch (error) {
    if (
      spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION &&
      !(error instanceof HermesProjectionInvalidError)
    ) {
      throw new HermesProjectionInvalidError();
    }

    throw error;
  }
}

async function projectHermesHomeUnchecked(
  spec: AgentLaunchSpec,
  options: HermesProjectionOptions = {},
): Promise<HermesProjectionResult> {
  const state = await prepareHermesState(spec.agent.id, options);
  const { hermesHome } = state;

  const configPath = resolveManagedPath(hermesHome, "config.yaml");
  const envPath = resolveManagedPath(hermesHome, ".env");
  const soulPath = resolveManagedPath(hermesHome, "SOUL.md");
  const revisionPath = resolveManagedPath(hermesHome, "bruno-config-revision.json");

  await Promise.all(
    GUARDED_FILES.map((fileName) =>
      assertSafeExistingTarget(resolveManagedPath(hermesHome, fileName)),
    ),
  );

  const existingConfig = await readExistingRegularFile(configPath, MAX_CONFIG_YAML_BYTES);

  if (spec.version !== MANAGED_AGENT_LAUNCH_SPEC_VERSION && !existingConfig?.trim()) {
    throw new HermesSetupRequiredError();
  }

  const existingEnv = (await readExistingRegularFile(envPath, MAX_ENV_BYTES)) ?? "";
  const configContent =
    spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION
      ? renderManagedHermesConfig(existingConfig ?? "", spec)
      : (existingConfig ?? "");
  const envContent = mergeHermesEnv(existingEnv, spec);
  const soulContent = `${spec.prompt.soul.trim()}\n`;
  const fs = resolveProjectionFilesystem(options.fs);
  const revisionContent = `${JSON.stringify({
    version: spec.version,
    agentId: spec.agent.id,
    configRevision: spec.agent.configRevision,
    image: spec.image.ref,
  })}\n`;
  const staged: Array<{ path: string; tempPath: string }> = [];
  let revisionStage: { path: string; tempPath: string } | null = null;

  try {
    staged.push(
      await stageAtomicWrite(configPath, configContent, PUBLIC_FILE_MODE, options.ownership, fs),
    );
    staged.push(await stageAtomicWrite(envPath, envContent, ENV_MODE, options.ownership, fs));
    staged.push(
      await stageAtomicWrite(soulPath, soulContent, PUBLIC_FILE_MODE, options.ownership, fs),
    );
    revisionStage = await stageAtomicWrite(
      revisionPath,
      revisionContent,
      PUBLIC_FILE_MODE,
      options.ownership,
      fs,
    );

    for (const entry of staged) {
      await assertRealDirectory(hermesHome);
      await assertSafeExistingTarget(entry.path);
      await fs.rename(entry.tempPath, entry.path);
    }

    await assertRealDirectory(hermesHome);
    await assertSafeExistingTarget(revisionStage.path);
    await fs.rename(revisionStage.tempPath, revisionStage.path);
    await fsyncDirectory(hermesHome, fs);
    await pruneObsoleteManagedTemps(hermesHome, fs);
  } catch (error) {
    await Promise.all(
      [...staged, ...(revisionStage ? [revisionStage] : [])].map((entry) =>
        fs.rm(entry.tempPath, { force: true }).catch(() => undefined),
      ),
    );
    throw error;
  }

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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId)) {
    throw new Error("Hermes projection agent id must be a UUID.");
  }

  const configuredStateRoot = resolve(
    options.stateRoot ?? process.env.BRUNO_HERMES_STATE_ROOT ?? DEFAULT_HERMES_STATE_ROOT,
  );

  if (!configuredStateRoot.startsWith(sep)) {
    throw new Error("Hermes state root must be absolute.");
  }

  await assertDirectoryNoFinalSymlink(configuredStateRoot);
  const stateRoot = await realpath(configuredStateRoot);
  const agentRoot = resolveManagedPath(stateRoot, agentId);
  const hermesHome = resolveManagedPath(agentRoot, "hermes");
  const workspace = resolveManagedPath(agentRoot, "workspace");

  const fs = resolveProjectionFilesystem(options.fs);

  await ensureManagedDirectory(agentRoot, DIRECTORY_MODE, options.ownership, fs);
  await ensureManagedDirectory(hermesHome, DIRECTORY_MODE, options.ownership, fs);
  await ensureManagedDirectory(workspace, DIRECTORY_MODE, options.ownership, fs);

  return {
    agentRoot,
    hermesHome,
    workspace,
  };
}

function renderManagedHermesConfig(existing: string, spec: ManagedAgentLaunchSpec): string {
  const config = parseHermesYaml(existing);

  removeManagedLegacySecretPaths(config);
  rejectSecretBearingYaml(config);
  setPath(config, ["model", "provider"], spec.model.provider);
  setPath(config, ["model", "default"], spec.model.model);
  deletePath(config, ["model", "api_key"]);
  setPath(config, ["terminal", "backend"], "local");
  setPath(config, ["terminal", "cwd"], "/workspace");
  setPath(config, ["browser", "enabled"], false);
  setPath(config, ["tool_loop_guardrails", "hard_stop_enabled"], true);
  setPath(config, ["tool_loop_guardrails", "hard_stop_after", "exact_failure"], 5);
  setPath(config, ["tool_loop_guardrails", "hard_stop_after", "idempotent_no_progress"], 5);
  deletePath(config, ["api_server", "enabled"]);
  deletePath(config, ["telegram", "enabled"]);
  deletePath(config, ["gateway", "platforms", "api_server", "enabled"]);
  deletePath(config, ["gateway", "platforms", "telegram", "enabled"]);
  setPath(config, ["platforms", "api_server", "enabled"], true);
  setPath(config, ["platforms", "telegram", "enabled"], true);
  setPath(config, ["platforms", "telegram", "allow_all_users"], false);
  setPath(config, ["platforms", "telegram", "unauthorized_dm_behavior"], "ignore");

  const rendered = stringify(config, {
    collectionStyle: "block",
    indent: 2,
    lineWidth: 0,
    sortMapEntries: true,
  }).replace(/\r\n/g, "\n");

  parseHermesYaml(rendered);

  return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
}

function renderHermesEnv(spec: AgentLaunchSpec): string {
  if (spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION) {
    const modelCredential =
      "openrouterApiKey" in spec.secrets
        ? `OPENROUTER_API_KEY=${envValue(spec.secrets.openrouterApiKey)}`
        : spec.model.provider === "anthropic"
          ? `ANTHROPIC_API_KEY=${envValue(spec.secrets.modelApiKey)}`
          : `OPENAI_API_KEY=${envValue(spec.secrets.modelApiKey)}`;

    return [
      modelCredential,
      `TELEGRAM_BOT_TOKEN=${envValue(spec.secrets.telegramBotToken)}`,
      `TELEGRAM_ALLOWED_USERS=${envValue(spec.secrets.telegramAllowedUsers.join(","))}`,
      `API_SERVER_KEY=${envValue(spec.secrets.apiServerKey)}`,
      "API_SERVER_ENABLED=true",
      "API_SERVER_HOST=0.0.0.0",
      "API_SERVER_PORT=8642",
      "GATEWAY_ALLOW_ALL_USERS=false",
      "TELEGRAM_ALLOW_ALL_USERS=false",
      "",
    ].join("\n");
  }

  return [
    "API_SERVER_ENABLED=true",
    "API_SERVER_HOST=0.0.0.0",
    `API_SERVER_KEY=${envValue(spec.secrets.apiServerKey)}`,
    "",
  ].join("\n");
}

export function mergeHermesEnv(existing: string, spec: AgentLaunchSpec): string {
  if (existing.includes("\0") || Buffer.byteLength(existing, "utf8") > MAX_ENV_BYTES) {
    throw new Error("Hermes env file is invalid.");
  }

  const ownedKeys =
    spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION ? MANAGED_ENV_KEY_SET : NATIVE_ENV_KEY_SET;
  const preserved = existing
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => {
      rejectUnsupportedEnvLine(line);
      const parsed = parseEnvAssignment(line);

      if (!parsed) {
        rejectMalformedManagedEnvLine(line);
        return true;
      }

      return !ownedKeys.has(parsed.key);
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

export class HermesProjectionInvalidError extends Error {
  constructor() {
    super("Hermes projection is invalid.");
    this.name = "HermesProjectionInvalidError";
  }
}

function parseHermesYaml(input: string): PlainYamlRecord {
  if (!input.trim()) {
    return Object.create(null) as PlainYamlRecord;
  }

  if (Buffer.byteLength(input, "utf8") > MAX_CONFIG_YAML_BYTES) {
    throw new Error("Hermes config is too large.");
  }

  if (
    /(^|\n)\s*%/.test(input) ||
    /(^|\n)\s*(?:---|\.\.\.)\s*(?:\n|$)/.test(input) ||
    /(^|\n)\s*<<\s*:/.test(input)
  ) {
    throw new Error("Hermes config uses unsafe YAML syntax.");
  }

  const documents = parseAllDocuments(input, {
    keepSourceTokens: false,
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });

  if (documents.length !== 1) {
    throw new Error("Hermes config must contain one YAML document.");
  }

  const [document] = documents;

  if (!document || document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("Hermes config is invalid.");
  }

  assertYamlAstSafe(document);
  const jsValue = document.toJS({ mapAsMap: true, maxAliasCount: 0 });

  if (!(jsValue instanceof Map)) {
    throw new Error("Hermes config root must be a mapping.");
  }

  return copyYamlMap(jsValue, 0, { entries: 0 });
}

function copyYamlValue(
  value: unknown,
  depth: number,
  counter: { entries: number },
): PlainYamlValue {
  if (depth > MAX_NESTING_DEPTH) {
    throw new Error("Hermes config nesting is too deep.");
  }

  if (value instanceof Map) {
    return copyYamlMap(value, depth, counter);
  }

  if (Array.isArray(value)) {
    counter.entries += value.length;
    rejectTooManyYamlEntries(counter);
    return value.map((entry) => copyYamlValue(entry, depth + 1, counter));
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value;
  }

  throw new Error("Hermes config contains an unsupported value.");
}

function copyYamlMap(map: Map<unknown, unknown>, depth: number, counter: { entries: number }) {
  const record = Object.create(null) as PlainYamlRecord;
  counter.entries += map.size;
  rejectTooManyYamlEntries(counter);

  for (const [key, value] of map.entries()) {
    if (typeof key !== "string" || DANGEROUS_KEYS.has(key)) {
      throw new Error("Hermes config contains an unsafe key.");
    }

    record[key] = copyYamlValue(value, depth + 1, counter);
  }

  return record;
}

function rejectTooManyYamlEntries(counter: { entries: number }) {
  if (counter.entries > MAX_COLLECTION_ENTRIES) {
    throw new Error("Hermes config has too many entries.");
  }
}

function assertYamlAstSafe(document: Document<Node, true>): void {
  let unsafe = false;

  visit(document, {
    Alias() {
      unsafe = true;
      return visit.BREAK;
    },
    Node(_key, node) {
      if (isYamlNodeMetadataRecord(node)) {
        if (typeof node.tag === "string" && node.tag.length > 0) {
          unsafe = true;
          return visit.BREAK;
        }

        if (typeof node.anchor === "string" && node.anchor.length > 0) {
          unsafe = true;
          return visit.BREAK;
        }
      }

      return undefined;
    },
  });

  if (unsafe) {
    throw new Error("Hermes config uses unsafe YAML syntax.");
  }
}

function removeManagedLegacySecretPaths(config: PlainYamlRecord): void {
  for (const path of [
    ["model", "api_key"],
    ["platforms", "telegram", "token"],
    ["platforms", "telegram", "bot_token"],
    ["platforms", "telegram", "allowed_users"],
    ["platforms", "api_server", "key"],
    ["api_server", "key"],
    ["telegram", "token"],
    ["telegram", "bot_token"],
    ["telegram", "allowed_users"],
  ]) {
    deletePath(config, path);
  }
}

function rejectSecretBearingYaml(value: PlainYamlValue, keyPath: string[] = []): void {
  const lastKey = keyPath.at(-1) ?? "";

  if (SECRET_KEY_PATTERN.test(lastKey)) {
    if (typeof value !== "string" || !ENV_REFERENCE_PATTERN.test(value.trim())) {
      throw new Error("Hermes config contains unsafe secret configuration.");
    }

    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      rejectSecretBearingYaml(entry, keyPath);
    }
    return;
  }

  if (isPlainYamlRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      rejectSecretBearingYaml(child, [...keyPath, key]);
    }
    return;
  }

  if (typeof value === "string") {
    if (
      OPENROUTER_KEY_PATTERN.test(value.trim()) ||
      OPENAI_KEY_PATTERN.test(value.trim()) ||
      ANTHROPIC_KEY_PATTERN.test(value.trim()) ||
      TELEGRAM_BOT_TOKEN_PATTERN.test(value.trim()) ||
      API_SERVER_KEY_PATTERN.test(value.trim())
    ) {
      throw new Error("Hermes config contains secret material.");
    }
  }
}

function setPath(target: PlainYamlRecord, path: readonly string[], value: PlainYamlValue): void {
  let cursor = target;

  for (const part of path.slice(0, -1)) {
    const existing = cursor[part];

    if (!isPlainYamlRecord(existing)) {
      cursor[part] = Object.create(null) as PlainYamlRecord;
    }

    cursor = cursor[part] as PlainYamlRecord;
  }

  cursor[path[path.length - 1] ?? ""] = value;
}

function deletePath(target: PlainYamlRecord, path: readonly string[]): void {
  let cursor: PlainYamlRecord | null = target;

  for (const part of path.slice(0, -1)) {
    const next: PlainYamlValue | undefined = cursor[part];

    if (!isPlainYamlRecord(next)) {
      return;
    }

    cursor = next;
  }

  delete cursor[path[path.length - 1] ?? ""];
}

function isPlainYamlRecord(value: unknown): value is PlainYamlRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === null || prototype === Object.prototype;
}

function envValue(value: string): string {
  if (hasControlCharacter(value)) {
    throw new Error("Hermes env value contains control characters.");
  }

  return JSON.stringify(value);
}

function parseEnvAssignment(line: string): { key: string } | null {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);

  return match?.[1] ? { key: match[1] } : null;
}

function rejectUnsupportedEnvLine(line: string): void {
  if (/\\\s*$/.test(line)) {
    throw new Error("Hermes env contains unsupported multiline syntax.");
  }
}

function rejectMalformedManagedEnvLine(line: string): void {
  for (const key of MANAGED_ENV_KEYS) {
    if (new RegExp(`^\\s*(?:export\\s+)?${key}\\b`).test(line)) {
      throw new Error("Hermes env contains malformed managed assignment.");
    }
  }
}

async function ensureManagedDirectory(
  path: string,
  mode: number,
  ownership: HermesProjectionOptions["ownership"],
  fs: HermesProjectionFilesystem,
): Promise<void> {
  await rejectSymlinkIfExists(path);
  await fs.mkdir(path, { recursive: true, mode });
  await assertRealDirectory(path);
  await fs.chmod(path, mode);

  if (ownership) {
    await fs.chown(path, ownership.uid, ownership.gid);
  }
}

async function stageAtomicWrite(
  path: string,
  content: string,
  mode: number,
  ownership: HermesProjectionOptions["ownership"],
  fs: HermesProjectionFilesystem = NODE_FS,
): Promise<{ path: string; tempPath: string }> {
  const parent = dirname(path);
  await assertRealDirectory(parent);
  assertChildPath(parent, path);
  const tempPath = resolveManagedPath(
    parent,
    `.${path.split(sep).at(-1)}.tmp-${fs.randomBytes(12).toString("hex")}`,
  );
  const handle = await fs.open(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0),
    mode,
  );
  let closed = false;

  try {
    await fs.handleWriteFile(handle, content);
    await fs.handleChmod(handle, mode);

    if (ownership) {
      await fs.handleChown(handle, ownership.uid, ownership.gid);
    }

    await fs.handleSync(handle);
    await handle.close();
    closed = true;
    await assertRegularOwnedFile(tempPath);

    return { path, tempPath };
  } catch (error) {
    if (!closed) {
      await handle.close().catch(() => undefined);
    }
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readExistingRegularFile(path: string, maxBytes: number): Promise<string | null> {
  try {
    await assertSafeExistingTarget(path, maxBytes);
    const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));

    try {
      const stats = await handle.stat();

      if (!stats.isFile() || stats.nlink > 1 || stats.size > maxBytes) {
        throw new Error("Hermes projection file is invalid.");
      }

      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }

    throw error;
  }
}

async function assertRegularOwnedFile(path: string): Promise<void> {
  const stats = await lstat(path);

  if (!stats.isFile() || stats.nlink > 1) {
    throw new Error("Hermes projection path must be a regular file.");
  }
}

async function assertSafeExistingTarget(path: string, maxBytes?: number): Promise<void> {
  try {
    const stats = await lstat(path);

    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.nlink > 1 ||
      (maxBytes !== undefined && stats.size > maxBytes)
    ) {
      throw new Error("Hermes projection path must be a safe regular file.");
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return;
    }

    throw error;
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  await assertDirectoryNoFinalSymlink(path);
  const resolved = await realpath(path);

  if (resolved !== resolve(path)) {
    throw new Error("Hermes projection path must not escape through a link.");
  }
}

async function assertDirectoryNoFinalSymlink(path: string): Promise<void> {
  const stats = await lstat(path);

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Hermes projection path must be a real directory.");
  }
}

async function fsyncDirectory(path: string, fs: HermesProjectionFilesystem): Promise<void> {
  const handle = await fs.open(path, fsConstants.O_RDONLY);

  try {
    await fs.handleSync(handle);
  } finally {
    await handle.close();
  }
}

function resolveProjectionFilesystem(
  overrides: HermesProjectionOptions["fs"],
): HermesProjectionFilesystem {
  return { ...NODE_FS, ...(overrides ?? {}) };
}

async function pruneObsoleteManagedTemps(
  hermesHome: string,
  fs: HermesProjectionFilesystem,
): Promise<void> {
  await Promise.all(
    GUARDED_FILES.map((fileName) =>
      fs
        .rm(resolveManagedPath(hermesHome, `${fileName}.tmp`), { force: true })
        .catch(() => undefined),
    ),
  );
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

function resolveManagedPath(parent: string, child: string): string {
  const resolved = resolve(parent, child);
  assertChildPath(parent, resolved);

  return resolved;
}

function assertChildPath(parent: string, child: string): void {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  const childRelative = relative(normalizedParent, normalizedChild);

  if (
    childRelative === "" ||
    childRelative === ".." ||
    childRelative.startsWith(`..${sep}`) ||
    childRelative.includes(`..${sep}`)
  ) {
    throw new Error("Hermes projection path escaped the managed root.");
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 32 || code === 127) {
      return true;
    }
  }

  return false;
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isYamlNodeMetadataRecord(value: unknown): value is {
  anchor?: unknown;
  tag?: unknown;
} {
  return typeof value === "object" && value !== null;
}
