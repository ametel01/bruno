export const NATIVE_AGENT_LAUNCH_SPEC_VERSION = "agentbay.hermes.launch.v2";
export const MANAGED_AGENT_LAUNCH_SPEC_VERSION = "agentbay.hermes.launch.v3";
export const AGENT_LAUNCH_SPEC_VERSION = NATIVE_AGENT_LAUNCH_SPEC_VERSION;
export const AGENT_LAUNCH_SPEC_MAX_BYTES = 64 * 1024;

export type NativeAgentLaunchSpec = {
  version: typeof NATIVE_AGENT_LAUNCH_SPEC_VERSION;
  requestId: string;
  agent: AgentLaunchSpecAgent;
  image: AgentLaunchSpecImage;
  model: {
    provider: "hermes";
    model: "configured-by-hermes";
  };
  schedule: AgentLaunchSpecSchedule;
  prompt: AgentLaunchSpecPrompt;
  runtime: NativeAgentLaunchSpecRuntime;
  tools: AgentLaunchSpecTools;
  secrets: {
    kind: "inline";
    apiServerKey: string;
  };
};

type ManagedAgentLaunchSpecCommon = {
  version: typeof MANAGED_AGENT_LAUNCH_SPEC_VERSION;
  requestId: string;
  agent: AgentLaunchSpecAgent;
  image: AgentLaunchSpecImage;
  platforms: {
    required: readonly ["api_server", "telegram"];
    apiServer: {
      enabled: true;
      host: "0.0.0.0";
      port: 8642;
    };
    telegram: {
      enabled: true;
      allowAllUsers: false;
      unauthorizedDmBehavior: "ignore";
    };
  };
  schedule: AgentLaunchSpecSchedule;
  prompt: AgentLaunchSpecPrompt;
  runtime: ManagedAgentLaunchSpecRuntime;
  tools: AgentLaunchSpecTools;
};

export type LegacyManagedAgentLaunchSpec = ManagedAgentLaunchSpecCommon & {
  model: {
    provider: "openrouter";
    model: string;
  };
  secrets: {
    kind: "inline";
    openrouterApiKey: string;
    telegramBotToken: string;
    telegramAllowedUsers: readonly string[];
    apiServerKey: string;
  };
};

export type DirectManagedAgentLaunchSpec = ManagedAgentLaunchSpecCommon & {
  model: {
    provider: "openai-api" | "anthropic";
    model: string;
  };
  secrets: {
    kind: "inline";
    modelApiKey: string;
    telegramBotToken: string;
    telegramAllowedUsers: readonly string[];
    apiServerKey: string;
  };
};

export type ManagedAgentLaunchSpec = LegacyManagedAgentLaunchSpec | DirectManagedAgentLaunchSpec;

export type AgentLaunchSpec = NativeAgentLaunchSpec | ManagedAgentLaunchSpec;

export type AgentLaunchSpecParseResult =
  | { ok: true; spec: AgentLaunchSpec }
  | { ok: false; issues: Array<{ path: string; message: string }> };

type AgentLaunchSpecAgent = {
  id: string;
  name: string;
  templateKey: string;
  templateVersion: string;
  configRevision: string;
};

type AgentLaunchSpecImage = {
  ref: string;
};

type AgentLaunchSpecSchedule = {
  mode: "manual" | "cron";
  cron: string | null;
  timezone: string;
};

type AgentLaunchSpecPrompt = {
  soul: string;
};

type NativeAgentLaunchSpecRuntime = {
  dataDir: "/opt/data";
  workspaceDir: "/workspace";
  terminalCwd: "/workspace";
  browserEnabled: false;
  unattendedLoopLimit: number;
};

type ManagedAgentLaunchSpecRuntime = NativeAgentLaunchSpecRuntime & {
  toolLoopGuardrails: {
    hardStopEnabled: true;
    hardStopAfter: {
      exactFailure: 5;
      idempotentNoProgress: 5;
    };
  };
};

type AgentLaunchSpecTools = {
  enabled: readonly ["file_operations", "terminal"];
  disabled: readonly ["browser", "mcp", "delegation", "voice", "code_execution"];
};

const ROOT_KEYS_V2 = [
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
const ROOT_KEYS_V3 = [
  "version",
  "requestId",
  "agent",
  "image",
  "model",
  "platforms",
  "schedule",
  "prompt",
  "runtime",
  "tools",
  "secrets",
] as const;
const AGENT_KEYS = ["id", "name", "templateKey", "templateVersion", "configRevision"] as const;
const IMAGE_KEYS = ["ref"] as const;
const MODEL_KEYS = ["provider", "model"] as const;
const PLATFORMS_KEYS = ["required", "apiServer", "telegram"] as const;
const API_SERVER_PLATFORM_KEYS = ["enabled", "host", "port"] as const;
const TELEGRAM_PLATFORM_KEYS = ["enabled", "allowAllUsers", "unauthorizedDmBehavior"] as const;
const SCHEDULE_KEYS = ["mode", "cron", "timezone"] as const;
const PROMPT_KEYS = ["soul"] as const;
const RUNTIME_KEYS_V2 = [
  "dataDir",
  "workspaceDir",
  "terminalCwd",
  "browserEnabled",
  "unattendedLoopLimit",
] as const;
const RUNTIME_KEYS_V3 = [...RUNTIME_KEYS_V2, "toolLoopGuardrails"] as const;
const TOOL_LOOP_GUARDRAILS_KEYS = ["hardStopEnabled", "hardStopAfter"] as const;
const HARD_STOP_AFTER_KEYS = ["exactFailure", "idempotentNoProgress"] as const;
const TOOLS_KEYS = ["enabled", "disabled"] as const;
const SECRETS_KEYS_V2 = ["kind", "apiServerKey"] as const;
const SECRETS_KEYS_V3 = [
  "kind",
  "openrouterApiKey",
  "telegramBotToken",
  "telegramAllowedUsers",
  "apiServerKey",
] as const;
const DIRECT_SECRETS_KEYS_V3 = [
  "kind",
  "modelApiKey",
  "telegramBotToken",
  "telegramAllowedUsers",
  "apiServerKey",
] as const;
const SECRET_REPLACEMENT = "[secret]";
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$/;
const IMAGE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+%-]{0,511}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OPENROUTER_KEY_PATTERN = /^sk-or-v1-[A-Za-z0-9_-]{20,}$/;
const OPENAI_KEY_PATTERN = /^sk-(?!ant-|or-v1-)[A-Za-z0-9_-]{20,}$/;
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_BOT_TOKEN_PATTERN = /^[1-9][0-9]{5,19}:[A-Za-z0-9_-]{20,}$/;
const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/;

export function parseAgentLaunchSpec(value: unknown): AgentLaunchSpecParseResult {
  const issues: Array<{ path: string; message: string }> = [];

  if (!isPlainLaunchRecord(value)) {
    return {
      ok: false,
      issues: [{ path: "$", message: "Launch spec must be a plain object." }],
    };
  }

  const version = value.version;

  if (version === MANAGED_AGENT_LAUNCH_SPEC_VERSION) {
    return parseManagedAgentLaunchSpec(value, issues);
  }

  return parseNativeAgentLaunchSpec(value, issues);
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

export function redactAgentLaunchSpec<T extends AgentLaunchSpec>(spec: T): T {
  if (spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION) {
    const modelCredential =
      "openrouterApiKey" in spec.secrets
        ? { openrouterApiKey: SECRET_REPLACEMENT }
        : { modelApiKey: SECRET_REPLACEMENT };

    return {
      ...spec,
      secrets: {
        kind: "inline",
        ...modelCredential,
        telegramBotToken: SECRET_REPLACEMENT,
        telegramAllowedUsers: [SECRET_REPLACEMENT],
        apiServerKey: SECRET_REPLACEMENT,
      },
    } as T;
  }

  return {
    ...spec,
    secrets: {
      kind: "inline",
      apiServerKey: SECRET_REPLACEMENT,
    },
  } as T;
}

export function serializeAgentLaunchSpec(spec: AgentLaunchSpec): string {
  return JSON.stringify(toCanonicalAgentLaunchSpec(spec));
}

export function serializeRedactedAgentLaunchSpec(spec: AgentLaunchSpec): string {
  return JSON.stringify(toCanonicalAgentLaunchSpec(redactAgentLaunchSpec(spec)));
}

function parseNativeAgentLaunchSpec(
  value: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): AgentLaunchSpecParseResult {
  assertExactKeys("$", value, ROOT_KEYS_V2, issues);
  const common = parseCommonLaunchFields(value, issues, NATIVE_AGENT_LAUNCH_SPEC_VERSION);
  const model = readRecord(value, "model", issues);
  const runtime = readRecord(value, "runtime", issues);
  const secrets = readRecord(value, "secrets", issues);

  if (model) {
    assertExactKeys("$.model", model, MODEL_KEYS, issues);
  }
  if (runtime) {
    assertExactKeys("$.runtime", runtime, RUNTIME_KEYS_V2, issues);
  }
  if (secrets) {
    assertExactKeys("$.secrets", secrets, SECRETS_KEYS_V2, issues);
  }

  const spec = {
    ...common,
    version: readLiteral(value, "version", NATIVE_AGENT_LAUNCH_SPEC_VERSION, issues),
    model: {
      provider: model ? readLiteral(model, "provider", "hermes", issues, "$.model") : "hermes",
      model: model
        ? readLiteral(model, "model", "configured-by-hermes", issues, "$.model")
        : "configured-by-hermes",
    },
    runtime: parseNativeRuntime(runtime, issues),
    secrets: {
      kind: secrets ? readLiteral(secrets, "kind", "inline", issues, "$.secrets") : "inline",
      apiServerKey: secrets ? readApiServerKey(secrets, "apiServerKey", issues) : "",
    },
  } satisfies NativeAgentLaunchSpec;

  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec };
}

function parseManagedAgentLaunchSpec(
  value: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): AgentLaunchSpecParseResult {
  assertExactKeys("$", value, ROOT_KEYS_V3, issues);
  const common = parseCommonLaunchFields(value, issues, MANAGED_AGENT_LAUNCH_SPEC_VERSION);
  const model = readRecord(value, "model", issues);
  const platforms = readRecord(value, "platforms", issues);
  const apiServer = platforms ? readRecord(platforms, "apiServer", issues, "$.platforms") : null;
  const telegram = platforms ? readRecord(platforms, "telegram", issues, "$.platforms") : null;
  const runtime = readRecord(value, "runtime", issues);
  const guardrails = runtime
    ? readRecord(runtime, "toolLoopGuardrails", issues, "$.runtime")
    : null;
  const hardStopAfter = guardrails
    ? readRecord(guardrails, "hardStopAfter", issues, "$.runtime.toolLoopGuardrails")
    : null;
  const secrets = readRecord(value, "secrets", issues);
  const provider = model ? readManagedProvider(model, issues) : "openrouter";

  if (model) {
    assertExactKeys("$.model", model, MODEL_KEYS, issues);
  }
  if (platforms) {
    assertExactKeys("$.platforms", platforms, PLATFORMS_KEYS, issues);
  }
  if (apiServer) {
    assertExactKeys("$.platforms.apiServer", apiServer, API_SERVER_PLATFORM_KEYS, issues);
  }
  if (telegram) {
    assertExactKeys("$.platforms.telegram", telegram, TELEGRAM_PLATFORM_KEYS, issues);
  }
  if (runtime) {
    assertExactKeys("$.runtime", runtime, RUNTIME_KEYS_V3, issues);
  }
  if (guardrails) {
    assertExactKeys("$.runtime.toolLoopGuardrails", guardrails, TOOL_LOOP_GUARDRAILS_KEYS, issues);
  }
  if (hardStopAfter) {
    assertExactKeys(
      "$.runtime.toolLoopGuardrails.hardStopAfter",
      hardStopAfter,
      HARD_STOP_AFTER_KEYS,
      issues,
    );
  }
  if (secrets) {
    assertExactKeys(
      "$.secrets",
      secrets,
      provider === "openrouter" ? SECRETS_KEYS_V3 : DIRECT_SECRETS_KEYS_V3,
      issues,
    );
  }

  const commonSpec = {
    ...common,
    version: readLiteral(value, "version", MANAGED_AGENT_LAUNCH_SPEC_VERSION, issues),
    platforms: {
      required: platforms
        ? readStringTuple(
            platforms,
            "required",
            ["api_server", "telegram"] as const,
            issues,
            "$.platforms",
          )
        : (["api_server", "telegram"] as const),
      apiServer: {
        enabled: apiServer
          ? readLiteral(apiServer, "enabled", true, issues, "$.platforms.apiServer")
          : true,
        host: apiServer
          ? readLiteral(apiServer, "host", "0.0.0.0", issues, "$.platforms.apiServer")
          : "0.0.0.0",
        port: apiServer
          ? readLiteral(apiServer, "port", 8642, issues, "$.platforms.apiServer")
          : 8642,
      },
      telegram: {
        enabled: telegram
          ? readLiteral(telegram, "enabled", true, issues, "$.platforms.telegram")
          : true,
        allowAllUsers: telegram
          ? readLiteral(telegram, "allowAllUsers", false, issues, "$.platforms.telegram")
          : false,
        unauthorizedDmBehavior: telegram
          ? readLiteral(
              telegram,
              "unauthorizedDmBehavior",
              "ignore",
              issues,
              "$.platforms.telegram",
            )
          : "ignore",
      },
    },
    runtime: parseManagedRuntime(runtime, guardrails, hardStopAfter, issues),
  } satisfies ManagedAgentLaunchSpecCommon;

  const sharedSecrets = {
    kind: secrets ? readLiteral(secrets, "kind", "inline", issues, "$.secrets") : "inline",
    telegramBotToken: secrets
      ? readPatternedSecret(secrets, "telegramBotToken", TELEGRAM_BOT_TOKEN_PATTERN, 256, issues)
      : "",
    telegramAllowedUsers: secrets
      ? readTelegramAllowedUsers(secrets, "telegramAllowedUsers", issues)
      : [],
    apiServerKey: secrets ? readApiServerKey(secrets, "apiServerKey", issues) : "",
  } as const;

  const spec: ManagedAgentLaunchSpec =
    provider === "openrouter"
      ? {
          ...commonSpec,
          model: {
            provider,
            model: model ? readOpenRouterModelId(model, "model", issues) : "",
          },
          secrets: {
            ...sharedSecrets,
            openrouterApiKey: secrets
              ? readPatternedSecret(
                  secrets,
                  "openrouterApiKey",
                  OPENROUTER_KEY_PATTERN,
                  512,
                  issues,
                )
              : "",
          },
        }
      : {
          ...commonSpec,
          model: {
            provider,
            model: model ? readDirectModelId(model, "model", issues) : "",
          },
          secrets: {
            ...sharedSecrets,
            modelApiKey: secrets
              ? readPatternedSecret(
                  secrets,
                  "modelApiKey",
                  provider === "anthropic" ? ANTHROPIC_KEY_PATTERN : OPENAI_KEY_PATTERN,
                  512,
                  issues,
                )
              : "",
          },
        };

  return issues.length > 0 ? { ok: false, issues } : { ok: true, spec };
}

function parseCommonLaunchFields(
  value: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
  version: typeof NATIVE_AGENT_LAUNCH_SPEC_VERSION | typeof MANAGED_AGENT_LAUNCH_SPEC_VERSION,
) {
  const agent = readRecord(value, "agent", issues);
  const image = readRecord(value, "image", issues);
  const schedule = readRecord(value, "schedule", issues);
  const prompt = readRecord(value, "prompt", issues);
  const tools = readRecord(value, "tools", issues);

  if (agent) {
    assertExactKeys("$.agent", agent, AGENT_KEYS, issues);
  }
  if (image) {
    assertExactKeys("$.image", image, IMAGE_KEYS, issues);
  }
  if (schedule) {
    assertExactKeys("$.schedule", schedule, SCHEDULE_KEYS, issues);
  }
  if (prompt) {
    assertExactKeys("$.prompt", prompt, PROMPT_KEYS, issues);
  }
  if (tools) {
    assertExactKeys("$.tools", tools, TOOLS_KEYS, issues);
  }

  return {
    version,
    requestId: readRequestId(value, "requestId", issues),
    agent: {
      id: agent ? readUuid(agent, "id", issues, "$.agent") : "",
      name: agent ? readAgentName(agent, "name", issues) : "",
      templateKey: agent ? readSafeToken(agent, "templateKey", issues, "$.agent", 80) : "",
      templateVersion: agent ? readTemplateVersion(agent, "templateVersion", issues) : "",
      configRevision: agent ? readConfigRevision(agent, "configRevision", issues) : "",
    },
    image: {
      ref: image ? readImageRef(image, "ref", issues) : "",
    },
    schedule: {
      mode: schedule ? readScheduleMode(schedule, "mode", issues, "$.schedule") : "manual",
      cron: schedule ? readNullableString(schedule, "cron", issues, "$.schedule", 120) : null,
      timezone: schedule
        ? readBoundedString(schedule, "timezone", issues, { min: 1, maxBytes: 80 }, "$.schedule")
        : "",
    },
    prompt: {
      soul: prompt ? readPromptSoul(prompt, "soul", issues) : "",
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
  };
}

function parseNativeRuntime(
  runtime: Record<string, unknown> | null,
  issues: Array<{ path: string; message: string }>,
): NativeAgentLaunchSpecRuntime {
  return {
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
  };
}

function parseManagedRuntime(
  runtime: Record<string, unknown> | null,
  guardrails: Record<string, unknown> | null,
  hardStopAfter: Record<string, unknown> | null,
  issues: Array<{ path: string; message: string }>,
): ManagedAgentLaunchSpecRuntime {
  return {
    ...parseNativeRuntime(runtime, issues),
    toolLoopGuardrails: {
      hardStopEnabled: guardrails
        ? readLiteral(guardrails, "hardStopEnabled", true, issues, "$.runtime.toolLoopGuardrails")
        : true,
      hardStopAfter: {
        exactFailure: hardStopAfter
          ? readLiteral(
              hardStopAfter,
              "exactFailure",
              5,
              issues,
              "$.runtime.toolLoopGuardrails.hardStopAfter",
            )
          : 5,
        idempotentNoProgress: hardStopAfter
          ? readLiteral(
              hardStopAfter,
              "idempotentNoProgress",
              5,
              issues,
              "$.runtime.toolLoopGuardrails.hardStopAfter",
            )
          : 5,
      },
    },
  };
}

function toCanonicalAgentLaunchSpec(spec: AgentLaunchSpec): AgentLaunchSpec {
  if (spec.version === MANAGED_AGENT_LAUNCH_SPEC_VERSION) {
    const common = {
      version: spec.version,
      requestId: spec.requestId,
      agent: { ...spec.agent },
      image: { ref: spec.image.ref },
      platforms: {
        required: ["api_server", "telegram"],
        apiServer: { enabled: true, host: "0.0.0.0", port: 8642 },
        telegram: { enabled: true, allowAllUsers: false, unauthorizedDmBehavior: "ignore" },
      },
      schedule: { ...spec.schedule },
      prompt: { soul: spec.prompt.soul },
      runtime: {
        dataDir: "/opt/data",
        workspaceDir: "/workspace",
        terminalCwd: "/workspace",
        browserEnabled: false,
        unattendedLoopLimit: spec.runtime.unattendedLoopLimit,
        toolLoopGuardrails: {
          hardStopEnabled: true,
          hardStopAfter: { exactFailure: 5, idempotentNoProgress: 5 },
        },
      },
      tools: {
        enabled: ["file_operations", "terminal"],
        disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
      },
    } satisfies ManagedAgentLaunchSpecCommon;

    if ("openrouterApiKey" in spec.secrets) {
      return {
        ...common,
        model: {
          provider: "openrouter",
          model: spec.model.model,
        },
        secrets: {
          kind: "inline",
          openrouterApiKey: spec.secrets.openrouterApiKey,
          telegramBotToken: spec.secrets.telegramBotToken,
          telegramAllowedUsers: [...spec.secrets.telegramAllowedUsers],
          apiServerKey: spec.secrets.apiServerKey,
        },
      };
    }

    return {
      ...common,
      model: {
        provider: spec.model.provider === "anthropic" ? "anthropic" : "openai-api",
        model: spec.model.model,
      },
      secrets: {
        kind: "inline",
        modelApiKey: spec.secrets.modelApiKey,
        telegramBotToken: spec.secrets.telegramBotToken,
        telegramAllowedUsers: [...spec.secrets.telegramAllowedUsers],
        apiServerKey: spec.secrets.apiServerKey,
      },
    };
  }

  return {
    version: spec.version,
    requestId: spec.requestId,
    agent: { ...spec.agent },
    image: { ref: spec.image.ref },
    model: { provider: "hermes", model: "configured-by-hermes" },
    schedule: { ...spec.schedule },
    prompt: { soul: spec.prompt.soul },
    runtime: { ...spec.runtime },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: { kind: "inline", apiServerKey: spec.secrets.apiServerKey },
  };
}

function assertExactKeys(
  path: string,
  value: Record<string, unknown>,
  keys: readonly string[],
  issues: Array<{ path: string; message: string }>,
) {
  const allowed = new Set(keys);

  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
      issues.push({ path, message: "Launch spec symbol fields are not allowed." });
    }
  }

  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor && ("get" in descriptor || "set" in descriptor)) {
      issues.push({ path: `${path}.${key}`, message: "Launch spec accessors are not allowed." });
      continue;
    }

    if (!allowed.has(key)) {
      issues.push({ path: `${path}.${key}`, message: "Unknown launch spec field." });
    }
  }

  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      issues.push({ path: `${path}.${key}`, message: "Launch spec field is required." });
    }
  }
}

function readRecord(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath = "$",
): Record<string, unknown> | null {
  const nested = value[key];

  if (!isPlainLaunchRecord(nested)) {
    issues.push({
      path: `${basePath}.${key}`,
      message: "Launch spec field must be a plain object.",
    });
    return null;
  }

  return nested;
}

function readLiteral<T extends string | boolean | number>(
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
  bounds: { min: number; maxBytes: number; maxScalars?: number; trim?: boolean },
  basePath = "$",
): string {
  const raw = value[key];

  if (typeof raw !== "string") {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec field must be a string." });
    return "";
  }

  const normalized = bounds.trim === false ? raw : raw.trim();
  const scalarCount = [...normalized].length;

  if (
    scalarCount < bounds.min ||
    (bounds.maxScalars !== undefined && scalarCount > bounds.maxScalars) ||
    Buffer.byteLength(normalized, "utf8") > bounds.maxBytes ||
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
  maxBytes: number,
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

  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > maxBytes ||
    hasControlCharacter(normalized)
  ) {
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
  maxBytes: number,
): string {
  const token = readBoundedString(value, key, issues, { min: 1, maxBytes }, basePath);

  if (!/^[A-Za-z0-9_.:-]+$/.test(token)) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec token is invalid." });
  }

  return token;
}

function readRequestId(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const requestId = readBoundedString(value, key, issues, { min: 8, maxBytes: 80 });

  if (!REQUEST_ID_PATTERN.test(requestId)) {
    issues.push({ path: "$.requestId", message: "Launch request id is invalid." });
  }

  return requestId;
}

function readAgentName(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  return readBoundedString(
    value,
    key,
    issues,
    { min: 1, maxBytes: 480, maxScalars: 120 },
    "$.agent",
  );
}

function readUuid(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
  basePath: string,
): string {
  const uuid = readBoundedString(value, key, issues, { min: 36, maxBytes: 36 }, basePath);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec UUID is invalid." });
  }

  return uuid;
}

function readTemplateVersion(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  return readBoundedString(value, key, issues, { min: 1, maxBytes: 40 }, "$.agent");
}

function readConfigRevision(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const revision = readBoundedString(
    value,
    key,
    issues,
    { min: 1, maxBytes: 80, trim: false },
    "$.agent",
  );

  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(revision)) {
    issues.push({ path: "$.agent.configRevision", message: "Launch spec token is invalid." });
  }

  return revision;
}

function readImageRef(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const ref = readBoundedString(value, key, issues, { min: 1, maxBytes: 512 }, "$.image");

  if (!IMAGE_REF_PATTERN.test(ref)) {
    issues.push({ path: "$.image.ref", message: "Launch spec image reference is invalid." });
  }

  return ref;
}

function readOpenRouterModelId(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const model = readBoundedString(value, key, issues, { min: 3, maxBytes: 128 }, "$.model");

  if (!MODEL_ID_PATTERN.test(model) || model.includes("..")) {
    issues.push({ path: "$.model.model", message: "OpenRouter model id is invalid." });
  }

  return model;
}

function readManagedProvider(
  value: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): "openrouter" | "openai-api" | "anthropic" {
  const provider = value.provider;

  if (provider !== "openrouter" && provider !== "openai-api" && provider !== "anthropic") {
    issues.push({ path: "$.model.provider", message: "Managed model provider is invalid." });
    return "openrouter";
  }

  return provider;
}

function readDirectModelId(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const model = readBoundedString(value, key, issues, { min: 3, maxBytes: 128 }, "$.model");

  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(model) || model.includes("..")) {
    issues.push({ path: "$.model.model", message: "Managed model id is invalid." });
  }

  return model;
}

function readPromptSoul(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const soul = readBoundedString(
    value,
    key,
    issues,
    { min: 1, maxBytes: 64 * 1024, maxScalars: 20_000 },
    "$.prompt",
  );

  if (soul.includes("\0")) {
    issues.push({ path: "$.prompt.soul", message: "Prompt contains an invalid character." });
  }

  return soul;
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
    !Object.hasOwn(raw, "length") ||
    raw.length !== expected.length ||
    raw.some((item, index) => item !== expected[index])
  ) {
    issues.push({ path: `${basePath}.${key}`, message: "Launch spec list is invalid." });
  }

  return expected;
}

function readApiServerKey(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): string {
  const secret = readBoundedString(value, key, issues, { min: 40, maxBytes: 300 }, "$.secrets");

  if (!/^agb_agent_[A-Za-z0-9_-]{32,}$/.test(secret)) {
    issues.push({ path: "$.secrets.apiServerKey", message: "Agent API server key is invalid." });
  }

  return secret;
}

function readPatternedSecret(
  value: Record<string, unknown>,
  key: string,
  pattern: RegExp,
  maxBytes: number,
  issues: Array<{ path: string; message: string }>,
): string {
  const secret = readBoundedString(value, key, issues, { min: 1, maxBytes }, "$.secrets");

  if (!pattern.test(secret)) {
    issues.push({ path: `$.secrets.${key}`, message: "Launch spec secret is invalid." });
  }

  return secret;
}

function readTelegramAllowedUsers(
  value: Record<string, unknown>,
  key: string,
  issues: Array<{ path: string; message: string }>,
): readonly string[] {
  const raw = value[key];

  if (!Array.isArray(raw)) {
    issues.push({
      path: "$.secrets.telegramAllowedUsers",
      message: "Telegram allowlist is invalid.",
    });
    return [];
  }

  const seen = new Set<string>();
  const users: string[] = [];

  if (raw.length < 1 || raw.length > 100 || !Object.hasOwn(raw, "length")) {
    issues.push({
      path: "$.secrets.telegramAllowedUsers",
      message: "Telegram allowlist is invalid.",
    });
  }

  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string" || !TELEGRAM_USER_ID_PATTERN.test(item) || seen.has(item)) {
      issues.push({
        path: `$.secrets.telegramAllowedUsers.${index}`,
        message: "Telegram allowlist entry is invalid.",
      });
      continue;
    }

    seen.add(item);
    users.push(item);
  }

  if (Buffer.byteLength(users.join(","), "utf8") > 2_100) {
    issues.push({
      path: "$.secrets.telegramAllowedUsers",
      message: "Telegram allowlist is too large.",
    });
  }

  return users;
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

function isPlainLaunchRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}
