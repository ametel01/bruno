import { describe, expect, it, vi } from "vitest";
import {
  buildManualCreateRequest,
  buildReadyCreateRequest,
  parseManualCreatedHref,
  READY_SECRET_FIELD_NAMES,
  type LogicalSubmission,
} from "@/app/agents/_components/create-agent-form";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    replace: vi.fn(),
  }),
}));

const AGENT_ID = "00000000-0000-4000-8000-000000000321";

describe("create agent form controller", () => {
  it("builds exact ready payloads with the sole approved model and optional runner", () => {
    const result = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "CREATE-KEY-1",
      currentSubmission: null,
      form: readyForm({ runnerId: "" }),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent"],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(Object.keys(result.payload).sort()).toEqual([
      "idempotencyKey",
      "launchMode",
      "name",
      "openrouterApiKey",
      "openrouterModel",
      "runnerId",
      "telegramAllowedUserIds",
      "telegramBotToken",
      "templateKey",
    ]);
    expect(result.payload).toEqual({
      idempotencyKey: "create-key-1",
      launchMode: "ready",
      name: "Research Agent",
      openrouterApiKey: "sk-or-secret",
      openrouterModel: "openai/gpt-5-mini",
      runnerId: null,
      telegramAllowedUserIds: ["123", "456"],
      telegramBotToken: "123:telegram-secret",
      templateKey: "research_agent",
    });

    const assigned = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "CREATE-KEY-2",
      currentSubmission: null,
      form: readyForm({ runnerId: "runner-1" }),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent"],
    });

    expect(assigned.ok && assigned.payload.runnerId).toBe("runner-1");
  });

  it("keeps one UUID per logical ready submit across ambiguous and definitive retries", () => {
    const first = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "KEY-A",
      currentSubmission: null,
      form: readyForm(),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent", "inbox_triage_agent"],
    });

    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const ambiguousSubmission: LogicalSubmission = {
      ...first.nextSubmission,
      envelopeLocked: true,
    };
    const ambiguousRetry = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "KEY-SHOULD-NOT-BE-USED",
      currentSubmission: ambiguousSubmission,
      form: readyForm({
        name: "Edited Agent",
        openrouterApiKey: "sk-or-new",
        telegramBotToken: "456:telegram-new",
        templateKey: "inbox_triage_agent",
      }),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent", "inbox_triage_agent"],
    });

    expect(ambiguousRetry.ok).toBe(true);
    if (!ambiguousRetry.ok) {
      return;
    }
    expect(ambiguousRetry.payload.idempotencyKey).toBe("key-a");
    expect(ambiguousRetry.payload.name).toBe("Research Agent");
    expect(ambiguousRetry.payload.templateKey).toBe("research_agent");
    expect(ambiguousRetry.payload.openrouterApiKey).toBe("sk-or-new");
    expect(ambiguousRetry.payload.telegramBotToken).toBe("456:telegram-new");

    const definitiveRetry = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "KEY-SHOULD-NOT-BE-USED",
      currentSubmission: { ...first.nextSubmission, envelopeLocked: false },
      form: readyForm({
        name: "Edited Agent",
        templateKey: "inbox_triage_agent",
      }),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent", "inbox_triage_agent"],
    });

    expect(definitiveRetry.ok && definitiveRetry.payload.idempotencyKey).toBe("key-a");
    expect(definitiveRetry.ok && definitiveRetry.payload.name).toBe("Edited Agent");
    expect(definitiveRetry.ok && definitiveRetry.payload.templateKey).toBe("inbox_triage_agent");

    const startOver = buildReadyCreateRequest({
      approvedModelIds: ["openai/gpt-5-mini"],
      createIdempotencyKey: () => "KEY-B",
      currentSubmission: null,
      form: readyForm({ name: "Fresh Agent" }),
      maxNameLength: 80,
      readyModeEnabled: true,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent"],
    });

    expect(startOver.ok && startOver.payload.idempotencyKey).toBe("key-b");
    expect(startOver.ok && startOver.payload.name).toBe("Fresh Agent");
  });

  it("keeps ready secrets out of the logical submission seam", () => {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = buildReadyCreateRequest({
        approvedModelIds: ["openai/gpt-5-mini"],
        createIdempotencyKey: () => "KEY-A",
        currentSubmission: null,
        form: readyForm(),
        maxNameLength: 80,
        readyModeEnabled: true,
        runnerIds: ["runner-1"],
        templateKeys: ["research_agent"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      expect(result.credentialFieldNames).toBe(READY_SECRET_FIELD_NAMES);
      expect(JSON.stringify(result.nextSubmission)).not.toContain("sk-or-secret");
      expect(JSON.stringify(result.nextSubmission)).not.toContain("telegram-secret");
      expect(JSON.stringify(result.nextSubmission)).not.toContain("123");
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(consoleLog).not.toHaveBeenCalled();
    } finally {
      consoleInfo.mockRestore();
      consoleLog.mockRestore();
    }
  });

  it("builds exact manual payloads and parses exact 201 envelopes", () => {
    const manual = buildManualCreateRequest({
      form: {
        name: " Manual Agent ",
        runnerId: "runner-1",
        templateKey: "research_agent",
      },
      maxNameLength: 80,
      runnerIds: ["runner-1"],
      templateKeys: ["research_agent"],
    });

    expect(manual).toEqual({
      ok: true,
      payload: {
        name: "Manual Agent",
        runnerId: "runner-1",
        templateKey: "research_agent",
      },
    });
    expect(parseManualCreatedHref(manualCreatedBody())).toBe(`/agents/${AGENT_ID}`);
    expect(parseManualCreatedHref({ ...manualCreatedBody(), idempotencyKey: "hidden" })).toBeNull();
    expect(
      parseManualCreatedHref({
        ...manualCreatedBody(),
        agent: { ...manualCreatedBody().agent, telegramBotToken: "secret" },
      }),
    ).toBeNull();
  });
});

function readyForm(
  overrides: Partial<Parameters<typeof buildReadyCreateRequest>[0]["form"]> = {},
): Parameters<typeof buildReadyCreateRequest>[0]["form"] {
  return {
    name: "Research Agent",
    openrouterApiKey: "sk-or-secret",
    openrouterModel: "openai/gpt-5-mini",
    runnerId: "runner-1",
    telegramAllowedUserIds: "123\n456\n123",
    telegramBotToken: "123:telegram-secret",
    templateKey: "research_agent",
    ...overrides,
  };
}

function manualCreatedBody() {
  return {
    agent: {
      id: AGENT_ID,
      userId: "00000000-0000-4000-8000-000000000322",
      name: "Manual Agent",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      templateSnapshotJson: {},
      status: "stopped",
      statusReason: null,
      runnerId: "runner-1",
      createdAt: "2026-08-03T05:00:00.000Z",
      updatedAt: "2026-08-03T05:00:00.000Z",
      deletedAt: null,
    },
    event: { type: "agent.created" },
  };
}
