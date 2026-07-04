import { describe, expect, it } from "vitest";
import {
  toAssignedManualRunnerStatusSummary,
  toManualRunnerStatusSummary,
} from "@/src/server/runners/manual-runner-status";

describe("manual runner status summaries", () => {
  it("exposes only safe runner fields and endpoint host", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Manual Runner",
      kind: "manual_vps",
      endpointUrl: "https://user:password@runner.example.com:8443/runner/v1?token=hidden",
      status: "active",
      updatedAt: new Date("2026-07-05T01:00:00.000Z"),
    });

    expect(summary).toEqual({
      name: "Manual Runner",
      kind: "manual_vps",
      endpointHost: "runner.example.com:8443",
      status: "online",
      updatedAt: "2026-07-05T01:00:00.000Z",
      checkedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain("password");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("/runner/v1");
  });

  it("redacts unsafe names and maps inactive assignments to offline alerts", () => {
    const assigned = toAssignedManualRunnerStatusSummary({
      name: "TOKEN=stored-for-downstream",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "inactive",
      updatedAt: "2026-07-05T01:30:00.000Z",
    });

    expect(assigned).toMatchObject({
      name: "Sensitive details omitted.",
      endpointHost: "runner.example.com",
      status: "offline",
      alertState: "offline",
      alertMessage:
        "Assigned manual runner is inactive or unreachable. Check the runner host and service before restarting work.",
    });
    expect(JSON.stringify(assigned)).not.toContain("stored-for-downstream");
    expect(JSON.stringify(assigned)).not.toContain("runnerId");
    expect(JSON.stringify(assigned)).not.toContain("runner_id");
  });
});
