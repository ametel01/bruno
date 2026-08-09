import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  DIGITALOCEAN_PROVIDER,
  DigitalOceanApiProvider,
  type DigitalOceanSdkClient,
  FakeDigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";

describe("fake DigitalOcean provider", () => {
  it("returns authoritative managed inventory with stable tags and timestamps", async () => {
    const provider = new FakeDigitalOceanProvider({
      now: () => new Date("2026-08-04T12:00:00.000Z"),
      idPrefix: "inventory",
    });
    await provider.createRunner({
      name: "managed-runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno-runner", "bruno-deploy-88888888888888888888888888888888"],
    });
    await provider.createRunner({
      name: "unmanaged-runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["unmanaged"],
    });

    await expect(
      provider.listManagedResources({ stableTag: "bruno-runner" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        authoritative: true,
        resources: [
          {
            providerResourceId: "inventory-1",
            tags: ["bruno-deploy-88888888888888888888888888888888", "bruno-runner"],
            createdAt: "2026-08-04T12:00:00.000Z",
            deletedAt: null,
          },
        ],
      },
    });
  });

  it("creates, tags, firewalls, and cleans up resources without network calls", async () => {
    const provider = new FakeDigitalOceanProvider({
      now: () => new Date("2026-07-06T02:00:00.000Z"),
      idPrefix: "droplet",
    });

    const created = await provider.createRunner({
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno", "runner", "bruno"],
      firewallName: "bruno-runners",
    });

    expect(created).toEqual({
      ok: true,
      value: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: "droplet-1",
        providerFirewallId: null,
        providerFirewallName: null,
        publicIpv4: "203.0.113.10",
        name: "Bruno Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        tags: ["bruno", "runner"],
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
      firewallName: "bruno-runners",
      sshSourceAddresses: ["203.0.113.5/32"],
    });
    const cleaned = await provider.cleanupResource({
      providerResourceId: created.value.providerResourceId,
    });

    expect(tagged).toMatchObject({
      ok: true,
      value: { tags: ["bruno", "cloud", "runner"] },
    });
    expect(firewalled).toMatchObject({
      ok: true,
      value: { firewallApplied: true, providerFirewallId: "droplet-firewall-1" },
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
        name: "Bruno Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-1gb",
        image: "ubuntu-24-04-x64",
        tags: ["bruno"],
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
        tags: ["bruno"],
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "resource_not_found",
      message: "DigitalOcean resource was not found.",
    });
  });

  it("models exact owned-set observation and ordered cleanup", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "7654321" });
    const created = await provider.createRunner({
      name: "bruno-staging-operation",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["operation-unique-tag"],
    });
    if (!created.ok) throw new Error("Expected fake provider creation to succeed.");

    const firewalled = await provider.applyFirewall({
      providerResourceId: created.value.providerResourceId,
      firewallName: "bruno-runners-7654321-1",
    });
    if (!firewalled.ok || !firewalled.value.providerFirewallId) {
      throw new Error("Expected fake firewall creation to succeed.");
    }

    const ownedSet = {
      operationTag: "operation-unique-tag",
      providerResourceId: created.value.providerResourceId,
      providerFirewallId: firewalled.value.providerFirewallId,
      expectedName: "bruno-staging-operation",
      expectedRegion: "sfo3",
      expectedSizeSlug: "s-1vcpu-512mb-10gb",
      expectedFirewallName: "bruno-runners-7654321-1",
    };

    await expect(provider.observeOwnedSet(ownedSet)).resolves.toMatchObject({
      ok: true,
      value: { state: "owned", droplet: "present", firewall: "present" },
    });
    await expect(provider.deleteFirewall(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
    await expect(provider.deleteDroplet(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
    await expect(provider.observeOwnedSet(ownedSet)).resolves.toMatchObject({
      ok: true,
      value: { state: "absent" },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "observeOwnedSet",
      "deleteFirewall",
      "observeOwnedSet",
      "observeOwnedSet",
      "deleteDroplet",
      "observeOwnedSet",
      "observeOwnedSet",
      "observeOwnedSet",
    ]);
  });

  it("fails owned-set cleanup closed when an operation tag identifies multiple Droplets", async () => {
    const provider = new FakeDigitalOceanProvider({ idPrefix: "duplicate" });
    const spec = {
      name: "bruno-staging-operation",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["operation-unique-tag"],
    };
    const first = await provider.createRunner(spec);
    await provider.createRunner(spec);
    if (!first.ok) throw new Error("Expected fake provider creation to succeed.");
    const firewalled = await provider.applyFirewall({
      providerResourceId: first.value.providerResourceId,
      firewallName: "bruno-runners-duplicate-1",
    });
    if (!firewalled.ok || !firewalled.value.providerFirewallId) {
      throw new Error("Expected fake firewall creation to succeed.");
    }

    const result = await provider.deleteFirewall({
      operationTag: "operation-unique-tag",
      providerResourceId: first.value.providerResourceId,
      providerFirewallId: firewalled.value.providerFirewallId,
      expectedName: spec.name,
      expectedRegion: spec.region,
      expectedSizeSlug: spec.sizeSlug,
      expectedFirewallName: "bruno-runners-duplicate-1",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "ownership_ambiguous",
      retryable: false,
    });
    expect(provider.firewalls.has(firewalled.value.providerFirewallId)).toBe(true);
  });
});

describe("DigitalOcean API provider", () => {
  it("refuses to construct a network client in test processes", () => {
    expect(() => new DigitalOceanApiProvider({ token: "unused" })).toThrow(
      "DigitalOcean network access is disabled in test processes.",
    );
  });

  it("pins snapshot-builder SSH host identity with strict known-host checking", async () => {
    const source = await readFile("src/server/runners/digitalocean-provider.ts", "utf8");

    expect(source).toContain("ssh-keyscan");
    expect(source).toContain("known_hosts");
    expect(source).toContain("expectedHostKeySha256");
    expect(source).toContain("StrictHostKeyChecking=yes");
    expect(source).toContain("UserKnownHostsFile=");
    expect(source).toContain("cloud-init status --wait");
    expect(source).toContain("/root/.ssh/authorized_keys");
    expect(source).toContain("/var/lib/cloud");
    expect(source).not.toContain("StrictHostKeyChecking=accept-new");
  });

  it("verifies snapshot image absence with a post-delete provider read", async () => {
    let imagePresent = true;
    const client = {
      v2: {
        images: {
          byImage_id: () => ({
            get: async () => {
              if (!imagePresent) {
                throw Object.assign(new Error("not found"), { statusCode: 404 });
              }
              return { image: { id: 9102, name: "snapshot", status: "available" } };
            },
            delete: async () => {
              imagePresent = false;
            },
          }),
        },
      },
    } as unknown as DigitalOceanSdkClient;
    const provider = new DigitalOceanApiProvider({ token: "unused", client });

    await expect(provider.verifyImageAbsent({ imageId: "9102" })).resolves.toMatchObject({
      ok: false,
      reason: "cleanup_failed",
    });
    await expect(provider.deleteImage({ imageId: "9102" })).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });
    await expect(provider.verifyImageAbsent({ imageId: "9102" })).resolves.toEqual({
      ok: true,
      value: { absent: true },
    });
  });

  it("verifies an SSH key is absent by its exact provider ID", async () => {
    let keyPresent = true;
    const client = {
      v2: {
        account: {
          keys: {
            bySsh_key_id: () => ({
              get: async () => {
                if (!keyPresent) {
                  throw Object.assign(new Error("not found"), { statusCode: 404 });
                }
                return { ssh_key: { id: 52830700, name: "builder" } };
              },
              delete: async () => {
                keyPresent = false;
              },
            }),
          },
        },
      },
    } as unknown as DigitalOceanSdkClient;
    const provider = new DigitalOceanApiProvider({ token: "unused", client });

    await expect(provider.verifySshKeyAbsent({ id: "52830700" })).resolves.toMatchObject({
      ok: false,
      reason: "cleanup_failed",
    });
    await expect(provider.deleteSshKey({ id: "52830700" })).resolves.toEqual({
      ok: true,
      value: { deleted: true },
    });
    await expect(provider.verifySshKeyAbsent({ id: "52830700" })).resolves.toEqual({
      ok: true,
      value: { absent: true },
    });
  });

  it("joins complete firewall inventory onto authoritative managed Droplets", async () => {
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      client: {
        v2: {
          droplets: {
            get: async () => ({
              droplets: [
                {
                  id: 123456,
                  name: "bruno-deploy-88888888888888888888888888888888",
                  region: { slug: "sfo3" },
                  sizeSlug: "s-1vcpu-1gb",
                  image: { slug: "ubuntu-24-04-x64" },
                  tags: ["bruno-runner", "bruno-deploy-88888888888888888888888888888888"],
                  createdAt: "2026-08-04T12:00:00.000Z",
                },
              ],
              meta: { total: 1 },
            }),
            post: async () => ({ droplet: null }),
            byDroplet_id: () => ({ delete: async () => {} }),
          },
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
          },
          firewalls: {
            get: async () => ({
              firewalls: [
                { id: "firewall-123", name: "bruno-runners-123456", dropletIds: [123456] },
              ],
              meta: { total: 1 },
            }),
            post: async () => ({ firewall: null }),
          },
          tags: {
            byTag_id: () => ({ resources: { post: async () => {} } }),
          },
        },
      },
    });

    await expect(
      provider.listManagedResources({ stableTag: "bruno-runner" }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        authoritative: true,
        resources: [
          {
            providerResourceId: "123456",
            providerFirewallId: "firewall-123",
            firewallApplied: true,
            createdAt: "2026-08-04T12:00:00.000Z",
          },
        ],
      },
    });
  });

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
                name: body.name ?? "bruno-cloud-runner",
                region: { slug: "sfo3" },
                sizeSlug: "s-1vcpu-512mb-10gb",
                image: { slug: "ubuntu-24-04-x64" },
                networks: {
                  v4: [
                    { ipAddress: "10.0.0.5", type: "private" },
                    { ipAddress: "203.0.113.42", type: "public" },
                  ],
                },
                tags: ["bruno"],
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
        account: {
          keys: {
            get: async () => ({
              ssh_keys: [
                {
                  id: 52830696,
                  name: "macos",
                  fingerprint: "c3:2a:31:47:ef:86:aa:72:41:b4:33:c1:a2:36:1f:a8",
                },
              ],
            }),
            post: async () => ({
              ssh_key: {
                id: 52830700,
                name: "bruno managed runner key",
                fingerprint: "b4:78:1a:93:8c:33:49:15:a1:44:a9:dc:b2:4f:30:cc",
              },
            }),
          },
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
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno", "bruno-runner"],
      firewallName: "bruno-runners",
      sshKeyIds: ["52830696"],
    });

    expect(created).toMatchObject({
      ok: true,
      value: {
        provider: DIGITALOCEAN_PROVIDER,
        providerResourceId: "123456",
        publicIpv4: "203.0.113.42",
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
      tags: ["bruno-runner"],
    });
    const firewalled = await provider.applyFirewall({
      providerResourceId: created.value.providerResourceId,
      firewallName: "bruno-runners",
      sshSourceAddresses: ["203.0.113.5/32"],
    });
    const cleaned = await provider.cleanupResource({
      providerResourceId: created.value.providerResourceId,
    });

    expect(tagged).toMatchObject({
      ok: true,
      value: { tags: ["bruno", "bruno-runner"] },
    });
    expect(firewalled).toMatchObject({
      ok: true,
      value: { firewallApplied: true, providerFirewallId: "firewall-1" },
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
      name: "bruno-cloud-runner",
      region: "sfo3",
      size: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno", "bruno-runner"],
      monitoring: true,
      sshKeys: ["52830696"],
    });
    expect(calls[1]).toMatchObject({
      tag: "bruno-runner",
      body: {
        resources: [{ resourceId: "123456", resourceType: "droplet" }],
      },
    });
    expect(calls[2]?.body).toMatchObject({
      name: "bruno-runners",
      dropletIds: [123456],
      inboundRules: [
        { protocol: "tcp", ports: "22", sources: { addresses: ["203.0.113.5/32"] } },
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

  it("creates SSH keys through raw DigitalOcean API fields", async () => {
    const calls: Array<{ step: string; body?: unknown }> = [];
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      client: {
        v2: {
          droplets: {
            post: async () => ({ droplet: null }),
            byDroplet_id: () => ({ delete: async () => {} }),
          },
          account: {
            keys: {
              get: async () => ({ ssh_keys: [] }),
              post: async (body) => {
                calls.push({ step: "account.keys.post", body });

                return {
                  ssh_key: {
                    id: 52830700,
                    name: "bruno managed runner key",
                    fingerprint: "b4:78:1a:93:8c:33:49:15:a1:44:a9:dc:b2:4f:30:cc",
                  },
                };
              },
            },
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

    const result = await provider.createSshKey({
      name: "bruno managed runner key",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey bruno-managed-runner",
    });

    expect(result).toEqual({
      ok: true,
      value: {
        id: "52830700",
        name: "bruno managed runner key",
        fingerprint: "b4:78:1a:93:8c:33:49:15:a1:44:a9:dc:b2:4f:30:cc",
      },
    });
    expect(calls).toEqual([
      {
        step: "account.keys.post",
        body: {
          name: "bruno managed runner key",
          publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKey bruno-managed-runner",
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("resumes exact tag and firewall phases after the creating process is gone", async () => {
    const calls: string[] = [];
    const client: DigitalOceanSdkClient = {
      v2: {
        droplets: {
          post: async () => ({ droplet: null }),
          byDroplet_id: () => ({
            get: async () => {
              calls.push("droplet.get");
              return {
                droplet: {
                  id: 123456,
                  name: "bruno-deploy-operation",
                  region: { slug: "sfo3" },
                  size_slug: "s-1vcpu-512mb-10gb",
                  image: { slug: "ubuntu-24-04-x64" },
                  tags: ["bruno-deploy-operation"],
                },
              };
            },
            delete: async () => {},
          }),
        },
        account: {
          keys: {
            get: async () => ({ sshKeys: [] }),
            post: async () => ({ sshKey: null }),
          },
        },
        firewalls: {
          post: async () => {
            calls.push("firewall.post");
            return { firewall: { id: "durable-firewall-id" } };
          },
        },
        tags: {
          byTag_id: () => ({
            resources: {
              post: async () => {
                calls.push("tag.post");
              },
            },
          }),
        },
      },
    };

    const taggingProcess = new DigitalOceanApiProvider({ token: "unused", client });
    await expect(
      taggingProcess.tagResource({
        providerResourceId: "123456",
        tags: ["bruno-deploy-operation"],
      }),
    ).resolves.toMatchObject({ ok: true, value: { providerResourceId: "123456" } });

    const firewallProcess = new DigitalOceanApiProvider({ token: "unused", client });
    await expect(
      firewallProcess.applyFirewall({
        providerResourceId: "123456",
        firewallName: "bruno-runners-123456",
      }),
    ).resolves.toMatchObject({
      ok: true,
      value: {
        providerResourceId: "123456",
        providerFirewallId: "durable-firewall-id",
      },
    });

    expect(calls).toEqual(["droplet.get", "tag.post", "droplet.get", "firewall.post"]);
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
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
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
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-1gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
    });

    expect(result).toEqual({
      ok: false,
      reason: "create_failed",
      message: "DigitalOcean API request failed with status 403.",
    });
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
  });

  it("fails closed when firewall creation does not return a durable firewall ID", async () => {
    const provider = new DigitalOceanApiProvider({
      token: "unused",
      client: {
        v2: {
          droplets: {
            post: async () => ({
              droplet: {
                id: 123456,
                name: "bruno-runner",
                region: "sfo3",
                size_slug: "s-1vcpu-512mb-10gb",
                image: "ubuntu-24-04-x64",
                tags: ["bruno"],
              },
            }),
            byDroplet_id: () => ({ delete: async () => {} }),
          },
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
          },
          firewalls: { post: async () => ({ firewall: { id: " " } }) },
          tags: { byTag_id: () => ({ resources: { post: async () => {} } }) },
        },
      },
    });
    const created = await provider.createRunner({
      name: "bruno-runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
    });
    if (!created.ok) throw new Error("Expected Droplet creation to succeed.");

    await expect(
      provider.applyFirewall({
        providerResourceId: created.value.providerResourceId,
        firewallName: "bruno-runners-123456",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "firewall_failed",
      message: "DigitalOcean firewall response was missing required fields.",
    });
  });

  it("reads a Droplet public IPv4 from raw DigitalOcean API fields through the SDK GET API", async () => {
    const calls: Array<{ step: string; id?: number }> = [];
    const provider = new DigitalOceanApiProvider({
      token: "dop_v1_super_secret",
      client: {
        v2: {
          droplets: {
            post: async () => ({
              droplet: {
                id: 456789,
                name: "bruno-cloud-runner",
                region: { slug: "sfo3" },
                size_slug: "s-1vcpu-512mb-10gb",
                image: { slug: "ubuntu-24-04-x64" },
                networks: { v4: [] },
                tags: ["bruno"],
                created_at: "2026-07-06T08:00:00.000Z",
              },
            }),
            byDroplet_id: (id) => ({
              get: async () => {
                calls.push({ step: "droplets.get", id });

                return {
                  droplet: {
                    id,
                    name: "bruno-cloud-runner",
                    region: { slug: "sfo3" },
                    size_slug: "s-1vcpu-512mb-10gb",
                    image: { slug: "ubuntu-24-04-x64" },
                    networks: {
                      v4: [
                        { ip_address: "10.0.0.5", type: "private" },
                        { ip_address: "203.0.113.88", type: "public" },
                      ],
                    },
                    tags: ["bruno"],
                    created_at: "2026-07-06T08:00:00.000Z",
                  },
                };
              },
              delete: async () => {},
            }),
          },
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
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

    const created = await provider.createRunner({
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
    });

    if (!created.ok) {
      throw new Error("Expected API provider create to succeed.");
    }

    const refreshed = await provider.readResource({
      providerResourceId: created.value.providerResourceId,
    });

    expect(refreshed).toMatchObject({
      ok: true,
      value: {
        providerResourceId: "456789",
        publicIpv4: "203.0.113.88",
        sizeSlug: "s-1vcpu-512mb-10gb",
        createdAt: "2026-07-06T08:00:00.000Z",
      },
    });
    expect(calls).toEqual([{ step: "droplets.get", id: 456789 }]);
  });

  it("attests and deletes an exact owned firewall before its Droplet without process-local cache", async () => {
    const calls: string[] = [];
    let dropletPresent = true;
    let firewallPresent = true;
    const notFound = () => Object.assign(new Error("not found"), { statusCode: 404 });
    const client: DigitalOceanSdkClient = {
      v2: {
        droplets: {
          post: async () => ({ droplet: null }),
          get: async () => ({
            droplets: dropletPresent
              ? [
                  {
                    id: 7654321,
                    name: "bruno-staging-operation",
                    region: { slug: "sfo3" },
                    size_slug: "s-1vcpu-512mb-10gb",
                    tags: ["bruno", "operation-unique-tag"],
                  },
                ]
              : [],
          }),
          byDroplet_id: () => ({
            get: async () => {
              calls.push("droplet.get");
              if (!dropletPresent) throw notFound();
              return {
                droplet: {
                  id: 7654321,
                  name: "bruno-staging-operation",
                  region: { slug: "sfo3" },
                  size_slug: "s-1vcpu-512mb-10gb",
                  tags: ["bruno", "operation-unique-tag"],
                },
              };
            },
            delete: async () => {
              calls.push("droplet.delete");
              dropletPresent = false;
            },
          }),
        },
        account: {
          keys: {
            get: async () => ({ sshKeys: [] }),
            post: async () => ({ sshKey: null }),
          },
        },
        firewalls: {
          post: async () => ({ firewall: null }),
          byFirewall_id: () => ({
            get: async () => {
              calls.push("firewall.get");
              if (!firewallPresent) throw notFound();
              return {
                firewall: {
                  id: "owned-firewall",
                  name: "bruno-runners-7654321",
                  droplet_ids: [7654321],
                },
              };
            },
            delete: async () => {
              calls.push("firewall.delete");
              firewallPresent = false;
              throw Object.assign(new Error("response lost after delete"), { statusCode: 503 });
            },
          }),
        },
        tags: {
          byTag_id: () => ({ resources: { post: async () => {} } }),
        },
      },
    };
    const provider = new DigitalOceanApiProvider({ token: "unused", client });
    const ownedSet = {
      operationTag: "operation-unique-tag",
      providerResourceId: "7654321",
      providerFirewallId: "owned-firewall",
      expectedName: "bruno-staging-operation",
      expectedRegion: "sfo3",
      expectedSizeSlug: "s-1vcpu-512mb-10gb",
      expectedFirewallName: "bruno-runners-7654321",
    };

    await expect(provider.observeOwnedSet(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "owned", droplet: "present", firewall: "present" },
    });
    await expect(provider.deleteDroplet(ownedSet)).resolves.toMatchObject({
      ok: false,
      reason: "cleanup_order_violation",
      retryable: true,
    });
    await expect(provider.deleteFirewall(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
    await expect(provider.deleteDroplet(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "absent" },
    });
    await expect(provider.observeOwnedSet(ownedSet)).resolves.toEqual({
      ok: true,
      value: { state: "absent", droplet: "absent", firewall: "absent" },
    });

    expect(calls.filter((call) => call.endsWith(".delete"))).toEqual([
      "firewall.delete",
      "droplet.delete",
    ]);
  });

  it("never deletes when exact ownership or firewall attachment is ambiguous", async () => {
    const deleteCalls: string[] = [];
    const provider = new DigitalOceanApiProvider({
      token: "unused",
      client: {
        v2: {
          droplets: {
            post: async () => ({ droplet: null }),
            get: async () => ({
              droplets: [
                {
                  id: 7654321,
                  name: "unexpected-name",
                  region: { slug: "sfo3" },
                  size_slug: "s-1vcpu-512mb-10gb",
                  tags: ["operation-unique-tag"],
                },
              ],
            }),
            byDroplet_id: () => ({
              get: async () => ({
                droplet: {
                  id: 7654321,
                  name: "unexpected-name",
                  region: { slug: "sfo3" },
                  size_slug: "s-1vcpu-512mb-10gb",
                  tags: ["operation-unique-tag"],
                },
              }),
              delete: async () => {
                deleteCalls.push("droplet");
              },
            }),
          },
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
          },
          firewalls: {
            post: async () => ({ firewall: null }),
            byFirewall_id: () => ({
              get: async () => ({
                firewall: {
                  id: "owned-firewall",
                  name: "bruno-runners-7654321",
                  droplet_ids: [7654321, 9999999],
                },
              }),
              delete: async () => {
                deleteCalls.push("firewall");
              },
            }),
          },
          tags: { byTag_id: () => ({ resources: { post: async () => {} } }) },
        },
      },
    });
    const ownedSet = {
      operationTag: "operation-unique-tag",
      providerResourceId: "7654321",
      providerFirewallId: "owned-firewall",
      expectedName: "bruno-staging-operation",
      expectedRegion: "sfo3",
      expectedSizeSlug: "s-1vcpu-512mb-10gb",
      expectedFirewallName: "bruno-runners-7654321",
    };

    await expect(provider.deleteFirewall(ownedSet)).resolves.toEqual({
      ok: false,
      reason: "ownership_ambiguous",
      retryable: false,
      message: "DigitalOcean resource ownership was ambiguous; no deletion was attempted.",
    });
    await expect(provider.deleteDroplet(ownedSet)).resolves.toMatchObject({
      ok: false,
      reason: "ownership_ambiguous",
    });
    expect(deleteCalls).toEqual([]);
  });

  it("reports an unknown delete outcome as retryable when absence cannot be verified", async () => {
    let firewallReads = 0;
    const provider = new DigitalOceanApiProvider({
      token: "unused",
      client: {
        v2: {
          droplets: {
            post: async () => ({ droplet: null }),
            get: async () => ({
              droplets: [
                {
                  id: 7654321,
                  name: "bruno-staging-operation",
                  region: "sfo3",
                  size_slug: "s-1vcpu-512mb-10gb",
                  tags: ["operation-unique-tag"],
                },
              ],
            }),
            byDroplet_id: () => ({
              get: async () => ({
                droplet: {
                  id: 7654321,
                  name: "bruno-staging-operation",
                  region: "sfo3",
                  size_slug: "s-1vcpu-512mb-10gb",
                  tags: ["operation-unique-tag"],
                },
              }),
              delete: async () => {},
            }),
          },
          account: {
            keys: {
              get: async () => ({ sshKeys: [] }),
              post: async () => ({ sshKey: null }),
            },
          },
          firewalls: {
            post: async () => ({ firewall: null }),
            byFirewall_id: () => ({
              get: async () => {
                firewallReads += 1;
                if (firewallReads > 1)
                  throw Object.assign(new Error("timeout"), { statusCode: 503 });
                return {
                  firewall: {
                    id: "owned-firewall",
                    name: "bruno-runners-7654321",
                    dropletIds: [7654321],
                  },
                };
              },
              delete: async () => {
                throw Object.assign(new Error("timeout"), { statusCode: 503 });
              },
            }),
          },
          tags: { byTag_id: () => ({ resources: { post: async () => {} } }) },
        },
      },
    });

    await expect(
      provider.deleteFirewall({
        operationTag: "operation-unique-tag",
        providerResourceId: "7654321",
        providerFirewallId: "owned-firewall",
        expectedName: "bruno-staging-operation",
        expectedRegion: "sfo3",
        expectedSizeSlug: "s-1vcpu-512mb-10gb",
        expectedFirewallName: "bruno-runners-7654321",
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "delete_outcome_unknown",
      retryable: true,
      message: "DigitalOcean deletion outcome could not be confirmed; retry observation.",
    });
  });
});
