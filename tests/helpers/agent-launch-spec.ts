import {
  AGENT_LAUNCH_SPEC_VERSION,
  type AgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";

export function sampleLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
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
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
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
      openrouterApiKey: "sk-or-v1-1234567890abcdefghijklmnopqrstuvwxyz",
      telegramBotToken: "123456:abcdefghijklmnopqrstuvwxyz",
      telegramAllowedUsers: "123456789,987654321",
      apiServerKey: "agb_agent_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFG",
    },
    ...overrides,
  };
}
