import { describe, expect, it } from "vitest";
import {
  DEFAULT_AGENT_EVENT_ACTOR_DISPLAY_NAME,
  MalformedEventCursorError,
  decodeEventFeedCursor,
  encodeEventFeedCursor,
  getAgentEventActorDisplayName,
  mapAgentEventToDto,
  summarizeAgentEventMetadata,
} from "@/src/server/events/agent-events";

const USER_ID = "00000000-0000-4000-8000-000000000101";
const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000201";

describe("agent event helpers", () => {
  it("round-trips opaque feed cursors and returns typed malformed cursor failures", () => {
    const cursor = encodeEventFeedCursor({
      createdAt: new Date("2026-07-04T06:00:00.000Z"),
      id: "00000000-0000-4000-8000-000000000301",
    });

    expect(decodeEventFeedCursor(cursor)).toEqual({
      ok: true,
      cursor: {
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
        id: "00000000-0000-4000-8000-000000000301",
      },
    });

    expect(decodeEventFeedCursor("")).toMatchObject({
      ok: false,
      error: expect.any(MalformedEventCursorError),
    });
    expect(decodeEventFeedCursor("not a cursor")).toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "invalid_encoding" }),
    });
    expect(decodeEventFeedCursor(encodeRawCursorPayload("not-json"))).toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "invalid_json" }),
    });
    expect(decodeEventFeedCursor(encodeRawCursorPayload({ v: 2 }))).toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "unsupported_version" }),
    });
    expect(
      decodeEventFeedCursor(
        encodeRawCursorPayload({
          v: 1,
          createdAt: "2026-07-04",
          id: "00000000-0000-4000-8000-000000000301",
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "invalid_created_at" }),
    });
    expect(
      decodeEventFeedCursor(
        encodeRawCursorPayload({
          v: 1,
          createdAt: "2026-07-04T06:00:00.000Z",
          id: "not-a-uuid",
        }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.objectContaining({ reason: "invalid_id" }),
    });
  });

  it("maps events to DTOs with actor display defaults and readable metadata summaries", () => {
    expect(getAgentEventActorDisplayName(null)).toBe(DEFAULT_AGENT_EVENT_ACTOR_DISPLAY_NAME);
    expect(getAgentEventActorDisplayName("  Jane Operator  ")).toBe("Jane Operator");
    expect(
      summarizeAgentEventMetadata({
        templateKey: "research_agent",
        status: "stopped",
        fromStatus: "running",
        toStatus: "stopped",
        deletedAt: "2026-07-04T06:00:00.000Z",
        retryCount: 2,
      }),
    ).toBe(
      "running -> stopped; Template: research_agent; Status: stopped; Deleted at: 2026-07-04T06:00:00.000Z; Retry Count: 2",
    );
    expect(
      summarizeAgentEventMetadata({
        changedFields: [
          { field: "modelName", before: "not_configured", after: "gpt-4.1-mini" },
          { field: "maxDailySpend", before: "$0.00", after: "$12.34" },
        ],
      }),
    ).toBe("Changed: Model Name: not_configured -> gpt-4.1-mini, Max Daily Spend: $0.00 -> $12.34");
    expect(summarizeAgentEventMetadata({ nested: { ignored: true } })).toBeNull();

    const dto = mapAgentEventToDto(
      {
        id: "00000000-0000-4000-8000-000000000301",
        agentId: ACTIVE_AGENT_ID,
        actorUserId: USER_ID,
        type: "agent.created",
        message: 'Created agent "Research Agent".',
        metadata: {
          templateKey: "research_agent",
          status: "stopped",
        },
        createdAt: new Date("2026-07-04T06:00:00.000Z"),
      },
      {
        agent: {
          id: ACTIVE_AGENT_ID,
          name: "Research Agent",
          templateKey: "research_agent",
          status: "stopped",
          deletedAt: null,
        },
      },
    );

    expect(dto).toEqual({
      id: "00000000-0000-4000-8000-000000000301",
      agentId: ACTIVE_AGENT_ID,
      actor: {
        userId: USER_ID,
        displayName: DEFAULT_AGENT_EVENT_ACTOR_DISPLAY_NAME,
      },
      type: "agent.created",
      message: 'Created agent "Research Agent".',
      metadata: {
        templateKey: "research_agent",
        status: "stopped",
      },
      metadataSummary: "Template: research_agent; Status: stopped",
      createdAt: "2026-07-04T06:00:00.000Z",
      agent: {
        id: ACTIVE_AGENT_ID,
        name: "Research Agent",
        templateKey: "research_agent",
        status: "stopped",
        deletedAt: null,
      },
    });
  });
});

function encodeRawCursorPayload(payload: unknown): string {
  return Buffer.from(
    typeof payload === "string" ? payload : JSON.stringify(payload),
    "utf8",
  ).toString("base64url");
}
