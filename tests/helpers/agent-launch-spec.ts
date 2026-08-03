import {
  AGENT_LAUNCH_SPEC_VERSION,
  MANAGED_AGENT_LAUNCH_SPEC_VERSION,
  type ManagedAgentLaunchSpec,
  type NativeAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";

export function sampleLaunchSpec(
  overrides: Partial<NativeAgentLaunchSpec> = {},
): NativeAgentLaunchSpec {
  return {
    version: AGENT_LAUNCH_SPEC_VERSION,
    requestId: "00000000-0000-4000-8000-000000000501",
    agent: {
      id: "00000000-0000-4000-8000-000000000123",
      name: "Hermes Agent",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      configRevision: "cfg-1784000000000",
    },
    image: {
      ref: "nousresearch/hermes-agent:v2026.7.7.2@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973",
    },
    model: {
      provider: "hermes",
      model: "configured-by-hermes",
    },
    schedule: {
      mode: "manual",
      cron: null,
      timezone: "UTC",
    },
    prompt: {
      soul: "You are a careful Hermes agent.",
    },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 25,
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      apiServerKey: "agb_agent_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
    },
    ...overrides,
  };
}

export function sampleManagedLaunchSpec(
  overrides: Partial<ManagedAgentLaunchSpec> = {},
): ManagedAgentLaunchSpec {
  return {
    version: MANAGED_AGENT_LAUNCH_SPEC_VERSION,
    requestId: "managed-request-0001",
    agent: {
      id: "00000000-0000-4000-8000-000000000123",
      name: "Managed Hermes Agent",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      configRevision: "cfg-1784000000000",
    },
    image: {
      ref: "nousresearch/hermes-agent:v2026.7.7.2@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973",
    },
    model: {
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
    },
    platforms: {
      required: ["api_server", "telegram"],
      apiServer: {
        enabled: true,
        host: "0.0.0.0",
        port: 8642,
      },
      telegram: {
        enabled: true,
        allowAllUsers: false,
        unauthorizedDmBehavior: "ignore",
      },
    },
    schedule: {
      mode: "manual",
      cron: null,
      timezone: "UTC",
    },
    prompt: {
      soul: "You are a careful managed Hermes agent.",
    },
    runtime: {
      dataDir: "/opt/data",
      workspaceDir: "/workspace",
      terminalCwd: "/workspace",
      browserEnabled: false,
      unattendedLoopLimit: 25,
      toolLoopGuardrails: {
        hardStopEnabled: true,
        hardStopAfter: {
          exactFailure: 5,
          idempotentNoProgress: 5,
        },
      },
    },
    tools: {
      enabled: ["file_operations", "terminal"],
      disabled: ["browser", "mcp", "delegation", "voice", "code_execution"],
    },
    secrets: {
      kind: "inline",
      openrouterApiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz1234567890",
      telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      telegramAllowedUsers: ["1", "222222"],
      apiServerKey: "agb_agent_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
    },
    ...overrides,
  };
}
