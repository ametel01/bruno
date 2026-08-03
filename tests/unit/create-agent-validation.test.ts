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
          runnerId: null,
        },
      });
    }
  });

  it("keeps omitted and explicit stopped launch mode compatible", () => {
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        launchMode: "stopped",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Research Agent",
        templateKey: "research_agent",
        runnerId: null,
      },
    });
  });

  it("rejects ready-only fields on stopped requests", () => {
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        openrouterApiKey: "sk-or-v1-abcdefghijklmnopqrstuvwxyz",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "openrouterApiKey" }],
    });
  });

  it("accepts a replay-compatible ready envelope without credentials", () => {
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        launchMode: "ready",
        idempotencyKey: "Ready-Key_01",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Research Agent",
        templateKey: "research_agent",
        runnerId: null,
        launchMode: "ready",
        idempotencyKey: "Ready-Key_01",
        openrouterModel: undefined,
        openrouterApiKey: undefined,
        telegramBotToken: undefined,
        telegramAllowedUserIds: undefined,
      },
    });
  });

  it("rejects malformed ready idempotency and client-owned metadata", () => {
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        launchMode: "ready",
        idempotencyKey: "short",
      }),
    ).toMatchObject({ ok: false, issues: [{ field: "idempotencyKey" }] });
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        launchMode: "ready",
        idempotencyKey: "Ready-Key_02",
        modelProvider: "openrouter",
      }),
    ).toMatchObject({ ok: false, issues: [{ field: "body" }] });
  });

  it("accepts a valid runner ID and rejects malformed runner IDs", () => {
    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        runnerId: " 00000000-0000-4000-8000-000000000131 ",
      }),
    ).toEqual({
      ok: true,
      value: {
        name: "Research Agent",
        templateKey: "research_agent",
        runnerId: "00000000-0000-4000-8000-000000000131",
      },
    });

    expect(
      validateCreateAgentPayload({
        name: "Research Agent",
        templateKey: "research_agent",
        runnerId: "not-a-runner-id",
      }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: "runnerId" }],
    });
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
