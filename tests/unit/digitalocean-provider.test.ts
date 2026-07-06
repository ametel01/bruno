import { describe, expect, it } from "vitest";
import {
  DigitalOceanApiProvider,
  DIGITALOCEAN_PROVIDER,
  FakeDigitalOceanProvider,
  type DigitalOceanSdkClient,
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

describe("DigitalOcean API provider", () => {
  it("creates, tags, firewalls, and cleans up resources through safe SDK requests", async () => {
    const calls: Array<{ step: string; body?: unknown; id?: number; tag?: string }> = [];
    const client: DigitalOceanSdkClient = {
      v2: {
        droplets: {
          post: async (body) => {
            calls.push({ step: "droplets.post", body });

            return {
              droplet: {
                id: 123456,
                name: body.name ?? "agentbay-cloud-runner",
                region: { slug: "sfo3" },
                sizeSlug: "s-1vcpu-512mb-10gb",
                image: { slug: "ubuntu-24-04-x64" },
                tags: ["agentbay"],
                createdAt: new Date("2026-07-06T05:00:01.000Z"),
              },
            };
          },
          byDroplet_id: (id) => ({
            delete: async () => {
              calls.push({ step: "droplets.delete", id });
            },
          }),
        },
        firewalls: {
          post: async (body) => {
            calls.push({ step: "firewalls.post", body });

            return { firewall: { id: "firewall-1" } };
          },
        },
        tags: {
          byTag_id: (tag) => ({
            resources: {
              post: async (body) => {
                calls.push({ step: "tags.resources.post", tag, body });
              },
            },
          }),
        },
      },
    };
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      client,
      now: () => new Date("2026-07-06T05:00:00.000Z"),
    });

    const created = await provider.createRunner({
      name: "AgentBay Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "agentbay-runner"],
      firewallName: "agentbay-runners",
    });

    expect(created).toMatchObject({
      ok: true,
      value: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: "123456",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        firewallApplied: false,
      },
    });

    if (!created.ok) {
      throw new Error("Expected API provider create to succeed.");
    }

    const tagged = await provider.tagResource({
      providerResourceId: created.value.providerResourceId,
      tags: ["agentbay-runner"],
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
      value: { tags: ["agentbay", "agentbay-runner"] },
    });
    expect(firewalled).toMatchObject({
      ok: true,
      value: { firewallApplied: true },
    });
    expect(cleaned).toMatchObject({
      ok: true,
      value: { deletedAt: "2026-07-06T05:00:00.000Z" },
    });
    expect(calls.map((call) => call.step)).toEqual([
      "droplets.post",
      "tags.resources.post",
      "firewalls.post",
      "droplets.delete",
    ]);
    expect(calls[0]?.body).toMatchObject({
      name: "agentbay-cloud-runner",
      region: "sfo3",
      size: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "agentbay-runner"],
      monitoring: true,
    });
    expect(calls[1]).toMatchObject({
      tag: "agentbay-runner",
      body: {
        resources: [{ resourceId: "123456", resourceType: "droplet" }],
      },
    });
    expect(calls[2]?.body).toMatchObject({
      name: "agentbay-runners",
      dropletIds: [123456],
      inboundRules: [
        { protocol: "tcp", ports: "22" },
        { protocol: "tcp", ports: "80" },
        { protocol: "tcp", ports: "443" },
      ],
      outboundRules: [
        { protocol: "tcp", ports: "all" },
        { protocol: "udp", ports: "all" },
        { protocol: "icmp" },
      ],
    });
    expect(calls[3]).toMatchObject({ id: 123456 });
    expect(JSON.stringify([created, tagged, firewalled, cleaned])).not.toContain(
      "dop_v1_super_secret",
    );
  });

  it("returns safe API failures without echoing provider credentials", async () => {
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      client: {
        v2: {
          droplets: {
            post: async () => {
              throw Object.assign(new Error("token dop_v1_super_secret is forbidden"), {
                statusCode: 403,
              });
            },
            byDroplet_id: () => ({ delete: async () => {} }),
          },
          firewalls: { post: async () => ({ firewall: { id: "firewall-1" } }) },
          tags: {
            byTag_id: () => ({
              resources: { post: async () => {} },
            }),
          },
        },
      },
    });

    const result = await provider.createRunner({
      name: "AgentBay Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay"],
    });

    expect(result).toEqual({
      ok: false,
      reason: "create_failed",
      message: "DigitalOcean API request failed with status 403.",
    });
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });
});
