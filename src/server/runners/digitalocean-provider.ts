import "server-only";

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
  name: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  firewallApplied: boolean;
  createdAt: string;
  deletedAt: string | null;
};

export type DigitalOceanProviderErrorReason =
  | "create_failed"
  | "tag_failed"
  | "firewall_failed"
  | "cleanup_failed"
  | "resource_not_found";

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
};

export type DigitalOceanCleanupInput = {
  providerResourceId: string;
};

export interface DigitalOceanProvider {
  createRunner(
    input: DigitalOceanRunnerSpec,
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
};

export type DigitalOceanApiProviderOptions = {
  token: string;
  fetch?: typeof fetch;
  apiBaseUrl?: string;
  now?: () => Date;
};

type DigitalOceanApiDroplet = {
  id?: number | string;
  name?: string;
  region?: { slug?: string } | string;
  size_slug?: string;
  image?: { slug?: string } | string;
  tags?: string[];
  created_at?: string;
};

export class DigitalOceanApiProvider implements DigitalOceanProvider {
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #apiBaseUrl: string;
  readonly #now: () => Date;
  readonly #resources = new Map<string, DigitalOceanResource>();

  constructor(options: DigitalOceanApiProviderOptions) {
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
    this.#apiBaseUrl = options.apiBaseUrl ?? "https://api.digitalocean.com/v2";
    this.#now = options.now ?? (() => new Date());
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const body: Record<string, unknown> = {
      name: input.name,
      region: input.region,
      size: input.sizeSlug,
      image: input.image,
      tags: [...new Set(input.tags)].sort(),
      monitoring: true,
    };

    if (input.sshKeyIds && input.sshKeyIds.length > 0) {
      body.ssh_keys = input.sshKeyIds;
    }

    if (input.userData) {
      body.user_data = input.userData;
    }

    const response = await this.#request<{ droplet?: DigitalOceanApiDroplet }>(
      "/droplets",
      "POST",
      body,
      "create_failed",
    );

    if (!response.ok) {
      return response;
    }

    const resource = apiDropletToResource(response.value.droplet, input, this.#now);

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
      const response = await this.#request<unknown>(
        `/tags/${encodeURIComponent(tag)}/resources`,
        "POST",
        {
          resources: [{ resource_id: input.providerResourceId, resource_type: "droplet" }],
        },
        "tag_failed",
      );

      if (!response.ok) {
        return response;
      }
    }

    resource.tags = [...new Set([...resource.tags, ...input.tags])].sort();

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

    const response = await this.#request<unknown>(
      "/firewalls",
      "POST",
      {
        name: input.firewallName,
        droplet_ids: [dropletId],
        inbound_rules: [tcpInboundRule("22"), tcpInboundRule("80"), tcpInboundRule("443")],
        outbound_rules: [
          {
            protocol: "tcp",
            ports: "all",
            destinations: { addresses: ["0.0.0.0/0", "::/0"] },
          },
          {
            protocol: "udp",
            ports: "all",
            destinations: { addresses: ["0.0.0.0/0", "::/0"] },
          },
          {
            protocol: "icmp",
            destinations: { addresses: ["0.0.0.0/0", "::/0"] },
          },
        ],
      },
      "firewall_failed",
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

    const response = await this.#request<unknown>(
      `/droplets/${encodeURIComponent(input.providerResourceId)}`,
      "DELETE",
      undefined,
      "cleanup_failed",
    );

    if (!response.ok) {
      return response;
    }

    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }

  async #request<T>(
    path: string,
    method: "DELETE" | "GET" | "POST",
    body: unknown,
    reason: DigitalOceanProviderErrorReason,
  ): Promise<DigitalOceanProviderResult<T>> {
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
        },
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const response = await this.#fetch(`${this.#apiBaseUrl}${path}`, init);

      if (!response.ok) {
        return {
          ok: false,
          reason,
          message: `DigitalOcean API request failed with status ${response.status}.`,
        };
      }

      if (response.status === 204) {
        return { ok: true, value: undefined as T };
      }

      return { ok: true, value: (await response.json()) as T };
    } catch {
      return {
        ok: false,
        reason,
        message: "DigitalOcean API request failed.",
      };
    }
  }
}

export class FakeDigitalOceanProvider implements DigitalOceanProvider {
  readonly resources = new Map<string, DigitalOceanResource>();
  readonly calls: Array<
    | { step: "create"; input: DigitalOceanRunnerSpec }
    | { step: "tag"; input: DigitalOceanTagInput }
    | { step: "firewall"; input: DigitalOceanFirewallInput }
    | { step: "cleanup"; input: DigitalOceanCleanupInput }
  > = [];

  #counter = 0;
  readonly #fail: Partial<Record<FakeProviderStep, string>>;
  readonly #now: () => Date;
  readonly #idPrefix: string;

  constructor(options: FakeDigitalOceanProviderOptions = {}) {
    this.#fail = options.fail ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "do-fake";
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

function apiDropletToResource(
  droplet: DigitalOceanApiDroplet | undefined,
  fallback: DigitalOceanRunnerSpec,
  now: () => Date,
): DigitalOceanResource | null {
  if (!droplet?.id) {
    return null;
  }

  return {
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: String(droplet.id),
    name: droplet.name ?? fallback.name,
    region: readApiSlug(droplet.region) ?? fallback.region,
    sizeSlug: droplet.size_slug ?? fallback.sizeSlug,
    image: readApiSlug(droplet.image) ?? fallback.image,
    tags: [...new Set(droplet.tags ?? fallback.tags)].sort(),
    firewallApplied: false,
    createdAt: droplet.created_at ?? now().toISOString(),
    deletedAt: null,
  };
}

function readApiSlug(value: { slug?: string } | string | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  return value?.slug ?? null;
}

function tcpInboundRule(port: string) {
  return {
    protocol: "tcp",
    ports: port,
    sources: { addresses: ["0.0.0.0/0", "::/0"] },
  };
}

function cloneResource(resource: DigitalOceanResource): DigitalOceanResource {
  return {
    ...resource,
    tags: [...resource.tags],
  };
}
