export const AGENT_LAUNCH_SPEC_VERSION = "agentbay.hermes.launch.v1";
export const AGENT_LAUNCH_SPEC_MAX_BYTES = 64 * 1024;

export type AgentLaunchSpec = {
  version: typeof AGENT_LAUNCH_SPEC_VERSION;
  requestId: string;
  agent: {
    id: string;
    name: string;
    templateKey: string;
    templateVersion: string;
    configRevision: string;
  };
  image: {
    ref: string;
  };
  model: {
    provider: "openrouter";
    model: string;
  };
  schedule: {
    mode: "manual" | "cron";
    cron: string | null;
    timezone: string;
  };
  prompt: {
    soul: string;
  };
  runtime: {
    dataDir: "/opt/data";
    workspaceDir: "/workspace";
    terminalCwd: "/workspace";
    browserEnabled: false;
    unattendedLoopLimit: number;
  };
  tools: {
    enabled: readonly ["file_operations", "terminal"];
    disabled: readonly ["browser", "mcp", "delegation", "voice", "code_execution"];
  };
  secrets: {
    kind: "inline";
    openrouterApiKey: string;
    telegramBotToken: string;
    telegramAllowedUsers: string;
    apiServerKey: string;
  };
};

export type AgentLaunchSpecParseResult =
  | { ok: true; spec: AgentLaunchSpec }
  | { ok: false; issues: Array<{ path: string; message: string }> };

const ROOT_KEYS = [
  "version",
  "requestId",
  "agent",
  "image",
  "model",
  "schedule",
  "prompt",
  "runtime",
  "tools",
  "secrets",
] as const;
const AGENT_KEYS = ["id", "name", "templateKey", "templateVersion", "configRevision"] as const;
const IMAGE_KEYS = ["ref"] as const;
const MODEL_KEYS = ["provider", "model"] as const;
const SCHEDULE_KEYS = ["mode", "cron", "timezone"] as const;
const PROMPT_KEYS = ["soul"] as const;
const RUNTIME_KEYS = [
  "dataDir",
  "workspaceDir",
  "terminalCwd",
  "browserEnabled",
  "unattendedLoopLimit",
] as const;
const TOOLS_KEYS = ["enabled", "disabled"] as const;
const SECRETS_KEYS = [
  "kind",
  "openrouterApiKey",
  "telegramBotToken",
  "telegramAllowedUsers",
  "apiServerKey",
] as const;
const SECRET_REPLACEMENT = "[secret]";

export function parseAgentLaunchSpec(value: unknown): AgentLaunchSpecParseResult {
  const issues: Array<{ path: string; message: string }> = [];

  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "Launch spec must be an object." }],
    };
  }

  assertExactKeys("$", value, ROOT_KEYS, issues);
  const agent = readRecord(value, "agent", issues);
  const image = readRecord(value, "image", issues);
  const model = readRecord(value, "model", issues);
  const schedule = readRecord(value, "schedule", issues);
  const prompt = readRecord(value, "prompt", issues);
  const runtime = readRecord(value, "runtime", issues);
  const tools = readRecord(value, "tools", issues);
  const secrets = readRecord(value, "secrets", issues);

  if (agent) {
    assertExactKeys("$.agent", agent, AGENT_KEYS, issues);
  }
  if (image) {
    assertExactKeys("$.image", image, IMAGE_KEYS, issues);
  }
  if (model) {
    assertExactKeys("$.model", model, MODEL_KEYS, issues);
  }
  if (schedule) {
    assertExactKeys("$.schedule", schedule, SCHEDULE_KEYS, issues);
  }
  if (prompt) {
    assertExactKeys("$.prompt", prompt, PROMPT_KEYS, issues);
  }
  if (runtime) {
    assertExactKeys("$.runtime", runtime, RUNTIME_KEYS, issues);
  }
  if (tools) {
    assertExactKeys("$.tools", tools, TOOLS_KEYS, issues);
  }
  if (secrets) {
    assertExactKeys("$.secrets", secrets, SECRETS_KEYS, issues);
  }

  const spec = {
    version: readLiteral(value, "version", AGENT_LAUNCH_SPEC_VERSION, issues),
    requestId: readBoundedString(value, "requestId", issues, { min: 8, max: 80 }),
    agent: {
      id: agent ? readUuid(agent, "id", issues, "$.agent") : "",
      name: agent ? readBoundedString(agent, "name", issues, { min: 1, max: 120 }, "$.agent") : "",
      templateKey: agent ? readSafeToken(agent, "templateKey", issues, "$.agent", 80) : "",
      templateVersion: agent
        ? readBoundedString(agent, "templateVersion", issues, { min: 1, max: 40 }, "$.agent")
        : "",
      configRevision: agent ? readSafeToken(agent, "configRevision", issues, "$.agent", 80) : "",
    },
    image: {
      ref: image ? readBoundedString(image, "ref", issues, { min: 1, max: 512 }, "$.image") : "",
    },
    model: {
      provider: model
        ? readLiteral(model, "provider", "openrouter", issues, "$.model")
        : "openrouter",
      model: model ? readModelName(model, "model", issues, "$.model") : "",
    },
    schedule: {
      mode: schedule ? readScheduleMode(schedule, "mode", issues, "$.schedule") : "manual",
      cron: schedule ? readNullableString(schedule, "cron", issues, "$.schedule", 120) : null,
      timezone: schedule
        ? readBoundedString(schedule, "timezone", issues, { min: 1, max: 80 }, "$.schedule")
        : "",
    },
    prompt: {
      soul: prompt
        ? readBoundedString(prompt, "soul", issues, { min: 1, max: 20_000 }, "$.prompt")
        : "",
    },
    runtime: {
      dataDir: runtime
        ? readLiteral(runtime, "dataDir", "/opt/data", issues, "$.runtime")
        : "/opt/data",
      workspaceDir: runtime
        ? readLiteral(runtime, "workspaceDir", "/workspace", issues, "$.runtime")
        : "/workspace",
      terminalCwd: runtime
        ? readLiteral(runtime, "terminalCwd", "/workspace", issues, "$.runtime")
        : "/workspace",
      browserEnabled: runtime
        ? readLiteral(runtime, "browserEnabled", false, issues, "$.runtime")
        : false,
      unattendedLoopLimit: runtime
        ? readPositiveInteger(runtime, "unattendedLoopLimit", issues, "$.runtime", 1, 100)
        : 25,
    },
    tools: {
      enabled: tools
        ? readStringTuple(
            tools,
            "enabled",
            ["file_operations", "terminal"] as const,
            issues,
            "$.tools",
          )
        : (["file_operations", "terminal"] as const),
      disabled: tools
        ? readStringTuple(
            tools,
            "disabled",
            ["browser", "mcp", "delegation", "voice", "code_execution"] as const,
            issues,
            "$.tools",
          )
        : (["browser", "mcp", "delegation", "voice", "code_execution"] as const),
    },
    secrets: {
      kind: secrets ? readLiteral(secrets, "kind", "inline", issues, "$.secrets") : "inline",
      openrouterApiKey: secrets
        ? readOpenRouterApiKey(secrets, "openrouterApiKey", issues, "$.secrets")
        : "",
      telegramBotToken: secrets
        ? readTelegramBotToken(secrets, "telegramBotToken", issues, "$.secrets")
        : "",
      telegramAllowedUsers: secrets
        ? readTelegramAllowedUsers(secrets, "telegramAllowedUsers", issues, "$.secrets")
        : "",
      apiServerKey: secrets ? readApiServerKey(secrets, "apiServerKey", issues, "$.secrets") : "",
    },
  } satisfies AgentLaunchSpec;

  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec };
}

export function parseAgentLaunchSpecJson(input: string): AgentLaunchSpecParseResult {
  if (Buffer.byteLength(input, "utf8") > AGENT_LAUNCH_SPEC_MAX_BYTES) {
    return {
      ok: false,
      issues: [{ path: "$", message: "Launch spec body is too large." }],
    };
  }

  try {
    return parseAgentLaunchSpec(JSON.parse(input));
  } catch {
    return {
      ok: false,
      issues: [{ path: "$", message: "Launch spec body must be valid JSON." }],
    };
  }
}

export function redactAgentLaunchSpec(spec: AgentLaunchSpec): AgentLaunchSpec {
  return {
    ...spec,
    secrets: {
      kind: "inline",
      openrouterApiKey: SECRET_REPLACEMENT,
      telegramBotToken: SECRET_REPLACEMENT,
      telegramAllowedUsers: SECRET_REPLACEMENT,
      apiServerKey: SECRET_REPLACEMENT,
    },
  };
}

function assertExactKeys(
  path: string,
  value: Record<string, unknown>,
  keys: readonly string[],
  issues: Array<{ path: string; message: string }>,
) {
  const allowed = new Set(keys);

  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "Unknown launch spec field." });
    }
  }

  for (const key of keys) {
    if (!(key in value)) {
      issues.push({ path: `${path}.${key}`, message: "Launch spec field is required." });
    }
  }
}

function readRecord(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): Record<string, unknown> | null {
  const nested = value[key];

  if (!isRecord(nested)) {
    issues.push({ path: `$.${key}`, message: "Launch spec field must be an object." });
    return null;
  }

  return nested;
}

function readLiteral<T extends string | boolean>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
  issues: Array<{ path: string; message: string }>,
  basePath = "$",
): T {
  if (value[key] !== expected) {
    issues.push({
      path: `${basePath}.${key}`,
      message: `Launch spec field must be ${String(expected)}.`,
    });
  }

  return expected;
}

function readBoundedString(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  bounds: { min: number; max: number },
  basePath = "$",
): string {
  const raw = value[key];

  if (typeof raw !== "string") {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec field must be a string." });
    return "";
  }

  const normalized = raw.trim();

  if (
    normalized.length < bounds.min ||
    normalized.length > bounds.max ||
    hasControlCharacter(normalized)
  ) {
    issues.push({
      path: `${basePath}.${key}`,
      message: "Launch spec field length or characters are invalid.",
    });
  }

  return normalized;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
  max: number,
): string | null {
  const raw = value[key];

  if (raw === null) {
    return null;
  }

  if (typeof raw !== "string") {
    issues.push({
      path: `${basePath}.${key}`,
      message: "Launch spec field must be a string or null.",
    });
    return null;
  }

  const normalized = raw.trim();

  if (normalized.length === 0 || normalized.length > max || hasControlCharacter(normalized)) {
    issues.push({
      path: `${basePath}.${key}`,
      message: "Launch spec field length or characters are invalid.",
    });
  }

  return normalized;
}

function readSafeToken(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
  max: number,
): string {
  const token = readBoundedString(value, key, issues, { min: 1, max }, basePath);

  if (!/^[A-Za-z0-9_.:-]+$/.test(token)) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec token is invalid." });
  }

  return token;
}

function readUuid(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const uuid = readBoundedString(value, key, issues, { min: 36, max: 36 }, basePath);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec UUID is invalid." });
  }

  return uuid;
}

function readModelName(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const model = readBoundedString(value, key, issues, { min: 3, max: 160 }, basePath);

  if (!/^[A-Za-z0-9._/-]+$/.test(model) || model === "not_configured") {
    issues.push({ path: `${basePath}.${key}`, message: "OpenRouter model is invalid." });
  }

  return model;
}

function readScheduleMode(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): "manual" | "cron" {
  const raw = value[key];

  if (raw !== "manual" && raw !== "cron") {
    issues.push({ path: `${basePath}.${key}`, message: "Schedule mode is invalid." });
    return "manual";
  }

  return raw;
}

function readPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
  min: number,
  max: number,
): number {
  const raw = value[key];

  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec integer is invalid." });
    return min;
  }

  return raw;
}

function readStringTuple<T extends readonly string[]>(
  value: Record<string, unknown>,
  key: string,
  expected: T,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): T {
  const raw = value[key];

  if (
    !Array.isArray(raw) ||
    raw.length !== expected.length ||
    raw.some((item, index) => item !== expected[index])
  ) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec tool list is invalid." });
  }

  return expected;
}

function readOpenRouterApiKey(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const secret = readBoundedString(value, key, issues, { min: 20, max: 400 }, basePath);

  if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(secret)) {
    issues.push({ path: `${basePath}.${key}`, message: "OpenRouter API key is invalid." });
  }

  return secret;
}

function readTelegramBotToken(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const secret = readBoundedString(value, key, issues, { min: 20, max: 300 }, basePath);

  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(secret)) {
    issues.push({ path: `${basePath}.${key}`, message: "Telegram bot token is invalid." });
  }

  return secret;
}

function readTelegramAllowedUsers(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const users = readBoundedString(value, key, issues, { min: 1, max: 512 }, basePath);

  if (!/^\d{1,20}(,\d{1,20})*$/.test(users)) {
    issues.push({ path: `${basePath}.${key}`, message: "Telegram allowed users are invalid." });
  }

  return users;
}

function readApiServerKey(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const secret = readBoundedString(value, key, issues, { min: 40, max: 300 }, basePath);

  if (!/^agb_agent_[A-Za-z0-9_-]{32,}$/.test(secret)) {
    issues.push({ path: `${basePath}.${key}`, message: "Agent API server key is invalid." });
  }

  return secret;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
