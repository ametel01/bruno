import { describe, expect, it } from "vitest";
import {
  AGENT_TEMPLATE_OPTIONS,
  AGENT_TEMPLATE_REGISTRY,
  getAgentTemplateLabel,
  getAgentTemplateSnapshot,
  isSupportedTemplateKey,
  SUPPORTED_AGENT_TEMPLATE_KEYS,
} from "@/src/server/agents/templates";

describe("agent template registry", () => {
  it("exposes exactly the Milestone 5 template keys in product order", () => {
    expect(SUPPORTED_AGENT_TEMPLATE_KEYS).toEqual([
      "research_agent",
      "inbox_triage_agent",
      "github_issue_agent",
      "social_content_agent",
    ]);
    expect(AGENT_TEMPLATE_OPTIONS.map((template) => template.key)).toEqual([
      "research_agent",
      "inbox_triage_agent",
      "github_issue_agent",
      "social_content_agent",
    ]);
  });

  it("defines complete metadata-only template snapshots", () => {
    expect(AGENT_TEMPLATE_REGISTRY.research_agent).toMatchObject({
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      defaultTools: ["Web search", "Notes", "Summaries"],
      defaultSchedule: "Manual",
      requiredIntegrations: [],
    });

    for (const template of AGENT_TEMPLATE_OPTIONS) {
      expect(template.version).toBe("1.0.0");
      expect(template.name).not.toHaveLength(0);
      expect(template.description).not.toHaveLength(0);
      expect(template.defaultTools.length).toBeGreaterThan(0);
      expect(template.defaultSchedule).toBe("Manual");
      expect(template.defaultSystemPrompt).not.toHaveLength(0);
      expect(template.requiredIntegrations).toEqual([]);
    }
  });

  it("returns immutable creation snapshots and validates unknown keys safely", () => {
    const snapshot = getAgentTemplateSnapshot("github_issue_agent");

    snapshot.defaultTools.push("Mutated in test");

    expect(getAgentTemplateSnapshot("github_issue_agent").defaultTools).toEqual([
      "Issue review",
      "Reproduction checklist",
      "Maintainer summary",
    ]);
    expect(isSupportedTemplateKey("github_issue_agent")).toBe(true);
    expect(isSupportedTemplateKey("unknown")).toBe(false);
    expect(getAgentTemplateLabel("github_issue_agent")).toBe("GitHub Issue Agent");
    expect(getAgentTemplateLabel("legacy_agent")).toBe("legacy_agent");
  });
});
