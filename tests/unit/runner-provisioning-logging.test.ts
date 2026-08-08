import { afterEach, describe, expect, it, vi } from "vitest";
import type { DigitalOceanProviderConfig } from "@/src/server/env";
import type {
  DigitalOceanProvider,
  DigitalOceanProviderResult,
  DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";

const USER_ID = "00000000-0000-4000-8000-00000000b701";
const RUNNER_ID = "00000000-0000-4000-8000-00000000b721";
const DEPLOYMENT_ID_WITHOUT_DASHES = "0000000000004000800000000000b731";
const OPERATION_KEY = `bruno-deploy-${DEPLOYMENT_ID_WITHOUT_DASHES}`;

describe("runner provisioning logging", () => {
  afterEach(() => {
    vi.doUnmock("@/src/server/logging/logger");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("does not log raw provider operation tags or derived deployment ids for automatic lifecycles", async () => {
    const childBindings: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    const logger = fakeAppLogger(childBindings, events);
    vi.stubEnv("NODE_ENV", "production");

    vi.doMock("@/src/server/logging/logger", () => ({
      createAppLogger: () => logger,
      LOG_REDACTION_CENSOR: "[REDACTED]",
    }));

    const { advanceAutomaticDigitalOceanRunnerProvisioning } = await import(
      "@/src/server/runners/runner-provisioning"
    );

    await expect(
      advanceAutomaticDigitalOceanRunnerProvisioning({
        connection: provisioningRunnerConnection(),
        userId: USER_ID,
        runnerId: RUNNER_ID,
        operationKey: OPERATION_KEY,
        attemptCount: 1,
        maxAttempts: 2,
        config: providerConfig(),
        provider: inconclusiveDiscoveryProvider(`${OPERATION_KEY} ${DEPLOYMENT_ID_WITHOUT_DASHES}`),
        context: { signal: new AbortController().signal },
        now: () => new Date("2026-08-03T09:00:00.000Z"),
      }),
    ).resolves.toEqual({
      ok: true,
      state: "pending",
      disposition: "observation_wait",
    });

    const serialized = JSON.stringify({ childBindings, events });

    expect(childBindings).toEqual([
      expect.objectContaining({
        lifecycle: "droplet_creation",
        lifecycleId: RUNNER_ID,
        operationMode: "automatic",
        runnerId: RUNNER_ID,
      }),
    ]);
    expect(serialized).not.toContain(OPERATION_KEY);
    expect(serialized).not.toContain(DEPLOYMENT_ID_WITHOUT_DASHES);
    expect(serialized).not.toContain(USER_ID);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "resource_discovery_inconclusive",
          metadata: expect.objectContaining({
            reason: "[REDACTED] [REDACTED]",
          }),
        }),
      ]),
    );
  });
});

function fakeAppLogger(
  childBindings: Array<Record<string, unknown>>,
  events: Array<Record<string, unknown>>,
) {
  const write = (level: string, event: string, metadata?: Record<string, unknown>) => {
    events.push({ level, event, metadata });
  };
  const logger = {
    child: (bindings: Record<string, unknown>) => {
      childBindings.push(bindings);
      return logger;
    },
    trace: (event: string, metadata?: Record<string, unknown>) => write("trace", event, metadata),
    debug: (event: string, metadata?: Record<string, unknown>) => write("debug", event, metadata),
    info: (event: string, metadata?: Record<string, unknown>) => write("info", event, metadata),
    warn: (event: string, metadata?: Record<string, unknown>) => write("warn", event, metadata),
    errorEvent: (event: string, metadata?: Record<string, unknown>) =>
      write("error", event, metadata),
    error: (event: string, error: unknown, metadata?: Record<string, unknown>) => {
      events.push({ level: "error", event, error, metadata });
    },
    fatal: (event: string, error: unknown, metadata?: Record<string, unknown>) => {
      events.push({ level: "fatal", event, error, metadata });
    },
  };

  return logger;
}

function provisioningRunnerConnection() {
  const query = {
    from: () => query,
    where: () => query,
    limit: async () => [
      {
        id: RUNNER_ID,
        name: "Automatic Runner",
        status: "provisioning",
        providerResourceId: null,
        providerFirewallId: null,
        endpointUrl: null,
        provisioningStatus: "pending",
        provisioningOperationKey: OPERATION_KEY,
        region: "sfo3",
        sizeSlug: "s-1vcpu-2gb",
      },
    ],
  };

  return {
    db: {
      select: () => query,
    },
  } as never;
}

function inconclusiveDiscoveryProvider(reason: string): DigitalOceanProvider {
  const fail = async (): Promise<DigitalOceanProviderResult<DigitalOceanResource>> => ({
    ok: false,
    reason: "discovery_failed",
    message: "not used",
  });

  return {
    listSshKeys: async () => ({
      ok: true,
      value: [],
    }),
    createSshKey: async () => ({
      ok: false,
      reason: "ssh_key_create_failed",
      message: "not used",
    }),
    discoverResourcesByTag: async () => ({
      ok: false,
      reason: reason as never,
      message: "not used",
    }),
    listManagedResources: async () => ({
      ok: true,
      value: { authoritative: true, resources: [] },
    }),
    readResource: fail,
    createRunner: fail,
    tagResource: fail,
    applyFirewall: fail,
    cleanupResource: fail,
  };
}

function providerConfig(): DigitalOceanProviderConfig {
  return {
    token: "fake-provider-token",
    providerMode: "digitalocean",
    runnerBearerToken: "fake-runner-bearer",
    runnerImage: "bruno-runner:test",
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    image: "ubuntu-24-04-x64",
    tags: ["bruno", "bruno-runner"],
    sshKeyIds: ["fake-key"],
    sshSourceAddresses: ["203.0.113.5/32"],
  };
}
