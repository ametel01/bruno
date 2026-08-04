import { describe, expect, it } from "vitest";
import {
  buildAgentOperationalAlerts,
  summarizeOperationalText,
} from "@/src/server/alerts/operational-summaries";

describe("operational summaries", () => {
  it("derives scoped agent, approval, and event alerts without mixing other agents", () => {
    const result = buildAgentOperationalAlerts({
      now: new Date("2026-07-04T12:00:00.000Z"),
      runnerState: null,
      agent: {
        id: "00000000-0000-4000-8000-000000000201",
        name: "Mobile Alert Agent",
        status: "error",
        statusReason: "Worker failed after approval timeout.",
      },
      approvals: [
        {
          id: "00000000-0000-4000-8000-000000000301",
          agentId: "00000000-0000-4000-8000-000000000201",
          title: "Review outbound message",
          requestedBy: "fake-runner",
          expiresAt: "2026-07-04T11:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000302",
          agentId: "00000000-0000-4000-8000-000000000202",
          title: "Other agent approval",
          requestedBy: "fake-runner",
          expiresAt: "2026-07-04T11:00:00.000Z",
        },
      ],
      events: [
        {
          id: "00000000-0000-4000-8000-000000000401",
          agentId: "00000000-0000-4000-8000-000000000201",
          type: "agent.error",
          message: "Agent failed with a bounded operator-safe message.",
          createdAt: "2026-07-04T10:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-000000000402",
          agentId: "00000000-0000-4000-8000-000000000202",
          type: "agent.error",
          message: "Other agent failure should not appear.",
          createdAt: "2026-07-04T10:05:00.000Z",
        },
      ],
    });

    expect(result.alerts.map((alert) => alert.title)).toEqual([
      "Agent is in error",
      "Approval expired",
      "Agent error",
    ]);
    expect(result.alerts.map((alert) => alert.source)).toEqual(["agent", "approval", "event"]);
    expect(result.alerts.map((alert) => alert.severity)).toEqual([
      "critical",
      "critical",
      "critical",
    ]);
    expect(JSON.stringify(result.alerts)).not.toContain("Other agent");
    expect(result.runnerStateNotice).toContain("No assigned manual runner state is available");
  });

  it("derives runner offline and degraded alerts when runner state is supplied", () => {
    const result = buildAgentOperationalAlerts({
      agent: {
        id: "00000000-0000-4000-8000-000000000201",
        name: "Runner State Agent",
        status: "running",
        statusReason: null,
      },
      approvals: [],
      events: [],
      runnerState: {
        status: "degraded",
        message: "Heartbeat delayed for 90 seconds.",
        updatedAt: "2026-07-04T12:05:00.000Z",
      },
    });

    expect(result.alerts).toEqual([
      {
        id: "runner:00000000-0000-4000-8000-000000000201:degraded",
        severity: "warning",
        title: "Runner is degraded",
        message: "Heartbeat delayed for 90 seconds.",
        createdAt: "2026-07-04T12:05:00.000Z",
        source: "runner",
      },
    ]);
    expect(result.runnerStateNotice).toBeNull();
  });

  it("suppresses runner warnings and empty notices during automatic replacement", () => {
    const result = buildAgentOperationalAlerts({
      automaticRecoveryActive: true,
      agent: {
        id: "00000000-0000-4000-8000-000000000201",
        name: "Recovery Agent",
        status: "starting",
        statusReason: null,
      },
      approvals: [],
      events: [],
      runnerState: {
        status: "degraded",
        message: "Private runner endpoint and resource details.",
        updatedAt: "2026-07-04T12:05:00.000Z",
      },
    });

    expect(result).toEqual({ alerts: [], runnerStateNotice: null });
    expect(JSON.stringify(result)).not.toMatch(/runner endpoint|resource details/i);
  });

  it("redacts unsafe operational text and bounds long summaries", () => {
    expect(
      summarizeOperationalText(
        "Error: failed\n    at run (/app/worker.ts:10:2)\npostgres://user:pass@localhost/db",
        "fallback",
      ),
    ).toBe("Error: failed [redacted database URL]");
    expect(summarizeOperationalText("token=stored-for-downstream", "fallback")).toBe(
      "Sensitive details omitted.",
    );
    expect(summarizeOperationalText(`{"payload":"${"x".repeat(120)}"}`, "fallback")).toBe(
      "Structured details omitted.",
    );
    expect(summarizeOperationalText("x".repeat(220), "fallback")).toHaveLength(180);
    expect(summarizeOperationalText("   ", "fallback")).toBe("fallback");
  });
});
