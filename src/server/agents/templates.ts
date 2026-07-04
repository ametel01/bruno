export const SUPPORTED_AGENT_TEMPLATE_KEYS = [
  "research_agent",
  "inbox_triage_agent",
  "github_issue_agent",
  "social_content_agent",
] as const;

export type SupportedAgentTemplateKey = (typeof SUPPORTED_AGENT_TEMPLATE_KEYS)[number];

export type AgentTemplateSnapshot = {
  key: SupportedAgentTemplateKey;
  version: string;
  name: string;
  description: string;
  defaultTools: string[];
  defaultSchedule: "Manual";
  defaultSystemPrompt: string;
  requiredIntegrations: string[];
};

export type AgentTemplate = {
  readonly key: SupportedAgentTemplateKey;
  readonly version: string;
  readonly name: string;
  readonly description: string;
  readonly defaultTools: readonly string[];
  readonly defaultSchedule: "Manual";
  readonly defaultSystemPrompt: string;
  readonly requiredIntegrations: readonly string[];
};

export const AGENT_TEMPLATE_REGISTRY = {
  research_agent: {
    key: "research_agent",
    version: "1.0.0",
    name: "Research Agent",
    description:
      "Tracks a research question, gathers source notes, and produces concise summaries for later review.",
    defaultTools: ["Web search", "Notes", "Summaries"],
    defaultSchedule: "Manual",
    defaultSystemPrompt:
      "You are a Research Agent. Gather relevant information, keep source notes, and produce concise summaries. Do not take external actions or contact third parties. Ask for approval before using any integration or publishing output.",
    requiredIntegrations: [],
  },
  inbox_triage_agent: {
    key: "inbox_triage_agent",
    version: "1.0.0",
    name: "Inbox Triage Agent",
    description:
      "Reviews incoming messages, groups them by urgency, and drafts response notes for operator review.",
    defaultTools: ["Inbox review", "Priority summary", "Reply drafts"],
    defaultSchedule: "Manual",
    defaultSystemPrompt:
      "You are an Inbox Triage Agent. Review message context, classify urgency, summarize requested action, and draft replies for human review. Do not send messages or change mailbox state without explicit approval.",
    requiredIntegrations: [],
  },
  github_issue_agent: {
    key: "github_issue_agent",
    version: "1.0.0",
    name: "GitHub Issue Agent",
    description:
      "Reviews repository issues, summarizes context, and prepares triage notes for maintainers.",
    defaultTools: ["Issue review", "Reproduction checklist", "Maintainer summary"],
    defaultSchedule: "Manual",
    defaultSystemPrompt:
      "You are a GitHub Issue Agent. Review issue context, identify reproduction steps, blockers, and likely next actions, then prepare maintainer-facing triage notes. Do not change issues, labels, branches, or code without explicit approval.",
    requiredIntegrations: [],
  },
  social_content_agent: {
    key: "social_content_agent",
    version: "1.0.0",
    name: "Social Content Agent",
    description:
      "Turns source notes or long-form updates into channel-specific post drafts and publishing checklists.",
    defaultTools: ["Source notes", "Post drafts", "Publishing checklist"],
    defaultSchedule: "Manual",
    defaultSystemPrompt:
      "You are a Social Content Agent. Convert approved source material into concise post drafts, variants, and publishing checklists. Do not publish or schedule posts without explicit approval.",
    requiredIntegrations: [],
  },
} as const satisfies Record<SupportedAgentTemplateKey, AgentTemplate>;

export const AGENT_TEMPLATE_OPTIONS = SUPPORTED_AGENT_TEMPLATE_KEYS.map((key) =>
  snapshotAgentTemplate(AGENT_TEMPLATE_REGISTRY[key]),
);

export function isSupportedTemplateKey(value: unknown): value is SupportedAgentTemplateKey {
  return (
    typeof value === "string" &&
    SUPPORTED_AGENT_TEMPLATE_KEYS.includes(value as SupportedAgentTemplateKey)
  );
}

export function getAgentTemplate(key: SupportedAgentTemplateKey): AgentTemplate {
  return AGENT_TEMPLATE_REGISTRY[key];
}

export function getAgentTemplateLabel(key: string): string {
  return isSupportedTemplateKey(key) ? AGENT_TEMPLATE_REGISTRY[key].name : key;
}

export function snapshotAgentTemplate(template: AgentTemplate): AgentTemplateSnapshot {
  return {
    key: template.key,
    version: template.version,
    name: template.name,
    description: template.description,
    defaultTools: [...template.defaultTools],
    defaultSchedule: template.defaultSchedule,
    defaultSystemPrompt: template.defaultSystemPrompt,
    requiredIntegrations: [...template.requiredIntegrations],
  };
}

export function getAgentTemplateSnapshot(key: SupportedAgentTemplateKey): AgentTemplateSnapshot {
  return snapshotAgentTemplate(getAgentTemplate(key));
}
