import { describe, expect, it } from "vitest";
import {
  AGENT_NAME_MAX_LENGTH,
  validateCreateAgentPayload,
} from "@/src/server/agents/create-agent";
import { SUPPORTED_AGENT_TEMPLATE_KEYS } from "@/src/server/agents/templates";

describe("create agent validation", () => {
  it("accepts supported template keys and trims the requested agent name", () => {
    for (const templateKey of SUPPORTED_AGENT_TEMPLATE_KEYS) {
      expect(validateCreateAgentPayload({ name: " Research Agent ", templateKey })).toEqual({
        ok: true,
        value: {
          name: "Research Agent",
          templateKey,
        },
      });
    }
  });

  it("rejects malformed payload shapes, invalid names, and unknown templates", () => {
    expect(validateCreateAgentPayload(null)).toMatchObject({
      ok: false,
      issues: [{ field: "body" }],
    });
    expect(validateCreateAgentPayload(["Research Agent"])).toMatchObject({
      ok: false,
      issues: [{ field: "body" }],
    });
    expect(
      validateCreateAgentPayload({ name: "   ", templateKey: "research_agent" }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "name" }],
    });
    expect(
      validateCreateAgentPayload({
        name: "A".repeat(AGENT_NAME_MAX_LENGTH + 1),
        templateKey: "research_agent",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "name" }],
    });
    expect(
      validateCreateAgentPayload({ name: "Research Agent", templateKey: "unknown" }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "templateKey" }],
    });
  });
});
