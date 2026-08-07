import "server-only";

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAppLogger } from "@/src/server/logging/logger";
import { createDigitalOceanSdkClient } from "@/src/server/runners/digitalocean-sdk-runtime";

const digitalOceanProviderLogger = createAppLogger("digitalocean.provider");
const execFileAsync = promisify(execFile);

export const DIGITALOCEAN_PROVIDER = "digitalocean";
export const DIGITALOCEAN_MANAGED_RUNNER_TAG = "agentbay-runner";
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
  providerFirewallId: string | null;
  providerFirewallName?: string | null;
  publicIpv4: string | null;
  publicEndpointUrl?: string;
  name: string;
  region: string;
  sizeSlug: string;
  image: string;
  tags: string[];
  firewallApplied: boolean;
  createdAt: string | null;
  deletedAt: string | null;
};

export type DigitalOceanSshKey = {
  id: string;
  name: string | null;
  fingerprint: string | null;
};

export type DigitalOceanProviderErrorReason =
  | "create_failed"
  | "create_outcome_unknown"
  | "discovery_failed"
  | "tag_failed"
  | "firewall_failed"
  | "cleanup_failed"
  | "resource_not_found"
  | "ssh_key_lookup_failed"
  | "ssh_key_create_failed"
  | "image_lookup_failed"
  | "action_failed"
  | "action_outcome_unknown";

export type DigitalOceanActionStatus = "in-progress" | "completed" | "errored";

export type DigitalOceanAction = {
  id: string;
  status: DigitalOceanActionStatus;
  type: string;
  resourceId: string;
};

export type DigitalOceanImageAvailability = {
  id: string;
  name: string | null;
  regions: string[];
  minDiskSizeGb: number;
  architecture: "amd64" | "unknown";
  status: "available" | "pending" | "deleted" | "unknown";
};

export type DigitalOceanOwnedSetExpectation = {
  operationTag: string;
  providerResourceId: string;
  providerFirewallId: string;
  expectedName: string;
  expectedRegion: string;
  expectedSizeSlug: string;
  expectedFirewallName: string;
};

export type DigitalOceanOwnedSetObservation = {
  state: "owned" | "absent";
  droplet: "present" | "absent";
  firewall: "present" | "absent";
};

export type DigitalOceanOwnedSetFailureReason =
  | "observation_unknown"
  | "ownership_ambiguous"
  | "cleanup_order_violation"
  | "delete_outcome_unknown";

export type DigitalOceanOwnedSetResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: DigitalOceanOwnedSetFailureReason;
      retryable: boolean;
      message: string;
    };

export type DigitalOceanOwnedSetDeleteResult = {
  state: "absent";
};

export interface DigitalOceanOwnedSetProvider {
  observeOwnedSet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetObservation>>;
  deleteFirewall(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>>;
  deleteDroplet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>>;
}

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
  webSourceAddresses?: string[];
};

export type DigitalOceanCleanupInput = {
  providerResourceId: string;
};

export type DigitalOceanReadInput = {
  providerResourceId: string;
};

export type DigitalOceanReadImageInput = {
  imageId: string;
};

export type DigitalOceanFindImageByNameInput = {
  name: string;
};

export type DigitalOceanReadSnapshotBuilderEvidenceInput = {
  providerResourceId: string;
  privateKeyPath?: string;
  remoteDirectory?: string;
  expectedHostKeySha256?: string;
};

export type DigitalOceanSnapshotBuilderEvidence = {
  bootResult: unknown;
  sanitationResult: unknown;
};

export type DigitalOceanActionInput = {
  providerResourceId: string;
};

export type DigitalOceanSnapshotInput = {
  providerResourceId: string;
  name: string;
};

export type DigitalOceanDeleteImageInput = {
  imageId: string;
};

export type DigitalOceanCreateSshKeyInput = {
  name: string;
  publicKey: string;
};

export type DigitalOceanDeleteSshKeyInput = {
  id: string;
};

export type DigitalOceanDiscoverByTagInput = {
  tag: string;
};

export type DigitalOceanManagedInventoryInput = {
  stableTag: string;
};

export type DigitalOceanProviderRequestContext = {
  signal: AbortSignal;
};

export type DigitalOceanDiscovery = {
  authoritative: boolean;
  resources: DigitalOceanResource[];
};

export interface DigitalOceanProvider {
  listManagedResources?(
    input: DigitalOceanManagedInventoryInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>>;
  listSshKeys(
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>>;
  createSshKey(
    input: DigitalOceanCreateSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>>;
  deleteSshKey?(
    input: DigitalOceanDeleteSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>>;
  createRunner(
    input: DigitalOceanRunnerSpec,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  discoverResourcesByTag(
    input: DigitalOceanDiscoverByTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>>;
  readResource(
    input: DigitalOceanReadInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  tagResource(
    input: DigitalOceanTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  applyFirewall(
    input: DigitalOceanFirewallInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  cleanupResource(
    input: DigitalOceanCleanupInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>>;
  powerOffResource?(
    input: DigitalOceanActionInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>>;
  snapshotResource?(
    input: DigitalOceanSnapshotInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>>;
  readAction?(
    input: { actionId: string },
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>>;
  readImageAvailability?(
    input: DigitalOceanReadImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>>;
  findSnapshotImageByName?(
    input: DigitalOceanFindImageByNameInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>>;
  readSnapshotBuilderEvidence?(
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>>;
  deleteImage?(
    input: DigitalOceanDeleteImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>>;
}

type FakeProviderStep = "create" | "tag" | "firewall" | "cleanup" | "deleteSshKey";

export type FakeDigitalOceanProviderOptions = {
  fail?: Partial<Record<FakeProviderStep, string>>;
  now?: () => Date;
  idPrefix?: string;
  publicIpv4?: string | null;
  sshKeys?: DigitalOceanSshKey[];
  builderHostKeySha256?: string;
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
        context?: DigitalOceanProviderRequestContext,
      ): Promise<DigitalOceanDropletCreateResponse | undefined>;
      get?(
        input: {
          tagName: string;
          perPage: number;
        },
        context?: DigitalOceanProviderRequestContext,
      ): Promise<DigitalOceanDropletsListResponse | undefined>;
      byDroplet_id(id: number): {
        get?(
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanDropletCreateResponse | undefined>;
        delete(context?: DigitalOceanProviderRequestContext): Promise<void>;
        actions?: {
          post(
            body: DigitalOceanDropletActionBody,
            context?: DigitalOceanProviderRequestContext,
          ): Promise<DigitalOceanActionResponse | undefined>;
        };
      };
    };
    actions?: {
      byAction_id(id: number): {
        get(
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanActionReadResponse | undefined>;
      };
    };
    images?: {
      get?(
        input: { privateImages: boolean; perPage: number },
        context?: DigitalOceanProviderRequestContext,
      ): Promise<DigitalOceanImagesListResponse | undefined>;
      byImage_id(id: number): {
        get(
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanImageReadResponse | undefined>;
        delete(context?: DigitalOceanProviderRequestContext): Promise<void>;
      };
    };
    account: {
      keys: {
        get(
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanSshKeysResponse | undefined>;
        post(
          body: DigitalOceanSshKeyCreateBody,
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanSshKeyCreateResponse | undefined>;
        bySsh_key_id?(id: string): {
          delete(context?: DigitalOceanProviderRequestContext): Promise<void>;
        };
      };
    };
    firewalls: {
      get?(
        input: { perPage: number },
        context?: DigitalOceanProviderRequestContext,
      ): Promise<DigitalOceanFirewallsListResponse | undefined>;
      post(
        body: DigitalOceanFirewallBody,
        context?: DigitalOceanProviderRequestContext,
      ): Promise<DigitalOceanFirewallCreateResponse | undefined>;
      byFirewall_id?(id: string): {
        get(
          context?: DigitalOceanProviderRequestContext,
        ): Promise<DigitalOceanFirewallReadResponse | undefined>;
        delete(context?: DigitalOceanProviderRequestContext): Promise<void>;
      };
    };
    tags: {
      byTag_id(tag: string): {
        resources: {
          post(
            body: DigitalOceanTagResourceBody,
            context?: DigitalOceanProviderRequestContext,
          ): Promise<void>;
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

type DigitalOceanDropletActionBody = { type: "power_off" } | { type: "snapshot"; name: string };

type DigitalOceanActionResponse = {
  action?: DigitalOceanApiAction | null;
};

type DigitalOceanActionReadResponse = DigitalOceanActionResponse;

type DigitalOceanImageReadResponse = {
  image?: DigitalOceanApiImage | null;
};

type DigitalOceanImagesListResponse = {
  images?: DigitalOceanApiImage[] | null;
  links?: { pages?: { next?: string | null } | null } | null;
  meta?: { total?: number | null } | null;
};

type DigitalOceanDropletsListResponse = {
  droplets?: DigitalOceanApiDroplet[] | null;
  links?: { pages?: { next?: string | null } | null } | null;
  meta?: { total?: number | null } | null;
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
  firewall?: DigitalOceanApiFirewall | null;
};

type DigitalOceanFirewallsListResponse = {
  firewalls?: DigitalOceanApiFirewall[] | null;
  links?: { pages?: { next?: string | null } | null } | null;
  meta?: { total?: number | null } | null;
};

type DigitalOceanFirewallReadResponse = {
  firewall?: DigitalOceanApiFirewall | null;
};

type DigitalOceanApiFirewall = {
  id?: string | null;
  name?: string | null;
  dropletIds?: number[] | null;
  droplet_ids?: number[] | null;
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

type DigitalOceanApiAction = {
  id?: number | string | null;
  status?: string | null;
  type?: string | null;
  resourceId?: number | string | null;
  resource_id?: number | string | null;
};

type DigitalOceanApiImage = {
  id?: number | string | null;
  name?: string | null;
  regions?: string[] | null;
  minDiskSize?: number | null;
  min_disk_size?: number | null;
  distribution?: string | null;
  status?: string | null;
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

export class DigitalOceanApiProvider implements DigitalOceanProvider, DigitalOceanOwnedSetProvider {
  readonly #client: DigitalOceanSdkClient;
  readonly #now: () => Date;
  readonly #resources = new Map<string, DigitalOceanResource>();

  constructor(options: DigitalOceanApiProviderOptions) {
    if (process.env.NODE_ENV === "test" && options.client === undefined) {
      throw new Error("DigitalOcean network access is disabled in test processes.");
    }
    this.#client = options.client ?? createDigitalOceanSdkClient(options.token, options.apiBaseUrl);
    this.#now = options.now ?? (() => new Date());
  }

  async listSshKeys(
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    const response = await runSdkStep(
      "ssh_key_lookup_failed",
      () => this.#client.v2.account.keys.get(context),
      context,
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
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    const response = await runSdkStep(
      "ssh_key_create_failed",
      () =>
        this.#client.v2.account.keys.post(
          {
            name: input.name,
            publicKey: input.publicKey,
          },
          context,
        ),
      context,
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

  async deleteSshKey(
    input: DigitalOceanDeleteSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>> {
    const keyResource = this.#client.v2.account.keys.bySsh_key_id?.(input.id);

    if (!keyResource) {
      return {
        ok: false,
        reason: "cleanup_failed",
        message: "DigitalOcean SSH key deletion was unavailable.",
      };
    }

    const response = await runSdkStep("cleanup_failed", () => keyResource.delete(context), context);

    return response.ok ? { ok: true, value: { deleted: true } } : response;
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
    context?: DigitalOceanProviderRequestContext,
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

    const response = await runSdkStep(
      "create_failed",
      () => this.#client.v2.droplets.post(body, context),
      context,
      "create_outcome_unknown",
    );

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

  async discoverResourcesByTag(
    input: DigitalOceanDiscoverByTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    if (!this.#client.v2.droplets.get) {
      const resources = [...this.#resources.values()].filter(
        (resource) => resource.deletedAt === null && resource.tags.includes(input.tag),
      );

      return {
        ok: true,
        value: { authoritative: false, resources: resources.map(cloneResource) },
      };
    }

    const discover = this.#client.v2.droplets.get;

    const response = await runSdkStep(
      "discovery_failed",
      () => discover({ tagName: input.tag, perPage: 200 }, context),
      context,
    );

    if (!response.ok) {
      return response;
    }

    const droplets = response.value?.droplets ?? [];
    const resources = droplets.flatMap((droplet) => {
      const resource = apiDropletToResource(droplet, null, this.#now);

      if (!resource?.tags.some((tag) => tag === input.tag)) {
        return [];
      }

      this.#resources.set(resource.providerResourceId, resource);
      return [cloneResource(resource)];
    });

    const hasNextPage = Boolean(response.value?.links?.pages?.next);
    const total = response.value?.meta?.total;
    const countIsComplete = total === undefined || total === null || total <= droplets.length;
    return {
      ok: true,
      value: { authoritative: !hasNextPage && countIsComplete, resources },
    };
  }

  async listManagedResources(
    input: DigitalOceanManagedInventoryInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    const inventory = await this.discoverResourcesByTag({ tag: input.stableTag }, context);
    const listFirewalls = this.#client.v2.firewalls.get;
    if (!inventory.ok || !inventory.value.authoritative || !listFirewalls) {
      return inventory;
    }

    const response = await runSdkStep(
      "discovery_failed",
      () => listFirewalls({ perPage: 200 }, context),
      context,
    );
    if (!response.ok) return response;

    const firewalls = response.value?.firewalls ?? [];
    const hasNextPage = Boolean(response.value?.links?.pages?.next);
    const total = response.value?.meta?.total;
    const countIsComplete = total === undefined || total === null || total <= firewalls.length;
    const resources = inventory.value.resources.map((resource) => {
      const attached = firewalls.filter((firewall) =>
        (firewall.dropletIds ?? firewall.droplet_ids ?? []).some(
          (dropletId) => String(dropletId) === resource.providerResourceId,
        ),
      );
      const firewall = attached.length === 1 ? attached[0] : undefined;
      const firewallId = firewall?.id?.trim() || null;
      return {
        ...resource,
        providerFirewallId: firewallId,
        providerFirewallName: firewallId ? firewall?.name?.trim() || null : null,
        firewallApplied: Boolean(firewallId),
      };
    });
    return {
      ok: true,
      value: {
        authoritative: !hasNextPage && countIsComplete,
        resources,
      },
    };
  }

  async tagResource(
    input: DigitalOceanTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resourceResult = await this.#resolveResource(input.providerResourceId, context);

    if (!resourceResult.ok) return resourceResult;
    const resource = resourceResult.value;

    for (const tag of [...new Set(input.tags)].sort()) {
      const response = await runSdkStep(
        "tag_failed",
        () =>
          this.#client.v2.tags.byTag_id(tag).resources.post(
            {
              resources: [{ resourceId: input.providerResourceId, resourceType: "droplet" }],
            },
            context,
          ),
        context,
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
    context?: DigitalOceanProviderRequestContext,
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

    const response = await runSdkStep(
      "resource_not_found",
      () => {
        if (!dropletResource.get) {
          throw new Error("DigitalOcean Droplet read is unavailable.");
        }

        return dropletResource.get(context);
      },
      context,
    );

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
            providerFirewallId: fallback.providerFirewallId,
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
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resourceResult = await this.#resolveResource(input.providerResourceId, context);

    if (!resourceResult.ok) return resourceResult;
    const resource = resourceResult.value;

    const dropletId = Number(input.providerResourceId);

    if (!Number.isSafeInteger(dropletId)) {
      return {
        ok: false,
        reason: "firewall_failed",
        message: "DigitalOcean Droplet ID was not usable for firewall attachment.",
      };
    }

    const response = await runSdkStep(
      "firewall_failed",
      () =>
        this.#client.v2.firewalls.post(
          {
            name: input.firewallName,
            dropletIds: [dropletId],
            inboundRules: [
              ...sshInboundRules(input.sshSourceAddresses),
              ...webInboundRules(input.webSourceAddresses),
            ],
            outboundRules: [outboundRule("tcp"), outboundRule("udp"), outboundRule("icmp")],
          },
          context,
        ),
      context,
    );

    if (!response.ok) {
      return response;
    }

    const providerFirewallId = response.value?.firewall?.id?.trim() ?? "";

    if (!providerFirewallId) {
      return {
        ok: false,
        reason: "firewall_failed",
        message: "DigitalOcean firewall response was missing required fields.",
      };
    }

    resource.firewallApplied = true;
    resource.providerFirewallId = providerFirewallId;
    resource.providerFirewallName = input.firewallName;

    return { ok: true, value: cloneResource(resource) };
  }

  async observeOwnedSet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetObservation>> {
    const dropletId = parseDigitalOceanDropletId(input.providerResourceId);
    const firewallId = input.providerFirewallId.trim();

    if (!dropletId || !firewallId || !hasCompleteOwnedSetExpectation(input)) {
      return ambiguousOwnedSet();
    }

    const firewallResource = this.#client.v2.firewalls.byFirewall_id?.(firewallId);
    const dropletResource = this.#client.v2.droplets.byDroplet_id(dropletId);
    const discoverDroplets = this.#client.v2.droplets.get;

    if (!firewallResource?.get || !dropletResource.get || !discoverDroplets) {
      return unknownOwnedSetObservation();
    }

    const [droplet, firewall, discovered] = await Promise.all([
      observeSdkResource(() => {
        if (!dropletResource.get) throw new Error("DigitalOcean Droplet read is unavailable.");
        return dropletResource.get(context);
      }, context),
      observeSdkResource(() => {
        if (!firewallResource.get) throw new Error("DigitalOcean firewall read is unavailable.");
        return firewallResource.get(context);
      }, context),
      observeSdkResource(
        () => discoverDroplets({ tagName: input.operationTag, perPage: 200 }, context),
        context,
      ),
    ]);

    if (
      droplet.state === "unknown" ||
      firewall.state === "unknown" ||
      discovered.state === "unknown"
    ) {
      return unknownOwnedSetObservation();
    }

    const apiDroplet = droplet.state === "present" ? droplet.value?.droplet : null;
    const apiFirewall = firewall.state === "present" ? firewall.value?.firewall : null;
    const taggedDroplets =
      discovered.state === "present" && Array.isArray(discovered.value?.droplets)
        ? discovered.value.droplets
        : null;

    if (
      !taggedDroplets ||
      !taggedDropletsMatchOwnedSet(taggedDroplets, input, droplet.state) ||
      (droplet.state === "present" && !apiDropletMatchesOwnedSet(apiDroplet, input)) ||
      (firewall.state === "present" &&
        !apiFirewallMatchesOwnedSet(apiFirewall, input, dropletId)) ||
      (droplet.state === "absent" && firewall.state === "present")
    ) {
      return ambiguousOwnedSet();
    }

    const dropletState = droplet.state === "present" ? "present" : "absent";
    const firewallState = firewall.state === "present" ? "present" : "absent";

    return {
      ok: true,
      value: {
        state: dropletState === "absent" && firewallState === "absent" ? "absent" : "owned",
        droplet: dropletState,
        firewall: firewallState,
      },
    };
  }

  async deleteFirewall(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>> {
    const observed = await this.observeOwnedSet(input, context);

    if (!observed.ok) return observed;
    if (observed.value.firewall === "absent") return ownedSetDeleted();

    const firewallResource = this.#client.v2.firewalls.byFirewall_id?.(
      input.providerFirewallId.trim(),
    );

    if (!firewallResource) return unknownOwnedSetDelete();

    try {
      await firewallResource.delete(context);
    } catch {
      // The provider may have completed the deletion before the response failed. The
      // authoritative follow-up observation below decides the outcome.
    }

    const verified = await this.observeOwnedSet(input, context);

    return verified.ok && verified.value.firewall === "absent"
      ? ownedSetDeleted()
      : unknownOwnedSetDelete();
  }

  async deleteDroplet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>> {
    const observed = await this.observeOwnedSet(input, context);

    if (!observed.ok) return observed;
    if (observed.value.firewall === "present") {
      return {
        ok: false,
        reason: "cleanup_order_violation",
        retryable: true,
        message: "DigitalOcean firewall absence must be confirmed before Droplet deletion.",
      };
    }
    if (observed.value.droplet === "absent") return ownedSetDeleted();

    const dropletId = parseDigitalOceanDropletId(input.providerResourceId);

    if (!dropletId) return ambiguousOwnedSet();

    try {
      await this.#client.v2.droplets.byDroplet_id(dropletId).delete(context);
    } catch {
      // A timeout after the provider accepted deletion is resolved by the independent read.
    }

    const verified = await this.observeOwnedSet(input, context);

    return verified.ok && verified.value.state === "absent"
      ? ownedSetDeleted()
      : unknownOwnedSetDelete();
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const resource = this.#resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    const response = await runSdkStep(
      "cleanup_failed",
      () => this.#client.v2.droplets.byDroplet_id(Number(input.providerResourceId)).delete(context),
      context,
    );

    if (!response.ok) {
      return response;
    }

    resource.deletedAt = this.#now().toISOString();

    return { ok: true, value: cloneResource(resource) };
  }

  async powerOffResource(
    input: DigitalOceanActionInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    return await this.#runDropletAction(input.providerResourceId, { type: "power_off" }, context);
  }

  async snapshotResource(
    input: DigitalOceanSnapshotInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    return await this.#runDropletAction(
      input.providerResourceId,
      { type: "snapshot", name: input.name },
      context,
    );
  }

  async readAction(
    input: { actionId: string },
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    const actionId = Number(input.actionId);

    const actionsClient = this.#client.v2.actions;

    if (!Number.isSafeInteger(actionId) || !actionsClient) {
      return {
        ok: false,
        reason: "action_failed",
        message: "DigitalOcean action lookup was unavailable.",
      };
    }

    const response = await runSdkStep(
      "action_failed",
      () => actionsClient.byAction_id(actionId).get(context),
      context,
      "action_outcome_unknown",
    );

    if (!response.ok) return response;
    const action = apiActionToAction(response.value?.action);

    return action
      ? { ok: true, value: action }
      : { ok: false, reason: "action_failed", message: "DigitalOcean action response invalid." };
  }

  async readImageAvailability(
    input: DigitalOceanReadImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>> {
    const imageId = Number(input.imageId);

    const imagesClient = this.#client.v2.images;

    if (!Number.isSafeInteger(imageId) || !imagesClient) {
      return {
        ok: false,
        reason: "image_lookup_failed",
        message: "DigitalOcean image lookup was unavailable.",
      };
    }

    const response = await runSdkStep(
      "image_lookup_failed",
      () => imagesClient.byImage_id(imageId).get(context),
      context,
    );

    if (!response.ok) return response;
    const image = apiImageToImageAvailability(response.value?.image);

    return image
      ? { ok: true, value: image }
      : { ok: false, reason: "image_lookup_failed", message: "DigitalOcean image invalid." };
  }

  async findSnapshotImageByName(
    input: DigitalOceanFindImageByNameInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>> {
    const imagesClient = this.#client.v2.images;
    const listImages = imagesClient?.get;

    if (!listImages || !input.name.trim()) {
      return {
        ok: false,
        reason: "image_lookup_failed",
        message: "DigitalOcean image lookup was unavailable.",
      };
    }

    const response = await runSdkStep(
      "image_lookup_failed",
      () => listImages({ privateImages: true, perPage: 200 }, context),
      context,
    );

    if (!response.ok) return response;

    const images = (response.value?.images ?? [])
      .flatMap((image) => {
        const availability = apiImageToImageAvailability(image);
        return availability ? [availability] : [];
      })
      .filter((image) => image.name === input.name);

    return images.length === 1
      ? { ok: true, value: images[0] as DigitalOceanImageAvailability }
      : {
          ok: false,
          reason: "image_lookup_failed",
          message: "DigitalOcean snapshot image lookup did not return exactly one owned image.",
        };
  }

  async readSnapshotBuilderEvidence(
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>> {
    const resource = await this.readResource(
      { providerResourceId: input.providerResourceId },
      context,
    );

    if (!resource.ok) return resource;
    if (!resource.value.publicIpv4 || !input.privateKeyPath) {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "Snapshot builder evidence retrieval prerequisites were unavailable.",
      };
    }

    const remoteDirectory = input.remoteDirectory ?? "/run/agentbay-snapshot-builder";
    const tempKnownHosts = await mkdtemp(join(tmpdir(), "agentbay-snapshot-known-hosts-"));

    try {
      const knownHostsPath = join(tempKnownHosts, "known_hosts");
      const pinnedHostKey = await pinSnapshotBuilderHostKey({
        host: resource.value.publicIpv4,
        knownHostsPath,
        ...(input.expectedHostKeySha256 === undefined
          ? {}
          : { expectedHostKeySha256: input.expectedHostKeySha256 }),
        ...(context === undefined ? {} : { context }),
      });

      if (!pinnedHostKey.ok) {
        return pinnedHostKey;
      }

      const command = [
        "set -euo pipefail",
        `cat ${shellPath(`${remoteDirectory}/boot-result.json`)}`,
        "printf '\\nAGENTBAY_SNAPSHOT_EVIDENCE_SEPARATOR\\n'",
        `cat ${shellPath(`${remoteDirectory}/sanitation-result.json`)}`,
      ].join("; ");
      const { stdout } = await execFileAsync(
        "ssh",
        [
          "-i",
          input.privateKeyPath,
          "-o",
          "BatchMode=yes",
          "-o",
          "IdentitiesOnly=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          `UserKnownHostsFile=${knownHostsPath}`,
          `root@${resource.value.publicIpv4}`,
          command,
        ],
        {
          encoding: "utf8",
          maxBuffer: 128 * 1024,
          signal: context?.signal,
          timeout: 120_000,
        },
      );
      const [bootResult, sanitationResult] = stdout.split(
        "\nAGENTBAY_SNAPSHOT_EVIDENCE_SEPARATOR\n",
      );

      if (!bootResult?.trim() || !sanitationResult?.trim()) {
        return {
          ok: false,
          reason: "resource_not_found",
          message: "Snapshot builder evidence was incomplete.",
        };
      }

      return {
        ok: true,
        value: {
          bootResult: JSON.parse(bootResult),
          sanitationResult: JSON.parse(sanitationResult),
        },
      };
    } catch {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "Snapshot builder evidence could not be retrieved.",
      };
    } finally {
      await rm(tempKnownHosts, { recursive: true, force: true });
    }
  }

  async deleteImage(
    input: DigitalOceanDeleteImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>> {
    const imageId = Number(input.imageId);

    const imagesClient = this.#client.v2.images;

    if (!Number.isSafeInteger(imageId) || !imagesClient) {
      return {
        ok: false,
        reason: "cleanup_failed",
        message: "DigitalOcean image deletion was unavailable.",
      };
    }

    const response = await runSdkStep(
      "cleanup_failed",
      () => imagesClient.byImage_id(imageId).delete(context),
      context,
    );

    return response.ok ? { ok: true, value: { deleted: true } } : response;
  }

  async #runDropletAction(
    providerResourceId: string,
    body: DigitalOceanDropletActionBody,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    const dropletId = Number(providerResourceId);

    if (!Number.isSafeInteger(dropletId)) {
      return {
        ok: false,
        reason: "action_failed",
        message: "DigitalOcean Droplet ID was not usable for action creation.",
      };
    }

    const dropletClient = this.#client.v2.droplets.byDroplet_id(dropletId);

    const dropletActions = dropletClient.actions;

    if (!dropletActions) {
      return {
        ok: false,
        reason: "action_failed",
        message: "DigitalOcean Droplet action creation was unavailable.",
      };
    }

    const response = await runSdkStep(
      "action_failed",
      () => dropletActions.post(body, context),
      context,
      "action_outcome_unknown",
    );

    if (!response.ok) return response;
    const action = apiActionToAction(response.value?.action);

    return action
      ? { ok: true, value: action }
      : { ok: false, reason: "action_failed", message: "DigitalOcean action response invalid." };
  }

  async #resolveResource(
    providerResourceId: string,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const cached = this.#resources.get(providerResourceId);
    if (cached) return { ok: true, value: cached };

    const read = await this.readResource({ providerResourceId }, context);
    if (!read.ok) return read;

    return {
      ok: true,
      value: this.#resources.get(providerResourceId) ?? read.value,
    };
  }
}

async function pinSnapshotBuilderHostKey(input: {
  host: string;
  knownHostsPath: string;
  expectedHostKeySha256?: string;
  context?: DigitalOceanProviderRequestContext;
}): Promise<DigitalOceanProviderResult<{ fingerprint: string }>> {
  if (
    input.expectedHostKeySha256 !== undefined &&
    !isSha256SshFingerprint(input.expectedHostKeySha256)
  ) {
    return {
      ok: false,
      reason: "resource_not_found",
      message: "Snapshot builder host-key fingerprint was invalid.",
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "ssh-keyscan",
      ["-T", "15", "-t", "ed25519", input.host],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024,
        signal: input.context?.signal,
        timeout: 20_000,
      },
    );
    const line = stdout
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value && !value.startsWith("#") && value.includes("ssh-ed25519"));
    const fingerprint = line ? sshHostKeySha256Fingerprint(line) : null;

    if (!line || !fingerprint) {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "Snapshot builder host key was unavailable.",
      };
    }

    if (input.expectedHostKeySha256 && fingerprint !== input.expectedHostKeySha256) {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "Snapshot builder host key did not match the expected identity.",
      };
    }

    await writeFile(input.knownHostsPath, `${line}\n`, { mode: 0o600 });

    return { ok: true, value: { fingerprint } };
  } catch {
    return {
      ok: false,
      reason: "resource_not_found",
      message: "Snapshot builder host key could not be pinned.",
    };
  }
}

export class FakeDigitalOceanProvider
  implements DigitalOceanProvider, DigitalOceanOwnedSetProvider
{
  readonly resources = new Map<string, DigitalOceanResource>();
  readonly firewalls = new Map<string, { name: string; providerResourceId: string }>();
  readonly calls: Array<
    | { step: "createSshKey"; input: DigitalOceanCreateSshKeyInput }
    | { step: "deleteSshKey"; input: DigitalOceanDeleteSshKeyInput }
    | { step: "create"; input: DigitalOceanRunnerSpec }
    | { step: "tag"; input: DigitalOceanTagInput }
    | { step: "firewall"; input: DigitalOceanFirewallInput }
    | { step: "cleanup"; input: DigitalOceanCleanupInput }
    | { step: "discover"; input: DigitalOceanDiscoverByTagInput }
    | { step: "observeOwnedSet"; input: DigitalOceanOwnedSetExpectation }
    | { step: "deleteFirewall"; input: DigitalOceanOwnedSetExpectation }
    | { step: "deleteDroplet"; input: DigitalOceanOwnedSetExpectation }
    | { step: "powerOff"; input: DigitalOceanActionInput }
    | { step: "snapshot"; input: DigitalOceanSnapshotInput }
    | { step: "readAction"; input: { actionId: string } }
    | { step: "readBuilderEvidence"; input: DigitalOceanReadSnapshotBuilderEvidenceInput }
    | { step: "findImage"; input: DigitalOceanFindImageByNameInput }
    | { step: "readImage"; input: DigitalOceanReadImageInput }
    | { step: "deleteImage"; input: DigitalOceanDeleteImageInput }
  > = [];

  #counter = 0;
  readonly #fail: Partial<Record<FakeProviderStep, string>>;
  readonly #now: () => Date;
  readonly #idPrefix: string;
  readonly #publicIpv4: string | null;
  readonly #sshKeys: DigitalOceanSshKey[];
  readonly #builderHostKeySha256: string;
  readonly #snapshotImagesByName = new Map<string, DigitalOceanImageAvailability>();
  readonly #resourceUserData = new Map<string, string>();

  constructor(options: FakeDigitalOceanProviderOptions = {}) {
    this.#fail = options.fail ?? {};
    this.#now = options.now ?? (() => new Date());
    this.#idPrefix = options.idPrefix ?? "do-fake";
    this.#publicIpv4 = options.publicIpv4 === undefined ? "203.0.113.10" : options.publicIpv4;
    this.#builderHostKeySha256 =
      options.builderHostKeySha256 ?? "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    this.#sshKeys = options.sshKeys ?? [
      {
        id: "52830696",
        name: "macos",
        fingerprint: "c3:2a:31:47:ef:86:aa:72:41:b4:33:c1:a2:36:1f:a8",
      },
    ];
  }

  async listSshKeys(
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey[]>> {
    const aborted = abortedProviderResult<DigitalOceanSshKey[]>("ssh_key_lookup_failed", context);
    if (aborted) return aborted;
    return {
      ok: true,
      value: this.#sshKeys.map((key) => ({ ...key })),
    };
  }

  async createSshKey(
    input: DigitalOceanCreateSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSshKey>> {
    const aborted = abortedProviderResult<DigitalOceanSshKey>("ssh_key_create_failed", context);
    if (aborted) return aborted;
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

  async deleteSshKey(
    input: DigitalOceanDeleteSshKeyInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>> {
    const aborted = abortedProviderResult<{ deleted: true }>("cleanup_failed", context);
    if (aborted) return aborted;
    this.calls.push({ step: "deleteSshKey", input });
    const failure = this.#failure<{ deleted: true }>("deleteSshKey", "cleanup_failed");

    if (failure) {
      return failure;
    }

    const index = this.#sshKeys.findIndex((key) => key.id === input.id);

    if (index >= 0) {
      this.#sshKeys.splice(index, 1);
    }

    return { ok: true, value: { deleted: true } };
  }

  async createRunner(
    input: DigitalOceanRunnerSpec,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const aborted = abortedProviderResult<DigitalOceanResource>("create_outcome_unknown", context);

    if (aborted) {
      return aborted;
    }

    this.calls.push({ step: "create", input });

    const failure = this.#failure<DigitalOceanResource>("create", "create_failed");

    if (failure) {
      return failure;
    }

    this.#counter += 1;

    const resource: DigitalOceanResource = {
      provider: DIGITALOCEAN_PROVIDER,
      providerResourceId: `${this.#idPrefix}-${this.#counter}`,
      providerFirewallId: null,
      providerFirewallName: null,
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
    this.#resourceUserData.set(resource.providerResourceId, input.userData ?? "");

    return { ok: true, value: cloneResource(resource) };
  }

  async discoverResourcesByTag(
    input: DigitalOceanDiscoverByTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    const aborted = abortedProviderResult<DigitalOceanDiscovery>("discovery_failed", context);

    if (aborted) {
      return aborted;
    }

    this.calls.push({ step: "discover", input });
    const resources: DigitalOceanResource[] = [];

    for (const resource of this.resources.values()) {
      if (resource.deletedAt === null && resource.tags.includes(input.tag)) {
        resources.push(cloneResource(resource));
      }
    }

    return {
      ok: true,
      value: {
        authoritative: true,
        resources,
      },
    };
  }

  async listManagedResources(
    input: DigitalOceanManagedInventoryInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanDiscovery>> {
    const aborted = abortedProviderResult<DigitalOceanDiscovery>("discovery_failed", context);

    if (aborted) {
      return aborted;
    }

    const resources: DigitalOceanResource[] = [];

    for (const resource of this.resources.values()) {
      if (resource.deletedAt === null && resource.tags.includes(input.stableTag)) {
        resources.push(cloneResource(resource));
      }
    }

    return {
      ok: true,
      value: {
        authoritative: true,
        resources,
      },
    };
  }

  async readResource(
    input: DigitalOceanReadInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const aborted = abortedProviderResult<DigitalOceanResource>("resource_not_found", context);
    if (aborted) return aborted;
    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    return { ok: true, value: cloneResource(resource) };
  }

  async tagResource(
    input: DigitalOceanTagInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const aborted = abortedProviderResult<DigitalOceanResource>("tag_failed", context);
    if (aborted) return aborted;
    this.calls.push({ step: "tag", input });

    const failure = this.#failure<DigitalOceanResource>("tag", "tag_failed");

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
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const aborted = abortedProviderResult<DigitalOceanResource>("firewall_failed", context);
    if (aborted) return aborted;
    this.calls.push({ step: "firewall", input });

    const failure = this.#failure<DigitalOceanResource>("firewall", "firewall_failed");

    if (failure) {
      return failure;
    }

    const resource = this.resources.get(input.providerResourceId);

    if (!resource) {
      return missingResource();
    }

    resource.firewallApplied = true;
    const providerFirewallId = `${this.#idPrefix}-firewall-${this.#counter}`;
    resource.providerFirewallId = providerFirewallId;
    resource.providerFirewallName = input.firewallName;
    this.firewalls.set(providerFirewallId, {
      name: input.firewallName,
      providerResourceId: input.providerResourceId,
    });

    return { ok: true, value: cloneResource(resource) };
  }

  async observeOwnedSet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetObservation>> {
    if (context?.signal.aborted) return unknownOwnedSetObservation();
    this.calls.push({ step: "observeOwnedSet", input });
    if (!hasCompleteOwnedSetExpectation(input)) return ambiguousOwnedSet();

    const resource = this.resources.get(input.providerResourceId);
    const droplet = resource?.deletedAt === null ? resource : null;
    const firewall = this.firewalls.get(input.providerFirewallId);
    const taggedResources = [...this.resources.values()].filter(
      (candidate) => candidate.deletedAt === null && candidate.tags.includes(input.operationTag),
    );

    if (
      taggedResources.length > 1 ||
      (taggedResources.length === 1 &&
        taggedResources[0]?.providerResourceId !== input.providerResourceId) ||
      Boolean(droplet) !== (taggedResources.length === 1) ||
      (droplet &&
        (droplet.name !== input.expectedName ||
          droplet.region !== input.expectedRegion ||
          droplet.sizeSlug !== input.expectedSizeSlug ||
          !droplet.tags.includes(input.operationTag))) ||
      (firewall &&
        (firewall.name !== input.expectedFirewallName ||
          firewall.providerResourceId !== input.providerResourceId)) ||
      (!droplet && firewall)
    ) {
      return ambiguousOwnedSet();
    }

    const dropletState = droplet ? "present" : "absent";
    const firewallState = firewall ? "present" : "absent";

    return {
      ok: true,
      value: {
        state: dropletState === "absent" && firewallState === "absent" ? "absent" : "owned",
        droplet: dropletState,
        firewall: firewallState,
      },
    };
  }

  async deleteFirewall(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>> {
    this.calls.push({ step: "deleteFirewall", input });
    const observed = await this.observeOwnedSet(input, context);
    if (!observed.ok) return observed;
    if (observed.value.firewall === "absent") return ownedSetDeleted();

    this.firewalls.delete(input.providerFirewallId);
    const resource = this.resources.get(input.providerResourceId);
    if (resource) {
      resource.providerFirewallId = null;
      resource.providerFirewallName = null;
      resource.firewallApplied = false;
    }

    const verified = await this.observeOwnedSet(input, context);
    return verified.ok && verified.value.firewall === "absent"
      ? ownedSetDeleted()
      : unknownOwnedSetDelete();
  }

  async deleteDroplet(
    input: DigitalOceanOwnedSetExpectation,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult>> {
    this.calls.push({ step: "deleteDroplet", input });
    const observed = await this.observeOwnedSet(input, context);
    if (!observed.ok) return observed;
    if (observed.value.firewall === "present") {
      return {
        ok: false,
        reason: "cleanup_order_violation",
        retryable: true,
        message: "DigitalOcean firewall absence must be confirmed before Droplet deletion.",
      };
    }

    const resource = this.resources.get(input.providerResourceId);
    if (resource) resource.deletedAt = this.#now().toISOString();

    const verified = await this.observeOwnedSet(input, context);
    return verified.ok && verified.value.state === "absent"
      ? ownedSetDeleted()
      : unknownOwnedSetDelete();
  }

  async cleanupResource(
    input: DigitalOceanCleanupInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanResource>> {
    const aborted = abortedProviderResult<DigitalOceanResource>("cleanup_failed", context);
    if (aborted) return aborted;
    this.calls.push({ step: "cleanup", input });

    const failure = this.#failure<DigitalOceanResource>("cleanup", "cleanup_failed");

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

  async powerOffResource(
    input: DigitalOceanActionInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    const aborted = abortedProviderResult<DigitalOceanAction>("action_outcome_unknown", context);
    if (aborted) return aborted;
    this.calls.push({ step: "powerOff", input });
    return {
      ok: true,
      value: {
        id: `1${this.#counter}01`,
        status: "completed",
        type: "power_off",
        resourceId: input.providerResourceId,
      },
    };
  }

  async snapshotResource(
    input: DigitalOceanSnapshotInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    const aborted = abortedProviderResult<DigitalOceanAction>("action_outcome_unknown", context);
    if (aborted) return aborted;
    this.calls.push({ step: "snapshot", input });
    const imageId = `9${this.#counter}02`;
    this.#snapshotImagesByName.set(input.name, {
      id: imageId,
      name: input.name,
      regions: ["sfo3"],
      minDiskSizeGb: 25,
      architecture: "amd64",
      status: "available",
    });
    return {
      ok: true,
      value: {
        id: `8${this.#counter}02`,
        status: "completed",
        type: "snapshot",
        resourceId: input.providerResourceId,
      },
    };
  }

  async readAction(
    input: { actionId: string },
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanAction>> {
    const aborted = abortedProviderResult<DigitalOceanAction>("action_outcome_unknown", context);
    if (aborted) return aborted;
    this.calls.push({ step: "readAction", input });
    return {
      ok: true,
      value: {
        id: input.actionId,
        status: input.actionId.includes("999") ? "errored" : "completed",
        type: input.actionId.endsWith("02") ? "snapshot" : "power_off",
        resourceId: input.actionId,
      },
    };
  }

  async readImageAvailability(
    input: DigitalOceanReadImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>> {
    const aborted = abortedProviderResult<DigitalOceanImageAvailability>(
      "image_lookup_failed",
      context,
    );
    if (aborted) return aborted;
    this.calls.push({ step: "readImage", input });
    const created = [...this.#snapshotImagesByName.values()].find(
      (image) => image.id === input.imageId,
    );

    if (created) {
      return { ok: true, value: { ...created, regions: [...created.regions] } };
    }

    if (input.imageId !== "1102") {
      return {
        ok: false,
        reason: "image_lookup_failed",
        message: "DigitalOcean image was not found.",
      };
    }

    return {
      ok: true,
      value: {
        id: input.imageId,
        name: `snapshot-${input.imageId}`,
        regions: ["sfo3"],
        minDiskSizeGb: 25,
        architecture: "amd64",
        status: "available",
      },
    };
  }

  async findSnapshotImageByName(
    input: DigitalOceanFindImageByNameInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanImageAvailability>> {
    const aborted = abortedProviderResult<DigitalOceanImageAvailability>(
      "image_lookup_failed",
      context,
    );
    if (aborted) return aborted;
    this.calls.push({ step: "findImage", input });
    const image = this.#snapshotImagesByName.get(input.name);

    return image
      ? { ok: true, value: { ...image, regions: [...image.regions] } }
      : {
          ok: false,
          reason: "image_lookup_failed",
          message: "DigitalOcean snapshot image was not found.",
        };
  }

  async readSnapshotBuilderEvidence(
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>> {
    const aborted = abortedProviderResult<DigitalOceanSnapshotBuilderEvidence>(
      "resource_not_found",
      context,
    );
    if (aborted) return aborted;
    this.calls.push({ step: "readBuilderEvidence", input });
    const resource = this.resources.get(input.providerResourceId);

    if (!resource || resource.deletedAt !== null) {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "DigitalOcean resource was not found.",
      };
    }
    if (
      input.expectedHostKeySha256 !== undefined &&
      input.expectedHostKeySha256 !== this.#builderHostKeySha256
    ) {
      return {
        ok: false,
        reason: "resource_not_found",
        message: "Snapshot builder host key did not match the expected identity.",
      };
    }

    const userData = this.#resourceUserData.get(input.providerResourceId) ?? "";
    const runnerImageMatch = userData.match(/"runnerImage":\s*"([^"]+)"/);
    const defaultAgentImageMatch = userData.match(/"defaultAgentImage":\s*"([^"]+)"/);
    const hermesImageMatch = userData.match(/"hermesImage":\s*"([^"]+)"/);
    const preloadMatches = [...userData.matchAll(/"preloadedImages":\s*\[([^\]]+)\]/g)];

    return {
      ok: true,
      value: {
        bootResult: {
          ok: true,
          builderResourceId: input.providerResourceId,
          runnerImage: runnerImageMatch?.[1] ?? "",
          defaultAgentImage: defaultAgentImageMatch?.[1] ?? "",
          hermesImage: hermesImageMatch?.[1] ?? "",
          bootContractVersion: "plingpling.runner.boot.v1",
          preloadedImages:
            preloadMatches[0]?.[1]?.split(",").map((value) => value.trim().replace(/^"|"$/g, "")) ??
            [],
          completedAt: "2026-08-07T00:00:01.000Z",
        },
        sanitationResult: {
          ok: true,
          builderResourceId: input.providerResourceId,
          forbiddenPathsAbsent: true,
          hostileMarkersAbsent: true,
          removedPaths: [
            "/etc/agentbay/runner.env",
            "/root/.docker/config.json",
            "/var/lib/cloud/instances",
            "/etc/ssh/ssh_host_ed25519_key",
            "/etc/machine-id",
            "/var/log/cloud-init-output.log",
          ],
          scannedPaths: ["/etc", "/root", "/var/lib/agentbay", "/var/log"],
          hostileMarkers: [
            "AGENTBAY_RUNNER_REGISTRATION_TOKEN",
            "AGENTBAY_RUNNER_BEARER_TOKEN",
            "dop_v1_",
            "BEGIN OPENSSH PRIVATE KEY",
          ],
          completedAt: "2026-08-07T00:00:02.000Z",
        },
      },
    };
  }

  async deleteImage(
    input: DigitalOceanDeleteImageInput,
    context?: DigitalOceanProviderRequestContext,
  ): Promise<DigitalOceanProviderResult<{ deleted: true }>> {
    const aborted = abortedProviderResult<{ deleted: true }>("cleanup_failed", context);
    if (aborted) return aborted;
    this.calls.push({ step: "deleteImage", input });
    return { ok: true, value: { deleted: true } };
  }

  #failure<T>(
    step: FakeProviderStep,
    reason: DigitalOceanProviderErrorReason,
  ): DigitalOceanProviderResult<T> | null {
    const message = this.#fail[step];

    return message ? { ok: false, reason, message } : null;
  }
}

function shellPath(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function missingResource(): DigitalOceanProviderResult<DigitalOceanResource> {
  return {
    ok: false,
    reason: "resource_not_found",
    message: "DigitalOcean resource was not found.",
  };
}

function apiActionToAction(
  action: DigitalOceanApiAction | null | undefined,
): DigitalOceanAction | null {
  const id = action?.id === undefined || action.id === null ? "" : String(action.id).trim();
  const resourceId =
    action?.resourceId === undefined && action?.resource_id === undefined
      ? ""
      : String(action.resourceId ?? action.resource_id).trim();
  const status = normalizeApiActionStatus(action?.status);
  const type = action?.type?.trim() ?? "";

  return id && resourceId && status && type ? { id, status, type, resourceId } : null;
}

function apiImageToImageAvailability(
  image: DigitalOceanApiImage | null | undefined,
): DigitalOceanImageAvailability | null {
  if (!image) {
    return null;
  }

  const id = image.id === undefined || image.id === null ? "" : String(image.id).trim();
  const minDiskSizeGb = image.minDiskSize ?? image.min_disk_size;

  if (
    !id ||
    typeof minDiskSizeGb !== "number" ||
    !Number.isInteger(minDiskSizeGb) ||
    minDiskSizeGb <= 0
  ) {
    return null;
  }

  return {
    id,
    name: image.name?.trim() || null,
    regions: (image.regions ?? []).filter((region) => typeof region === "string").sort(),
    minDiskSizeGb,
    architecture: image.distribution?.toLowerCase().includes("ubuntu") ? "amd64" : "unknown",
    status: normalizeApiImageStatus(image.status),
  };
}

function normalizeApiActionStatus(
  value: string | null | undefined,
): DigitalOceanActionStatus | null {
  return value === "in-progress" || value === "completed" || value === "errored" ? value : null;
}

function normalizeApiImageStatus(
  value: string | null | undefined,
): DigitalOceanImageAvailability["status"] {
  return value === "available" || value === "pending" || value === "deleted" ? value : "unknown";
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
  fallback:
    | (Pick<DigitalOceanRunnerSpec, "image" | "name" | "region" | "sizeSlug" | "tags"> & {
        providerFirewallId?: string | null;
        providerFirewallName?: string | null;
      })
    | null,
  now: () => Date,
): DigitalOceanResource | null {
  if (!droplet?.id) {
    return null;
  }

  return {
    provider: DIGITALOCEAN_PROVIDER,
    providerResourceId: String(droplet.id),
    providerFirewallId: fallback?.providerFirewallId ?? null,
    providerFirewallName: fallback?.providerFirewallName ?? null,
    publicIpv4: readApiPublicIpv4(droplet),
    name: droplet.name ?? fallback?.name ?? "agentbay-runner",
    region: readApiSlug(droplet.region) ?? fallback?.region ?? "unknown",
    sizeSlug: droplet.sizeSlug ?? droplet.size_slug ?? fallback?.sizeSlug ?? "unknown",
    image: readApiSlug(droplet.image) ?? fallback?.image ?? "unknown",
    tags: [...new Set(droplet.tags ?? fallback?.tags ?? [])].sort(),
    firewallApplied: false,
    createdAt:
      readApiDate(droplet.createdAt ?? droplet.created_at) ??
      (fallback ? now().toISOString() : null),
    deletedAt: null,
  };
}

type SdkResourceObservation<T> =
  | { state: "present"; value: T }
  | { state: "absent" }
  | { state: "unknown" };

async function observeSdkResource<T>(
  execute: () => Promise<T>,
  context?: DigitalOceanProviderRequestContext,
): Promise<SdkResourceObservation<T>> {
  if (context?.signal.aborted) return { state: "unknown" };

  try {
    return { state: "present", value: await execute() };
  } catch (error) {
    return readSdkStatus(error) === 404 ? { state: "absent" } : { state: "unknown" };
  }
}

function apiDropletMatchesOwnedSet(
  droplet: DigitalOceanApiDroplet | null | undefined,
  input: DigitalOceanOwnedSetExpectation,
): boolean {
  return (
    String(droplet?.id ?? "") === input.providerResourceId &&
    droplet?.name === input.expectedName &&
    readApiSlug(droplet.region) === input.expectedRegion &&
    (droplet.sizeSlug ?? droplet.size_slug) === input.expectedSizeSlug &&
    Array.isArray(droplet.tags) &&
    droplet.tags.includes(input.operationTag)
  );
}

function apiFirewallMatchesOwnedSet(
  firewall: DigitalOceanApiFirewall | null | undefined,
  input: DigitalOceanOwnedSetExpectation,
  dropletId: number,
): boolean {
  const attachedDropletIds = firewall?.dropletIds ?? firewall?.droplet_ids;

  return (
    firewall?.id?.trim() === input.providerFirewallId &&
    firewall.name === input.expectedFirewallName &&
    Array.isArray(attachedDropletIds) &&
    attachedDropletIds.length === 1 &&
    attachedDropletIds[0] === dropletId
  );
}

function taggedDropletsMatchOwnedSet(
  droplets: DigitalOceanApiDroplet[],
  input: DigitalOceanOwnedSetExpectation,
  exactDropletState: "present" | "absent",
): boolean {
  if (
    droplets.some(
      (droplet) => !Array.isArray(droplet.tags) || !droplet.tags.includes(input.operationTag),
    )
  ) {
    return false;
  }

  if (exactDropletState === "absent") return droplets.length === 0;

  return (
    droplets.length === 1 &&
    String(droplets[0]?.id ?? "") === input.providerResourceId &&
    apiDropletMatchesOwnedSet(droplets[0], input)
  );
}

function parseDigitalOceanDropletId(value: string): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasCompleteOwnedSetExpectation(input: DigitalOceanOwnedSetExpectation): boolean {
  return [
    input.operationTag,
    input.providerResourceId,
    input.providerFirewallId,
    input.expectedName,
    input.expectedRegion,
    input.expectedSizeSlug,
    input.expectedFirewallName,
  ].every((value) => value.trim().length > 0);
}

function ambiguousOwnedSet<T>(): DigitalOceanOwnedSetResult<T> {
  return {
    ok: false,
    reason: "ownership_ambiguous",
    retryable: false,
    message: "DigitalOcean resource ownership was ambiguous; no deletion was attempted.",
  };
}

function unknownOwnedSetObservation<T>(): DigitalOceanOwnedSetResult<T> {
  return {
    ok: false,
    reason: "observation_unknown",
    retryable: true,
    message: "DigitalOcean resource ownership could not be observed; retry before deleting.",
  };
}

function unknownOwnedSetDelete<T>(): DigitalOceanOwnedSetResult<T> {
  return {
    ok: false,
    reason: "delete_outcome_unknown",
    retryable: true,
    message: "DigitalOcean deletion outcome could not be confirmed; retry observation.",
  };
}

function ownedSetDeleted(): DigitalOceanOwnedSetResult<DigitalOceanOwnedSetDeleteResult> {
  return { ok: true, value: { state: "absent" } };
}

async function runSdkStep<T>(
  reason: DigitalOceanProviderErrorReason,
  execute: () => Promise<T>,
  context?: DigitalOceanProviderRequestContext,
  abortedReason: DigitalOceanProviderErrorReason = reason,
): Promise<DigitalOceanProviderResult<T>> {
  if (context?.signal.aborted) {
    return {
      ok: false,
      reason: abortedReason,
      message: "DigitalOcean API request was cancelled before completion.",
    };
  }

  try {
    return { ok: true, value: await execute() };
  } catch (error) {
    if (process.env.NODE_ENV !== "test") {
      digitalOceanProviderLogger.error("api_request_failed", error, {
        reason: context?.signal.aborted ? abortedReason : reason,
        providerStatus: readSdkStatus(error),
        aborted: Boolean(context?.signal.aborted),
      });
    }

    return {
      ok: false,
      reason: context?.signal.aborted ? abortedReason : reason,
      message: `DigitalOcean API request failed${readSdkStatusSuffix(error)}.`,
    };
  }
}

function abortedProviderResult<T>(
  reason: DigitalOceanProviderErrorReason,
  context: DigitalOceanProviderRequestContext | undefined,
): DigitalOceanProviderResult<T> | null {
  return context?.signal.aborted
    ? { ok: false, reason, message: "DigitalOcean API request was cancelled before completion." }
    : null;
}

function readSdkStatusSuffix(error: unknown): string {
  const status = readSdkStatus(error);

  return typeof status === "number" ? ` with status ${status}` : "";
}

function readSdkStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;

  const statusCode = "statusCode" in error ? error.statusCode : null;
  const responseStatus = "responseStatusCode" in error ? error.responseStatusCode : null;
  const status = typeof statusCode === "number" ? statusCode : responseStatus;

  return typeof status === "number" ? status : null;
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

function webInboundRules(addresses: string[] | undefined): DigitalOceanFirewallInboundRule[] {
  const sourceAddresses =
    addresses === undefined ? ["0.0.0.0/0", "::/0"] : normalizeFirewallAddresses(addresses);

  return sourceAddresses.length > 0
    ? [tcpInboundRule("80", sourceAddresses), tcpInboundRule("443", sourceAddresses)]
    : [];
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
  const normalizedAddresses = new Set<string>();
  for (const address of addresses ?? []) {
    const normalizedAddress = address.trim();
    if (normalizedAddress) normalizedAddresses.add(normalizedAddress);
  }
  return [...normalizedAddresses].sort();
}

function sshHostKeySha256Fingerprint(knownHostLine: string): string | null {
  const [, keyType, keyBlob] = knownHostLine.trim().split(/\s+/, 3);

  if (keyType !== "ssh-ed25519" || !keyBlob) {
    return null;
  }

  try {
    const digest = createHash("sha256").update(Buffer.from(keyBlob, "base64")).digest("base64");

    return `SHA256:${digest.replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}

function isSha256SshFingerprint(value: string): boolean {
  return /^SHA256:[A-Za-z0-9+/]{43}$/.test(value.trim());
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
