import "server-only";

import { createDigitalOceanSdkClient } from "@/src/server/runners/digitalocean-sdk-runtime";

export const DIGITALOCEAN_PROVIDER = "digitalocean";
export const DIGITALOCEAN_RUNNER_KIND = "digitalocean";

export type DigitalOceanProviderName = typeof DIGITALOCEAN_PROVIDER;
export type DigitalOceanRunnerKind = typeof DIGITALOCEAN_RUNNER_KIND;

export type DigitalOceanProvisioningStatus =
  | "pending"
  | "creating"
  | "tagging"
  | "firewall_configuring"
  | "bootstrapping"
  | "waiting_for_runner"
  | "ready"
  | "failed"
  | "cleaning_up"
  | "deleted";

export type DigitalOceanRunnerSpec = {
  name: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  firewallName?: string;
  sshKeyIds?: string[];
  userData?: string;
};

export type DigitalOceanResource = {
  provider: DigitalOceanProviderName;
  providerResourceId: string;
  publicIpv4: string | null;
  name: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  firewallApplied: boolean;
  createdAt: string;
  deletedAt: string | null;
};

export type DigitalOceanSshKey = {
  id: string;
  name: string | null;
  fingerprint: string | null;
};

export type DigitalOceanProviderErrorReason =
  | "create_failed"
  | "tag_failed"
  | "firewall_failed"
  | "cleanup_failed"
  | "resource_not_found"
  | "ssh_key_lookup_failed"
  | "ssh_key_create_failed";

export type DigitalOceanProviderResult<T> =
  | {
      ok: true;
      value: T;
    }
  | {
      ok: false;
      reason: DigitalOceanProviderErrorReason;
      message: string;
    };

export type DigitalOceanTagInput = {
  providerResourceId: string;
  tags: string[];
};

export type DigitalOceanFirewallInput = {
  providerResourceId: string;
  firewallName: string;
  sshSourceAddresses?: string[];
};

export type DigitalOceanCleanupInput = {
  providerResourceId: string;
};

export type DigitalOceanReadInput = {
  providerResourceId: string;
};

export type DigitalOceanCreateSshKeyInput = {
  name: string;
  publicKey: string;
};

export interface DigitalOceanProvider {
  listSshKeys(): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>>;
  createSshKey(
    input: DigitalOceanCreateSshKeyInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>>;
  createRunner(
    input: DigitalOceanRunnerSpec,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  readResource(
    input: DigitalOceanReadInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  tagResource(
    input: DigitalOceanTagInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  applyFirewall(
    input: DigitalOceanFirewallInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  cleanupResource(
    input: DigitalOceanCleanupInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
}

type FakeProviderStep = "create" | "tag" | "firewall" | "cleanup";

export type FakeDigitalOceanProviderOptions = {
  fail?: Partial<Record<FakeProviderStep, string>>;
  now?: () => Date;
  idPrefix?: string;
  publicIpv4?: string | null;
  sshKeys?: DigitalOceanSshKey[];
};

export type DigitalOceanApiProviderOptions = {
  token: string;
  client?: DigitalOceanSdkClient;
  apiBaseUrl?: string;
  now?: () => Date;
};

export type DigitalOceanSdkClient = {
  v2: {
    droplets: {
      post(
        body: DigitalOceanDropletCreateBody,
      ): Promise<DigitalOceanDropletCreateResponse | undefined>;
      byDroplet_id(id: number): {
        get?(): Promise<DigitalOceanDropletCreateResponse | undefined>;
        delete(): Promise<void>;
      };
    };
    account: {
      keys: {
        get(): Promise<DigitalOceanSshKeysResponse | undefined>;
        post(
          body: DigitalOceanSshKeyCreateBody,
        ): Promise<DigitalOceanSshKeyCreateResponse | undefined>;
      };
    };
    firewalls: {
      post(body: DigitalOceanFirewallBody): Promise<DigitalOceanFirewallCreateResponse | undefined>;
    };
    tags: {
      byTag_id(tag: string): {
        resources: {
          post(body: DigitalOceanTagResourceBody): Promise<void>;
        };
      };
    };
  };
};

type DigitalOceanDropletCreateBody = {
  name?: string | null;
  region?: string | null;
  size?: string | null;
  image?: number | string | null;
  tags?: string[] | null;
  monitoring?: boolean | null;
  sshKeys?: string[] | null;
  userData?: string | null;
};

type DigitalOceanDropletCreateResponse = {
  droplet?: DigitalOceanApiDroplet | null;
};

type DigitalOceanSshKeysResponse = {
  sshKeys?: DigitalOceanApiSshKey[] | null;
  ssh_keys?: DigitalOceanApiSshKey[] | null;
};

type DigitalOceanSshKeyCreateBody = {
  name?: string | null;
  publicKey?: string | null;
  public_key?: string | null;
};

type DigitalOceanSshKeyCreateResponse = {
  sshKey?: DigitalOceanApiSshKey | null;
  ssh_key?: DigitalOceanApiSshKey | null;
};

type DigitalOceanApiSshKey = {
  id?: number | string | null;
  name?: string | null;
  fingerprint?: string | null;
};

type DigitalOceanFirewallCreateResponse = {
  firewall?: { id?: string | null } | null;
};

type DigitalOceanApiDroplet = {
  id?: number | string | null;
  name?: string | null;
  region?: { slug?: string | null } | string | null;
  sizeSlug?: string | null;
  size_slug?: string | null;
  image?: { slug?: string | null } | string | null;
  networks?: {
    v4?: Array<{
      ipAddress?: string | null;
      ip_address?: string | null;
      type?: string | null;
    }> | null;
  } | null;
  tags?: string[] | null;
  createdAt?: Date | string | null;
  created_at?: Date | string | null;
};

type DigitalOceanFirewallBody = {
  name?: string | null;
  dropletIds?: number[] | null;
  inboundRules?: DigitalOceanFirewallInboundRule[] | null;
  outboundRules?: DigitalOceanFirewallOutboundRule[] | null;
};

type DigitalOceanFirewallInboundRule = {
  protocol?: "icmp" | "tcp" | "udp" | null;
  ports?: string | null;
  sources?: { addresses?: string[] | null } | null;
};

type DigitalOceanFirewallOutboundRule = {
  protocol?: "icmp" | "tcp" | "udp" | null;
  ports?: string | null;
  destinations?: { addresses?: string[] | null } | null;
};

type DigitalOceanTagResourceBody = {
  resources?: Array<{ resourceId?: string | null; resourceType?: string | null }> | null;
};

export class DigitalOceanApiProvider implements DigitalOceanProvider {
  readonly #client: DigitalOceanSdkClient;
  readonly #now: () => Date;
  readonly #resources = new Map<string, DigitalOceanResource>();

  constructor(options: DigitalOceanApiProviderOptions) {
    this.#client = options.client ?? createDigitalOceanSdkClient(options.token, options.apiBaseUrl);
    this.#now = options.now ?? (() => new Date());
  }

  async listSshKeys(): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    const response = await runSdkStep("ssh_key_lookup_failed", () =>
      this.#client.v2.account.keys.get(),
    );

    if (!response.ok) {
      return response;
    }

    return {
      ok: true,
      value: (response.value?.sshKeys ?? response.value?.ssh_keys ?? []).flatMap((key) => {
        const id = key.id === undefined || key.id === null ? "" : String(key.id).trim();

        return id
          ? [
              {
                id,
                name: key.name?.trim() || null,
                fingerprint: key.fingerprint?.trim() || null,
              },
            ]
          : [];
      }),
    };
  }

  async createSshKey(
    input: DigitalOceanCreateSshKeyInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    const response = await runSdkStep("ssh_key_create_failed", () =>
      this.#client.v2.account.keys.post({
        name: input.name,
        publicKey: input.publicKey,
      }),
    );

    if (!response.ok) {
      return response;
    }

    const sshKey = apiSshKeyToSshKey(response.value?.sshKey ?? response.value?.ssh_key);

    return sshKey
      ? { ok: true, value: sshKey }
      : {
          ok: false,
          reason: "ssh_key_create_failed",
          message: "DigitalOcean SSH key creation response was missing required fields.",
        };
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const body: DigitalOceanDropletCreateBody = {
      name: toDropletName(input.name),
      region: input.region,
      size: input.sizeSlug,
      image: input.image,
      tags: [...new Set(input.tags)].sort(),
      monitoring: true,
    };

    if (input.sshKeyIds && input.sshKeyIds.length > 0) {
      body.sshKeys = input.sshKeyIds;
    }

    if (input.userData) {
      body.userData = input.userData;
    }

    const response = await runSdkStep("create_failed", () => this.#client.v2.droplets.post(body));

    if (!response.ok) {
      return response;
    }

    const resource = apiDropletToResource(response.value?.droplet, input, this.#now);

    if (!resource) {
      return {
        ok: false,
        reason: "create_failed",
        message: "DigitalOcean Droplet response was missing required fields.",
      };
    }

    this.#resources.set(resource.providerResourceId, resource);

    return { ok: true, value: cloneResource(resource) };
  }

  async tagResource(
    input: DigitalOceanTagInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    for (const tag of [...new Set(input.tags)].sort()) {
      const response = await runSdkStep("tag_failed", () =>
        this.#client.v2.tags.byTag_id(tag).resources.post({
          resources: [{ resourceId: input.providerResourceId, resourceType: "droplet" }],
        }),
      );

      if (!response.ok) {
        return response;
      }
    }

    resource.tags = [...new Set([...resource.tags, ...input.tags])].sort();

    return { ok: true, value: cloneResource(resource) };
  }

  async readResource(
    input: DigitalOceanReadInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const dropletId = Number(input.providerResourceId);

    if (!Number.isSafeInteger(dropletId)) {
      return missingResource();
    }

    const dropletResource = this.#client.v2.droplets.byDroplet_id(dropletId);

    if (!dropletResource.get) {
      const cached = this.#resources.get(input.providerResourceId);

      return cached ? { ok: true, value: cloneResource(cached) } : missingResource();
    }

    const response = await runSdkStep("resource_not_found", () => {
      if (!dropletResource.get) {
        throw new Error("DigitalOcean Droplet read is unavailable.");
      }

      return dropletResource.get();
    });

    if (!response.ok) {
      return response;
    }

    const fallback = this.#resources.get(input.providerResourceId);
    const resource = apiDropletToResource(
      response.value?.droplet,
      fallback
        ? {
            name: fallback.name,
            region: fallback.region,
            sizeSlug: fallback.sizeSlug,
            image: fallback.image,
            tags: fallback.tags,
          }
        : null,
      this.#now,
    );

    if (!resource) {
      return missingResource();
    }

    this.#resources.set(resource.providerResourceId, resource);

    return { ok: true, value: cloneResource(resource) };
  }

  async applyFirewall(
    input: DigitalOceanFirewallInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    const dropletId = Number(input.providerResourceId);

    if (!Number.isSafeInteger(dropletId)) {
      return {
        ok: false,
        reason: "firewall_failed",
        message: "DigitalOcean Droplet ID was not usable for firewall attachment.",
      };
    }

    const response = await runSdkStep("firewall_failed", () =>
      this.#client.v2.firewalls.post({
        name: input.firewallName,
        dropletIds: [dropletId],
        inboundRules: [
          ...sshInboundRules(input.sshSourceAddresses),
          tcpInboundRule("80"),
          tcpInboundRule("443"),
        ],
        outboundRules: [outboundRule("tcp"), outboundRule("udp"), outboundRule("icmp")],
      }),
    );

    if (!response.ok) {
      return response;
    }

    resource.firewallApplied = true;

    return { ok: true, value: cloneResource(resource) };
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    const response = await runSdkStep("cleanup_failed", () =>
      this.#client.v2.droplets.byDroplet_id(Number(input.providerResourceId)).delete(),
    );

    if (!response.ok) {
      return response;
    }

    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }
}

export class FakeDigitalOceanProvider implements DigitalOceanProvider {
  readonly resources = new Map<string, DigitalOceanResource>();
  readonly calls: Array<
    | { step: "createSshKey"; input: DigitalOceanCreateSshKeyInput }
    | { step: "create"; input: DigitalOceanRunnerSpec }
    | { step: "tag"; input: DigitalOceanTagInput }
    | { step: "firewall"; input: DigitalOceanFirewallInput }
    | { step: "cleanup"; input: DigitalOceanCleanupInput }
  > = [];

  #counter = 0;
  readonly #fail: Partial<Record<FakeProviderStep, string>>;
  readonly #now: () => Date;
  readonly #idPrefix: string;
  readonly #publicIpv4: string | null;
  readonly #sshKeys: DigitalOceanSshKey[];

  constructor(options: FakeDigitalOceanProviderOptions = {}) {
    this.#fail = options.fail ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "do-fake";
    this.#publicIpv4 = options.publicIpv4 === undefined ? "203.0.113.10" : options.publicIpv4;
    this.#sshKeys = options.sshKeys ?? [
      {
        id: "52830696",
        name: "macos",
        fingerprint: "c3:2a:31:47:ef:86:aa:72:41:b4:33:c1:a2:36:1f:a8",
      },
    ];
  }

  async listSshKeys(): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    return {
      ok: true,
      value: this.#sshKeys.map((key) => ({ ...key })),
    };
  }

  async createSshKey(
    input: DigitalOceanCreateSshKeyInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    this.calls.push({ step: "createSshKey", input });

    const id = `ssh-key-${this.#sshKeys.length + 1}`;
    const created = {
      id,
      name: input.name,
      fingerprint: `agentbay-managed-${id}`,
    };

    this.#sshKeys.push(created);

    return { ok: true, value: { ...created } };
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    this.calls.push({ step: "create", input });

    const failure = this.#failure("create", "create_failed");

    if (failure) {
      return failure;
    }

    this.#counter += 1;

    const resource: DigitalOceanResource = {
      provider: DIGITALOCEAN_PROVIDER,
      providerResourceId: `${this.#idPrefix}-${this.#counter}`,
      publicIpv4: this.#publicIpv4,
      name: input.name,
      region: input.region,
      sizeSlug: input.sizeSlug,
      image: input.image,
      tags: [...new Set(input.tags)].sort(),
      firewallApplied: false,
      createdAt: this.#now().toISOString(),
      deletedAt: null,
    };

    this.resources.set(resource.providerResourceId, resource);

    return { ok: true, value: cloneResource(resource) };
  }

  async readResource(
    input: DigitalOceanReadInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    return { ok: true, value: cloneResource(resource) };
  }

  async tagResource(
    input: DigitalOceanTagInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    this.calls.push({ step: "tag", input });

    const failure = this.#failure("tag", "tag_failed");

    if (failure) {
      return failure;
    }

    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    resource.tags = [...new Set([...resource.tags, ...input.tags])].sort();

    return { ok: true, value: cloneResource(resource) };
  }

  async applyFirewall(
    input: DigitalOceanFirewallInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    this.calls.push({ step: "firewall", input });

    const failure = this.#failure("firewall", "firewall_failed");

    if (failure) {
      return failure;
    }

    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    resource.firewallApplied = true;

    return { ok: true, value: cloneResource(resource) };
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    this.calls.push({ step: "cleanup", input });

    const failure = this.#failure("cleanup", "cleanup_failed");

    if (failure) {
      return failure;
    }

    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }

  #failure(
    step: FakeProviderStep,
    reason: DigitalOceanProviderErrorReason,
  ): DigitalOceanProviderResult<DigitalOceanResource> | null {
    const message = this.#fail[step];

    return message ? { ok: false, reason, message } : null;
  }
}

function missingResource(): DigitalOceanProviderResult<DigitalOceanResource> {
  return {
    ok: false,
    reason: "resource_not_found",
    message: "DigitalOcean resource was not found.",
  };
}

function apiSshKeyToSshKey(
  key: DigitalOceanApiSshKey | null | undefined,
): DigitalOceanSshKey | null {
  const id = key?.id === undefined || key.id === null ? "" : String(key.id).trim();

  return id
    ? {
        id,
        name: key?.name?.trim() || null,
        fingerprint: key?.fingerprint?.trim() || null,
      }
    : null;
}

function apiDropletToResource(
  droplet: DigitalOceanApiDroplet | null | undefined,
  fallback: Pick<DigitalOceanRunnerSpec, "image" | "name" | "region" | "sizeSlug" | "tags"> | null,
  now: () => Date,
): DigitalOceanResource | null {
  if (!droplet?.id) {
    return null;
  }

  return {
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: String(droplet.id),
    publicIpv4: readApiPublicIpv4(droplet),
    name: droplet.name ?? fallback?.name ?? "agentbay-runner",
    region: readApiSlug(droplet.region) ?? fallback?.region ?? "unknown",
    sizeSlug: droplet.sizeSlug ?? droplet.size_slug ?? fallback?.sizeSlug ?? "unknown",
    image: readApiSlug(droplet.image) ?? fallback?.image ?? "unknown",
    tags: [...new Set(droplet.tags ?? fallback?.tags ?? [])].sort(),
    firewallApplied: false,
    createdAt: readApiDate(droplet.createdAt ?? droplet.created_at) ?? now().toISOString(),
    deletedAt: null,
  };
}

async function runSdkStep<T>(
  reason: DigitalOceanProviderErrorReason,
  execute: () => Promise<T>,
): Promise<DigitalOceanProviderResult<T>> {
  try {
    return { ok: true, value: await execute() };
  } catch (error) {
    return {
      ok: false,
      reason,
      message: `DigitalOcean API request failed${readSdkStatusSuffix(error)}.`,
    };
  }
}

function readSdkStatusSuffix(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const statusCode = "statusCode" in error ? error.statusCode : null;
  const responseStatus = "responseStatusCode" in error ? error.responseStatusCode : null;
  const status = typeof statusCode === "number" ? statusCode : responseStatus;

  return typeof status === "number" ? ` with status ${status}` : "";
}

function readApiSlug(value: { slug?: string | null } | string | null | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  return value?.slug ?? null;
}

function readApiDate(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value ?? null;
}

function readApiPublicIpv4(droplet: DigitalOceanApiDroplet): string | null {
  const publicNetwork = droplet.networks?.v4?.find(
    (network) =>
      network.type === "public" &&
      (typeof network.ipAddress === "string" || typeof network.ip_address === "string"),
  );
  const ipAddress = (publicNetwork?.ipAddress ?? publicNetwork?.ip_address)?.trim() ?? "";

  return isPublicIpv4(ipAddress) ? ipAddress : null;
}

function isPublicIpv4(value: string): boolean {
  const parts = value.split(".");

  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const value = Number(part);

    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function sshInboundRules(addresses: string[] | undefined): DigitalOceanFirewallInboundRule[] {
  const sourceAddresses = normalizeFirewallAddresses(addresses);

  return sourceAddresses.length > 0 ? [tcpInboundRule("22", sourceAddresses)] : [];
}

function tcpInboundRule(
  port: string,
  addresses: string[] = ["0.0.0.0/0", "::/0"],
): DigitalOceanFirewallInboundRule {
  return {
    protocol: "tcp",
    ports: port,
    sources: { addresses },
  };
}

function normalizeFirewallAddresses(addresses: string[] | undefined): string[] {
  return [...new Set((addresses ?? []).map((address) => address.trim()).filter(Boolean))].sort();
}

function outboundRule(protocol: "icmp" | "tcp" | "udp"): DigitalOceanFirewallOutboundRule {
  return {
    protocol,
    ...(protocol === "icmp" ? {} : { ports: "all" }),
    destinations: { addresses: ["0.0.0.0/0", "::/0"] },
  };
}

function toDropletName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 63)
    .replace(/-+$/g, "");

  return normalized || "agentbay-runner";
}

function cloneResource(resource: DigitalOceanResource): DigitalOceanResource {
  return {
    ...resource,
    tags: [...resource.tags],
  };
}
