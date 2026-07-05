import { describe, expect, it } from "vitest";
import {
  toAssignedManualRunnerStatusSummary,
  toManualRunnerStatusSummary,
  toSettingsRunnerManagementSummary,
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
      status: "unknown",
      version: null,
      lastSeenAt: null,
      updatedAt: "2026-07-05T01:00:00.000Z",
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

  it("uses latest heartbeat status, version, and last-seen fields without metrics", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Online Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "active",
      updatedAt: "2026-07-05T02:00:00.000Z",
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.2.3",
          metrics: {
            cpuPercent: 37,
            memoryUsedMb: 512,
            apiToken: "must-not-render",
          },
        },
        observedAt: "2026-07-05T02:01:00.000Z",
      },
    });

    expect(summary).toEqual({
      name: "Online Runner",
      kind: "manual_vps",
      endpointHost: "runner.example.com",
      status: "online",
      version: "agentbay-runner/1.2.3",
      lastSeenAt: "2026-07-05T02:01:00.000Z",
      updatedAt: "2026-07-05T02:00:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("metrics");
    expect(JSON.stringify(summary)).not.toContain("cpuPercent");
    expect(JSON.stringify(summary)).not.toContain("memoryUsedMb");
    expect(JSON.stringify(summary)).not.toContain("must-not-render");
  });

  it("keeps reconciled offline runner state ahead of a stale online heartbeat", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Stale Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "offline",
      updatedAt: "2026-07-05T08:02:00.000Z",
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.0.0",
        },
        observedAt: "2026-07-05T08:00:29.999Z",
      },
    });
    const assigned = toAssignedManualRunnerStatusSummary({
      name: "Assigned Stale Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "offline",
      updatedAt: "2026-07-05T08:02:00.000Z",
      latestHeartbeat: {
        status: "online",
        metadata: {
          version: "agentbay-runner/1.0.0",
        },
        observedAt: "2026-07-05T08:00:29.999Z",
      },
    });

    expect(summary).toMatchObject({
      status: "offline",
      version: "agentbay-runner/1.0.0",
      lastSeenAt: "2026-07-05T08:00:29.999Z",
    });
    expect(assigned).toMatchObject({
      status: "offline",
      alertState: "offline",
      alertMessage:
        "Assigned manual runner is inactive or unreachable. Check the runner host and service before restarting work.",
    });
  });

  it("redacts secret-looking heartbeat versions", () => {
    const summary = toManualRunnerStatusSummary({
      name: "Degraded Runner",
      kind: "manual_vps",
      endpointUrl: "https://runner.example.com",
      status: "degraded",
      updatedAt: "2026-07-05T02:00:00.000Z",
      latestHeartbeat: {
        status: "degraded",
        metadata: {
          version: "token=stored-for-downstream",
        },
        observedAt: "2026-07-05T02:01:00.000Z",
      },
    });

    expect(summary.version).toBe("Sensitive details omitted.");
    expect(JSON.stringify(summary)).not.toContain("stored-for-downstream");
  });

  it("adds a settings-only management id without adding secret or hash fields", () => {
    const summary = toSettingsRunnerManagementSummary({
      id: "00000000-0000-4000-8000-000000000133",
      name: "Settings Runner",
      kind: "manual_vps",
      endpointUrl: "https://user:password@runner-settings.example.com:8443/runner/v1?token=hidden",
      status: "online",
      updatedAt: "2026-07-05T03:01:00.000Z",
    });

    expect(summary).toEqual({
      managementId: "00000000-0000-4000-8000-000000000133",
      name: "Settings Runner",
      kind: "manual_vps",
      endpointHost: "runner-settings.example.com:8443",
      status: "online",
      version: null,
      lastSeenAt: null,
      updatedAt: "2026-07-05T03:01:00.000Z",
    });
    expect(JSON.stringify(summary)).not.toContain("password");
    expect(JSON.stringify(summary)).not.toContain("token=hidden");
    expect(JSON.stringify(summary)).not.toContain("credentialHash");
    expect(JSON.stringify(summary)).not.toContain("tokenHash");
  });
});
