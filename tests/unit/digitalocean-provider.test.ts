import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_PROVIDER,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";

describe("fake DigitalOcean provider", () => {
  it("creates, tags, firewalls, and cleans up resources without network calls", async () => {
    const provider = new FakeDigitalOceanProvider({
      now: () => new Date("2026-07-06T02:00:00.000Z"),
      idPrefix: "droplet",
    });

    const created = await provider.createRunner({
      name: "AgentBay Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "runner", "agentbay"],
      firewallName: "agentbay-runners",
    });

    expect(created).toEqual({
      ok: true,
      value: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: "droplet-1",
        name: "AgentBay Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        tags: ["agentbay", "runner"],
        firewallApplied: false,
        createdAt: "2026-07-06T02:00:00.000Z",
        deletedAt: null,
      },
    });

    if (!created.ok) {
      throw new Error("Expected fake DigitalOcean resource creation to succeed.");
    }

    const tagged = await provider.tagResource({
      providerResourceId: created.value.providerResourceId,
      tags: ["cloud", "runner"],
    });
    const firewalled = await provider.applyFirewall({
      providerResourceId: created.value.providerResourceId,
      firewallName: "agentbay-runners",
    });
    const cleaned = await provider.cleanupResource({
      providerResourceId: created.value.providerResourceId,
    });

    expect(tagged).toMatchObject({
      ok: true,
      value: { tags: ["agentbay", "cloud", "runner"] },
    });
    expect(firewalled).toMatchObject({
      ok: true,
      value: { firewallApplied: true },
    });
    expect(cleaned).toMatchObject({
      ok: true,
      value: { deletedAt: "2026-07-06T02:00:00.000Z" },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "tag",
      "firewall",
      "cleanup",
    ]);
  });

  it("returns configured safe failure responses", async () => {
    const createFailure = new FakeDigitalOceanProvider({
      fail: { create: "quota exhausted" },
    });
    const cleanupFailure = new FakeDigitalOceanProvider({
      fail: { cleanup: "delete denied" },
    });

    await expect(
      createFailure.createRunner({
        name: "AgentBay Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        tags: ["agentbay"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "create_failed",
      message: "quota exhausted",
    });

    await expect(
      cleanupFailure.cleanupResource({ providerResourceId: "unknown-droplet" }),
    ).resolves.toEqual({
      ok: false,
      reason: "cleanup_failed",
      message: "delete denied",
    });

    await expect(
      new FakeDigitalOceanProvider().tagResource({
        providerResourceId: "unknown-droplet",
        tags: ["agentbay"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "resource_not_found",
      message: "DigitalOcean resource was not found.",
    });
  });
});
