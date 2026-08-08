import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvValidationError } from "@/src/env/validation";
import {
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_HERMES_WORKLOAD_IMAGE,
} from "@/src/runner-service/constants";
import {
  isAuthorizedCronRequest,
  isAuthorizedHermesStagingAcceptanceRequest,
  readCronSecretConfig,
  readDeploymentDispatchConfig,
  readDigitalOceanProviderConfig,
  readHermesStagingAcceptanceConfig,
  readHermesWorkloadImage,
  readReadyAgentCreationFlag,
  readRunnerRolloutBatchSize,
} from "@/src/server/env";

const HOSTED_RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const HOSTED_RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:sha-test@${HOSTED_RUNNER_DIGEST}`;

describe("server-only provider environment validation", () => {
  it("parses cron secrets exactly and authorizes only a single bearer credential", () => {
    const secret = "abcdefghijklmnopqrstuvwxyzABCDEF012345";

    expect(readCronSecretConfig({ CRON_SECRET: secret })).toEqual({ ok: true, secret });
    expect(readCronSecretConfig({})).toEqual({
      ok: false,
      reason: "cron_configuration_invalid",
    });
    expect(readCronSecretConfig({ CRON_SECRET: ` ${secret}` })).toEqual({
      ok: false,
      reason: "cron_configuration_invalid",
    });
    expect(readCronSecretConfig({ CRON_SECRET: "short" })).toEqual({
      ok: false,
      reason: "cron_configuration_invalid",
    });
    expect(readCronSecretConfig({ CRON_SECRET: "a".repeat(32) })).toEqual({
      ok: true,
      secret: "a".repeat(32),
    });
    expect(readCronSecretConfig({ CRON_SECRET: "a".repeat(256) })).toEqual({
      ok: true,
      secret: "a".repeat(256),
    });
    expect(readCronSecretConfig({ CRON_SECRET: "a".repeat(257) })).toEqual({
      ok: false,
      reason: "cron_configuration_invalid",
    });
    expect(
      isAuthorizedCronRequest({
        authorizationHeader: `Bearer ${secret}`,
        secret,
      }),
    ).toBe(true);
    expect(
      isAuthorizedCronRequest({
        authorizationHeader: `Bearer ${secret} extra`,
        secret,
      }),
    ).toBe(false);
    expect(
      isAuthorizedCronRequest({
        authorizationHeader: `Bearer ${secret}, Bearer ${secret}`,
        secret,
      }),
    ).toBe(false);
    expect(
      isAuthorizedCronRequest({
        authorizationHeader: `bearer ${secret}`,
        secret,
      }),
    ).toBe(false);
    expect(
      isAuthorizedCronRequest({
        authorizationHeader: `Bearer ${secret.slice(0, -1)}x`,
        secret,
      }),
    ).toBe(false);
  });

  it("parses ready agent creation as an exact default-off lowercase flag", () => {
    expect(readReadyAgentCreationFlag({})).toEqual({ ok: true, enabled: false });
    expect(readReadyAgentCreationFlag({ BRUNO_READY_AGENT_CREATION_ENABLED: "false" })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(readReadyAgentCreationFlag({ BRUNO_READY_AGENT_CREATION_ENABLED: " true " })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(readReadyAgentCreationFlag({ BRUNO_READY_AGENT_CREATION_ENABLED: "TRUE" })).toEqual({
      ok: false,
      reason: "invalid_ready_agent_creation_flag",
    });
    expect(readReadyAgentCreationFlag({ BRUNO_READY_AGENT_CREATION_ENABLED: "yes" })).toEqual({
      ok: false,
      reason: "invalid_ready_agent_creation_flag",
    });
  });

  it("keeps managed runner rollout gradual by default and supports an exact halt", () => {
    expect(readRunnerRolloutBatchSize({})).toBe(1);
    expect(readRunnerRolloutBatchSize({ BRUNO_RUNNER_ROLLOUT_BATCH_SIZE: "1" })).toBe(1);
    expect(readRunnerRolloutBatchSize({ BRUNO_RUNNER_ROLLOUT_BATCH_SIZE: " 0 " })).toBe(0);
    expect(() => readRunnerRolloutBatchSize({ BRUNO_RUNNER_ROLLOUT_BATCH_SIZE: "2" })).toThrow(
      "must be 0 (halted) or 1 (gradual)",
    );
  });

  it("keeps deployment wakeup dispatch in cron mode unless QStash is fully configured", () => {
    const token = "qstash_token_abcdefghijklmnopqrstuvwxyz012345";
    const currentSigningKey = "current_signing_key_abcdefghijklmnopqrstuvwxyz012345";
    const nextSigningKey = "next_signing_key_abcdefghijklmnopqrstuvwxyz012345";
    const configured = {
      BRUNO_DEPLOYMENT_DISPATCH_MODE: "qstash",
      QSTASH_TOKEN: token,
      QSTASH_CURRENT_SIGNING_KEY: currentSigningKey,
      QSTASH_NEXT_SIGNING_KEY: nextSigningKey,
      NEXT_PUBLIC_APP_URL: "https://app.example.test",
    };

    expect(readDeploymentDispatchConfig({})).toEqual({ ok: true, mode: "cron" });
    expect(readDeploymentDispatchConfig({ BRUNO_DEPLOYMENT_DISPATCH_MODE: "cron" })).toEqual({
      ok: true,
      mode: "cron",
    });
    expect(readDeploymentDispatchConfig(configured)).toEqual({
      ok: true,
      mode: "qstash",
      token,
      currentSigningKey,
      nextSigningKey,
      callbackBaseUrl: "https://app.example.test",
      maxPublishAttempts: 12,
    });
    expect(
      readDeploymentDispatchConfig({
        ...configured,
        BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "7",
      }),
    ).toMatchObject({ ok: true, mode: "qstash", maxPublishAttempts: 7 });

    for (const partial of [
      { ...configured, QSTASH_TOKEN: undefined },
      { ...configured, QSTASH_CURRENT_SIGNING_KEY: undefined },
      { ...configured, QSTASH_NEXT_SIGNING_KEY: undefined },
      { ...configured, NEXT_PUBLIC_APP_URL: "http://app.example.test" },
      { ...configured, QSTASH_NEXT_SIGNING_KEY: currentSigningKey },
      { ...configured, CRON_SECRET: token },
      { ...configured, BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "0" },
      { ...configured, BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "12.5" },
      { ...configured, BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "101" },
      { BRUNO_DEPLOYMENT_DISPATCH_MODE: "queue" },
    ]) {
      expect(readDeploymentDispatchConfig(partial)).toEqual({
        ok: false,
        reason: "deployment_dispatch_configuration_invalid",
      });
    }
  });

  it("keeps staging acceptance exactly default-off with a dedicated HTTPS transport", () => {
    const bearerSecret = "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345";
    const configured = {
      BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
      BRUNO_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.test/",
      BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: bearerSecret,
    };

    expect(readHermesStagingAcceptanceConfig({})).toEqual({ ok: true, enabled: false });
    expect(
      readHermesStagingAcceptanceConfig({
        BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED: "false",
      }),
    ).toEqual({ ok: true, enabled: false });
    expect(readHermesStagingAcceptanceConfig(configured)).toEqual({
      ok: true,
      enabled: true,
      baseUrl: "https://staging.example.test",
      bearerSecret,
    });

    for (const enabled of ["", "TRUE", " true ", "1"]) {
      expect(
        readHermesStagingAcceptanceConfig({
          ...configured,
          BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED: enabled,
        }),
      ).toEqual({
        ok: false,
        reason: "hermes_staging_acceptance_configuration_invalid",
      });
    }

    for (const baseUrl of [
      "http://staging.example.test",
      " https://staging.example.test",
      "https://user:password@staging.example.test",
      "https://staging.example.test/internal",
      "https://staging.example.test/?private=true",
      "https://staging.example.test/#private",
    ]) {
      expect(
        readHermesStagingAcceptanceConfig({
          ...configured,
          BRUNO_HERMES_STAGING_ACCEPTANCE_BASE_URL: baseUrl,
        }),
      ).toEqual({
        ok: false,
        reason: "hermes_staging_acceptance_configuration_invalid",
      });
    }
  });

  it("requires a distinct 32-256 character staging bearer and compares it in constant time", () => {
    const bearerSecret = "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345";
    const configured = {
      BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
      BRUNO_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.test",
      BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: bearerSecret,
    };

    for (const conflictingName of [
      "CRON_SECRET",
      "BRUNO_RUNNER_BEARER_TOKEN",
      "BRUNO_OPERATOR_PASSWORD",
    ] as const) {
      expect(
        readHermesStagingAcceptanceConfig({
          ...configured,
          [conflictingName]: bearerSecret,
        }),
      ).toEqual({
        ok: false,
        reason: "hermes_staging_acceptance_configuration_invalid",
      });
    }

    for (const invalidSecret of ["a".repeat(31), "a".repeat(257), ` ${"a".repeat(32)}`]) {
      expect(
        readHermesStagingAcceptanceConfig({
          ...configured,
          BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: invalidSecret,
        }),
      ).toEqual({
        ok: false,
        reason: "hermes_staging_acceptance_configuration_invalid",
      });
    }

    for (const boundarySecret of ["a".repeat(32), "a".repeat(256)]) {
      expect(
        readHermesStagingAcceptanceConfig({
          ...configured,
          BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: boundarySecret,
        }),
      ).toMatchObject({ ok: true, enabled: true, bearerSecret: boundarySecret });
    }

    expect(
      isAuthorizedHermesStagingAcceptanceRequest({
        authorizationHeader: `Bearer ${bearerSecret}`,
        bearerSecret,
      }),
    ).toBe(true);
    for (const authorizationHeader of [
      null,
      `bearer ${bearerSecret}`,
      `Bearer ${bearerSecret} extra`,
      `Bearer ${bearerSecret.slice(0, -1)}x`,
    ]) {
      expect(
        isAuthorizedHermesStagingAcceptanceRequest({
          authorizationHeader,
          bearerSecret,
        }),
      ).toBe(false);
    }
  });

  it("keeps the ready creation flag parser server-owned", async () => {
    const source = await readFile("src/server/env.ts", "utf8");
    const sharedFiles = await readdir("src/shared");

    expect(source).toContain("export function readReadyAgentCreationFlag");
    expect(source).not.toContain("@/src/shared/ready-agent-creation-flag");
    expect(sharedFiles).not.toContain("ready-agent-creation-flag.ts");
  });

  it("returns null when DigitalOcean provisioning is not configured", () => {
    expect(readDigitalOceanProviderConfig({})).toBeNull();
  });

  it("reads the same validated Hermes workload image independently of provider credentials", () => {
    const customImage =
      "ghcr.io/ametel01/bruno-hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(readHermesWorkloadImage({})).toBe(DEFAULT_HERMES_WORKLOAD_IMAGE);
    expect(readHermesWorkloadImage({ BRUNO_HERMES_WORKLOAD_IMAGE: ` ${customImage} ` })).toBe(
      customImage,
    );

    for (const value of ["", " ", "image with spaces", "image;docker pull attacker/image"]) {
      expect(() => readHermesWorkloadImage({ BRUNO_HERMES_WORKLOAD_IMAGE: value })).toThrow(
        /BRUNO_HERMES_WORKLOAD_IMAGE/,
      );
    }
  });

  it("validates DigitalOcean token and non-secret provisioning defaults on the server path", () => {
    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
      }),
    ).toThrow("BRUNO_RUNNER_IMAGE must be an immutable registry image reference");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
      }),
    ).toThrow("Swap is not counted as compatible memory");

    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      }),
    ).toMatchObject({
      runnerBearerToken: "runner-command-token",
      runnerImage: HOSTED_RUNNER_IMAGE,
      hermesWorkloadImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      hermesStateRoot: DEFAULT_HERMES_STATE_ROOT,
      hermesPrivateNetwork: DEFAULT_HERMES_PRIVATE_NETWORK,
      hermesReadinessTimeoutMs: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
      hermesDockerCpus: "1",
      hermesDockerMemory: "1536m",
      hermesDockerPidsLimit: "256",
      runnerMaxAgents: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno", "bruno-runner"],
      sshSourceAddresses: [],
    });

    const config = readDigitalOceanProviderConfig({
      BRUNO_DIGITALOCEAN_TOKEN: " dop_v1_test_token ",
      BRUNO_RUNNER_BEARER_TOKEN: " runner-command-token ",
      BRUNO_DIGITALOCEAN_REGION: " nyc3 ",
      BRUNO_DIGITALOCEAN_SIZE_SLUG: " s-2vcpu-2gb ",
      BRUNO_DIGITALOCEAN_IMAGE: " ubuntu-24-04-x64 ",
      BRUNO_RUNNER_IMAGE: ` ${HOSTED_RUNNER_IMAGE} `,
      BRUNO_HERMES_WORKLOAD_IMAGE: " ghcr.io/ametel01/bruno-hermes:sha-123 ",
      BRUNO_HERMES_STATE_ROOT: " /var/lib/bruno/custom-agents ",
      BRUNO_HERMES_PRIVATE_NETWORK: " bruno-custom-hermes ",
      BRUNO_HERMES_READINESS_TIMEOUT_MS: "240000",
      BRUNO_HERMES_DOCKER_CPUS: "1",
      BRUNO_HERMES_DOCKER_MEMORY: "1536m",
      BRUNO_HERMES_DOCKER_PIDS_LIMIT: "256",
      BRUNO_RUNNER_MAX_AGENTS: "1",
      BRUNO_DIGITALOCEAN_TAGS: "runner, bruno, runner",
      BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5, 2001:db8::/64",
    });

    expect(config).toEqual({
      token: "dop_v1_test_token",
      providerMode: "digitalocean",
      runnerBearerToken: "runner-command-token",
      runnerImage: HOSTED_RUNNER_IMAGE,
      hermesWorkloadImage: "ghcr.io/ametel01/bruno-hermes:sha-123",
      hermesStateRoot: "/var/lib/bruno/custom-agents",
      hermesPrivateNetwork: "bruno-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      hermesDockerCpus: "1",
      hermesDockerMemory: "1536m",
      hermesDockerPidsLimit: "256",
      runnerMaxAgents: 1,
      region: "nyc3",
      sizeSlug: "s-2vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno", "runner"],
      sshSourceAddresses: ["2001:db8::/64", "203.0.113.5/32"],
      snapshotMode: { mode: "stock" },
    });
  });

  it("requires explicit snapshot evidence and source identity before snapshot image mode", () => {
    const base = {
      BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
      BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
      BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
      BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      BRUNO_DIGITALOCEAN_IMAGE_MODE: "snapshot",
    };

    expect(() => readDigitalOceanProviderConfig(base)).toThrow(
      "BRUNO_DIGITALOCEAN_SNAPSHOT_MANIFEST is required",
    );

    const configured = readDigitalOceanProviderConfig({
      ...base,
      BRUNO_DIGITALOCEAN_SNAPSHOT_MANIFEST: '{"schemaVersion":"bruno.runner.snapshot.v1"}',
      BRUNO_DIGITALOCEAN_SNAPSHOT_SIGNATURE: "signature",
      BRUNO_DIGITALOCEAN_SNAPSHOT_PUBLIC_KEY: "public-key",
      BRUNO_RELEASE_SOURCE_REVISION: "1".repeat(40),
      BRUNO_DOCKER_RUNNER_IMAGE: `ghcr.io/ametel01/default-agent:sha@sha256:${"c".repeat(64)}`,
    });

    expect(configured?.snapshotMode).toMatchObject({
      mode: "snapshot",
      expected: {
        region: "sfo3",
        sizeDiskGb: 50,
        baseImageSlug: "ubuntu-24-04-x64",
        sourceRepository: "ametel01/bruno",
        sourceRevision: "1".repeat(40),
      },
    });
  });

  it("parses local Docker provider mode for manual cloud-runner smoke tests", () => {
    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        BRUNO_DIGITALOCEAN_TOKEN: "local-docker",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: "bruno-runner:local",
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_HERMES_DOCKER_CPUS: "1",
        BRUNO_HERMES_DOCKER_MEMORY: "1536m",
        BRUNO_HERMES_DOCKER_PIDS_LIMIT: "256",
        BRUNO_LOCAL_CLOUD_RUNNER_ENDPOINT_URL: "http://host.docker.internal:3045",
        BRUNO_LOCAL_CLOUD_RUNNER_CONTAINER_NAME: "bruno-local-cloud-runner",
        BRUNO_LOCAL_CLOUD_RUNNER_START_DELAY_MS: "0",
        BRUNO_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      }),
    ).toMatchObject({
      token: "local-docker",
      providerMode: "local_docker",
      runnerBearerToken: "runner-command-token",
      runnerImage: "bruno-runner:local",
      sizeSlug: "s-1vcpu-2gb",
      localRunnerEndpointUrl: "http://host.docker.internal:3045",
      localRunnerContainerName: "bruno-local-cloud-runner",
      localRunnerStartDelayMs: 0,
      localAgentSmokeMode: true,
    });

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      }),
    ).toThrow(EnvValidationError);

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        BRUNO_DIGITALOCEAN_TOKEN: "not-the-local-sentinel",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: "bruno-runner:local",
        BRUNO_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      }),
    ).toThrow(EnvValidationError);

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        BRUNO_DIGITALOCEAN_TOKEN: "local-docker",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: "bruno-runner:local",
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-512mb-10gb",
        BRUNO_LOCAL_AGENT_SMOKE_MODE: "synthetic-external-boundaries",
      }),
    ).toThrow("Swap is not counted as compatible memory");
  });

  it("parses DigitalOcean SSH access configuration for Droplet creation", () => {
    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_DIGITALOCEAN_SSH_KEY_IDS: "52830696, c3:2a:31",
        BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/32, 2001:db8::/64",
      }),
    ).toMatchObject({
      sshKeyIds: ["52830696", "c3:2a:31"],
      sshSourceAddresses: ["2001:db8::/64", "203.0.113.5/32"],
    });

    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_DIGITALOCEAN_SSH_KEY_IDS: "auto",
      }),
    ).not.toHaveProperty("sshKeyIds");

    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_DIGITALOCEAN_SSH_KEY_IDS: "none",
      }),
    ).toMatchObject({ sshKeyIds: [] });
  });

  it("requires explicit public SSH source access opt-in", () => {
    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
      }),
    ).toMatchObject({ sshSourceAddresses: [] });

    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "true",
      }),
    ).toMatchObject({ sshSourceAddresses: ["0.0.0.0/0", "::/0"] });

    expect(
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-1vcpu-2gb",
        BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "false",
      }),
    ).toMatchObject({ sshSourceAddresses: [] });
  });

  it("rejects malformed cloud runner provider settings without echoing raw values", () => {
    const invalidRunnerImage = "ghcr.io/ametel01/bruno-runner:latest;rm";

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: invalidRunnerImage,
      }),
    ).toThrow("BRUNO_RUNNER_IMAGE must be a valid container image reference");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_WORKLOAD_IMAGE: "ghcr.io/ametel01/bruno-hermes:latest;rm",
      }),
    ).toThrow("BRUNO_HERMES_WORKLOAD_IMAGE must be a valid container image reference");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_STATE_ROOT: "../bruno",
      }),
    ).toThrow("BRUNO_HERMES_STATE_ROOT must be an absolute runtime path");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_PRIVATE_NETWORK: "bruno hermes",
      }),
    ).toThrow("BRUNO_HERMES_PRIVATE_NETWORK must be a Docker network name");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_READINESS_TIMEOUT_MS: "0",
      }),
    ).toThrow("BRUNO_HERMES_READINESS_TIMEOUT_MS must be a positive integer");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_DOCKER_CPUS: "0.0000000001",
      }),
    ).toThrow("BRUNO_HERMES_DOCKER_CPUS must be a positive Docker CPU value representable");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_HERMES_DOCKER_PIDS_LIMIT: "4097",
      }),
    ).toThrow("BRUNO_HERMES_DOCKER_PIDS_LIMIT must be a positive integer no greater than 4096");

    try {
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: invalidRunnerImage,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(String(error)).not.toContain(invalidRunnerImage);
    }

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_REGION: "nyc 3",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_REGION must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SIZE_SLUG: "s/1vcpu",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_SIZE_SLUG must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_IMAGE: "ubuntu,24",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_IMAGE must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_TAGS: "bruno,pre beta",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_TAGS entries must not contain whitespace");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SSH_KEY_IDS: "52830696, bad key",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_SSH_KEY_IDS entries must not contain whitespace");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS: "example.com",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/33",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must use a valid");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "yes",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/32",
        BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "yes",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true");
  });

  it("rejects blank DigitalOcean provider configuration", () => {
    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: " ",
      }),
    ).toThrowError(EnvValidationError);

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_RUNNER_IMAGE: " ",
      }),
    ).toThrow("BRUNO_RUNNER_IMAGE cannot be blank when DigitalOcean is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_REGION: " ",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_REGION cannot be blank when DigitalOcean is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
        BRUNO_DIGITALOCEAN_SSH_KEY_IDS: " ",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_SSH_KEY_IDS cannot be blank when set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
      }),
    ).toThrow("BRUNO_RUNNER_BEARER_TOKEN is required when DigitalOcean provisioning is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        BRUNO_DIGITALOCEAN_PROVIDER_MODE: "fake",
        BRUNO_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        BRUNO_RUNNER_BEARER_TOKEN: "runner-command-token",
      }),
    ).toThrow("BRUNO_DIGITALOCEAN_PROVIDER_MODE must be digitalocean or local_docker");
  });

  it("keeps DigitalOcean provider tokens out of shared validation and client components", async () => {
    await expect(readFile("src/env/validation.ts", "utf8")).resolves.not.toContain(
      "BRUNO_DIGITALOCEAN_TOKEN",
    );
    await expect(readFile("src/server/env.ts", "utf8")).resolves.toContain('import "server-only";');
    await expect(
      readFile("src/server/runners/digitalocean-provider.ts", "utf8"),
    ).resolves.toContain('import "server-only";');

    for (const filePath of await listSourceFiles("app")) {
      const source = await readFile(filePath, "utf8");

      if (!source.startsWith('"use client";')) {
        continue;
      }

      expect(source).not.toContain("BRUNO_DIGITALOCEAN");
      expect(source).not.toContain("@/src/server/env");
      expect(source).not.toContain("@/src/server/runners/digitalocean-provider");
    }
  });
});

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(filePath);
      }

      return /\.(ts|tsx)$/.test(entry.name) ? [filePath] : [];
    }),
  );

  return files.flat();
}
