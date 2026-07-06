import { describe, expect, it } from "vitest";
import { toCloudRunnerProvisioningSummary } from "@/src/server/runners/cloud-runner-provisioning";

describe("cloud runner provisioning summaries", () => {
  it("renders only safe persisted provisioning fields", () => {
    const summary = toCloudRunnerProvisioningSummary(
      {
        id: "00000000-0000-4000-8000-000000000154",
        name: "Cloud Runner",
        kind: "digitalocean",
        status: "provisioning",
        provider: "digitalocean",
        providerResourceId: "do-droplet-154",
        region: "nyc3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "firewall_configuring",
        provisioningError: null,
        provisioningStartedAt: "2026-07-06T01:00:00.000Z",
        provisioningCompletedAt: null,
      },
      null,
    );

    expect(summary).toMatchObject({
      id: "00000000-0000-4000-8000-000000000154",
      name: "Cloud Runner",
      kind: "digitalocean",
      status: "provisioning",
      readinessStatus: "provisioning",
      provider: "digitalocean",
      providerResourceId: "do-droplet-154",
      region: "nyc3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      latestHeartbeatAt: null,
      provisioning: {
        status: "firewall_configuring",
        error: null,
        startedAt: "2026-07-06T01:00:00.000Z",
        completedAt: null,
      },
    });
    expect(summary.provisioning.phases).toContainEqual({
      name: "firewall_configuring",
      status: "current",
      startedAt: "2026-07-06T01:00:00.000Z",
      completedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain("registrationToken");
    expect(JSON.stringify(summary)).not.toContain("credentialHash");
    expect(JSON.stringify(summary)).not.toContain("AGENTBAY_DIGITALOCEAN_TOKEN");
    expect(JSON.stringify(summary)).not.toContain("dop_v1");
  });

  it("maps successful heartbeat status to online readiness", () => {
    const summary = toCloudRunnerProvisioningSummary(
      {
        id: "00000000-0000-4000-8000-000000000155",
        name: "Online Cloud Runner",
        kind: "digitalocean",
        status: "online",
        provider: "digitalocean",
        providerResourceId: "do-droplet-155",
        region: "sfo3",
        sizeSlug: "s-2vcpu-2gb",
        image: "ubuntu-24-04-x64",
        provisioningStatus: "ready",
        provisioningError: null,
        provisioningStartedAt: "2026-07-06T01:00:00.000Z",
        provisioningCompletedAt: "2026-07-06T01:03:00.000Z",
      },
      {
        status: "online",
        observedAt: "2026-07-06T01:04:00.000Z",
      },
    );

    expect(summary.readinessStatus).toBe("online");
    expect(summary.latestHeartbeatAt).toBe("2026-07-06T01:04:00.000Z");
    expect(summary.provisioning.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "waiting_for_runner", status: "completed" }),
        expect.objectContaining({ name: "ready", status: "completed" }),
        expect.objectContaining({ name: "failed", status: "pending" }),
        expect.objectContaining({ name: "cleaning_up", status: "pending" }),
        expect.objectContaining({ name: "deleted", status: "pending" }),
      ]),
    );
  });

  it("redacts secret-looking failure details and supplies an actionable fallback", () => {
    const summary = toCloudRunnerProvisioningSummary({
      id: "00000000-0000-4000-8000-000000000156",
      name: "TOKEN=stored-for-downstream",
      kind: "digitalocean",
      status: "provision_failed",
      provider: "digitalocean",
      providerResourceId: null,
      region: "nyc3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      provisioningStatus: "failed",
      provisioningError: "token=stored-for-downstream",
      provisioningStartedAt: "2026-07-06T01:00:00.000Z",
      provisioningCompletedAt: "2026-07-06T01:02:00.000Z",
    });

    expect(summary.name).toBe("Sensitive details omitted.");
    expect(summary.readinessStatus).toBe("failed");
    expect(summary.provisioning.error).toBe("Sensitive details omitted.");
    expect(summary.provisioning.phases).toContainEqual({
      name: "failed",
      status: "failed",
      startedAt: "2026-07-06T01:00:00.000Z",
      completedAt: null,
    });
    expect(JSON.stringify(summary)).not.toContain("stored-for-downstream");
    expect(JSON.stringify(summary)).not.toContain("token=");
  });
});
