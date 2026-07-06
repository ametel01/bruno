import { describe, expect, it } from "vitest";
import {
  DigitalOceanApiProvider,
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

describe("DigitalOcean API provider", () => {
  it("creates, tags, firewalls, and cleans up resources through safe API requests", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      apiBaseUrl: "https://api.example.test/v2",
      now: () => new Date("2026-07-06T05:00:00.000Z"),
      fetch: async (url, init = {}) => {
        calls.push({ url: String(url), init });

        if (String(url).endsWith("/droplets") && init.method === "POST") {
          return Response.json(
            {
              droplet: {
                id: 123456,
                name: "AgentBay Cloud Runner",
                region: { slug: "sfo3" },
                size_slug: "s-1vcpu-1gb",
                image: { slug: "ubuntu-24-04-x64" },
                tags: ["agentbay"],
                created_at: "2026-07-06T05:00:01.000Z",
              },
            },
            { status: 202 },
          );
        }

        if (
          String(url).includes("/tags/") ||
          String(url).endsWith("/firewalls") ||
          String(url).endsWith("/droplets/123456")
        ) {
          return new Response(null, { status: 204 });
        }

        return Response.json({ message: "not found" }, { status: 404 });
      },
    });

    const created = await provider.createRunner({
      name: "AgentBay Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
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
        sizeSlug: "s-1vcpu-1gb",
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
    expect(calls.map((call) => [call.url, call.init.method])).toEqual([
      ["https://api.example.test/v2/droplets", "POST"],
      ["https://api.example.test/v2/tags/agentbay-runner/resources", "POST"],
      ["https://api.example.test/v2/firewalls", "POST"],
      ["https://api.example.test/v2/droplets/123456", "DELETE"],
    ]);
    expect(
      calls.every(
        (call) => readHeader(call.init.headers, "Authorization") === "Bearer dop_v1_super_secret",
      ),
    ).toBe(true);
    expect(JSON.stringify([created, tagged, firewalled, cleaned])).not.toContain(
      "dop_v1_super_secret",
    );
  });

  it("returns safe API failures without echoing provider credentials", async () => {
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      fetch: async () =>
        Response.json(
          {
            id: "forbidden",
            message: "token dop_v1_super_secret is forbidden",
          },
          { status: 403 },
        ),
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

function readHeader(headers: HeadersInit | undefined, name: string): string | null {
  if (!headers) {
    return null;
  }

  return new Headers(headers).get(name);
}
