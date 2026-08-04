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
  readDigitalOceanProviderConfig,
  readHermesStagingAcceptanceConfig,
  readHermesWorkloadImage,
  readReadyAgentCreationFlag,
  readRunnerRolloutBatchSize,
} from "@/src/server/env";

const HOSTED_RUNNER_DIGEST = `sha256:${"a".repeat(64)}`;
const HOSTED_RUNNER_IMAGE = `ghcr.io/ametel01/agentbay-runner:sha-test@${HOSTED_RUNNER_DIGEST}`;

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
    expect(readReadyAgentCreationFlag({ AGENTBAY_READY_AGENT_CREATION_ENABLED: "false" })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(readReadyAgentCreationFlag({ AGENTBAY_READY_AGENT_CREATION_ENABLED: " true " })).toEqual(
      {
        ok: true,
        enabled: true,
      },
    );
    expect(readReadyAgentCreationFlag({ AGENTBAY_READY_AGENT_CREATION_ENABLED: "TRUE" })).toEqual({
      ok: false,
      reason: "invalid_ready_agent_creation_flag",
    });
    expect(readReadyAgentCreationFlag({ AGENTBAY_READY_AGENT_CREATION_ENABLED: "yes" })).toEqual({
      ok: false,
      reason: "invalid_ready_agent_creation_flag",
    });
  });

  it("keeps managed runner rollout gradual by default and supports an exact halt", () => {
    expect(readRunnerRolloutBatchSize({})).toBe(1);
    expect(readRunnerRolloutBatchSize({ AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE: "1" })).toBe(1);
    expect(readRunnerRolloutBatchSize({ AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE: " 0 " })).toBe(0);
    expect(() => readRunnerRolloutBatchSize({ AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE: "2" })).toThrow(
      "must be 0 (halted) or 1 (gradual)",
    );
  });

  it("keeps staging acceptance exactly default-off with a dedicated HTTPS transport", () => {
    const bearerSecret = "staging_acceptance_abcdefghijklmnopqrstuvwxyz012345";
    const configured = {
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.test/",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: bearerSecret,
    };

    expect(readHermesStagingAcceptanceConfig({})).toEqual({ ok: true, enabled: false });
    expect(
      readHermesStagingAcceptanceConfig({
        AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "false",
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
          AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: enabled,
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
          AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: baseUrl,
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
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED: "true",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL: "https://staging.example.test",
      AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: bearerSecret,
    };

    for (const conflictingName of [
      "CRON_SECRET",
      "AGENTBAY_RUNNER_BEARER_TOKEN",
      "AGENTBAY_OPERATOR_PASSWORD",
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
          AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: invalidSecret,
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
          AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET: boundarySecret,
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
      "ghcr.io/ametel01/agentbay-hermes@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    expect(readHermesWorkloadImage({})).toBe(DEFAULT_HERMES_WORKLOAD_IMAGE);
    expect(readHermesWorkloadImage({ AGENTBAY_HERMES_WORKLOAD_IMAGE: ` ${customImage} ` })).toBe(
      customImage,
    );

    for (const value of ["", " ", "image with spaces", "image;docker pull attacker/image"]) {
      expect(() => readHermesWorkloadImage({ AGENTBAY_HERMES_WORKLOAD_IMAGE: value })).toThrow(
        /AGENTBAY_HERMES_WORKLOAD_IMAGE/,
      );
    }
  });

  it("validates DigitalOcean token and non-secret provisioning defaults on the server path", () => {
    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
      }),
    ).toThrow("AGENTBAY_RUNNER_IMAGE must be an immutable registry image reference");

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
      }),
    ).toMatchObject({
      runnerBearerToken: "runner-command-token",
      runnerImage: HOSTED_RUNNER_IMAGE,
      hermesWorkloadImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      hermesStateRoot: DEFAULT_HERMES_STATE_ROOT,
      hermesPrivateNetwork: DEFAULT_HERMES_PRIVATE_NETWORK,
      hermesReadinessTimeoutMs: DEFAULT_HERMES_READINESS_TIMEOUT_MS,
      runnerMaxAgents: DEFAULT_HERMES_RUNNER_MAX_AGENTS,
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "agentbay-runner"],
      sshSourceAddresses: [],
    });

    const config = readDigitalOceanProviderConfig({
      AGENTBAY_DIGITALOCEAN_TOKEN: " dop_v1_test_token ",
      AGENTBAY_RUNNER_BEARER_TOKEN: " runner-command-token ",
      AGENTBAY_DIGITALOCEAN_REGION: " nyc3 ",
      AGENTBAY_DIGITALOCEAN_SIZE_SLUG: " s-2vcpu-2gb ",
      AGENTBAY_DIGITALOCEAN_IMAGE: " ubuntu-24-04-x64 ",
      AGENTBAY_RUNNER_IMAGE: ` ${HOSTED_RUNNER_IMAGE} `,
      AGENTBAY_HERMES_WORKLOAD_IMAGE: " ghcr.io/ametel01/agentbay-hermes:sha-123 ",
      AGENTBAY_HERMES_STATE_ROOT: " /var/lib/agentbay/custom-agents ",
      AGENTBAY_HERMES_PRIVATE_NETWORK: " agentbay-custom-hermes ",
      AGENTBAY_HERMES_READINESS_TIMEOUT_MS: "240000",
      AGENTBAY_RUNNER_MAX_AGENTS: "1",
      AGENTBAY_DIGITALOCEAN_TAGS: "runner, agentbay, runner",
      AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5, 2001:db8::/64",
    });

    expect(config).toEqual({
      token: "dop_v1_test_token",
      providerMode: "digitalocean",
      runnerBearerToken: "runner-command-token",
      runnerImage: HOSTED_RUNNER_IMAGE,
      hermesWorkloadImage: "ghcr.io/ametel01/agentbay-hermes:sha-123",
      hermesStateRoot: "/var/lib/agentbay/custom-agents",
      hermesPrivateNetwork: "agentbay-custom-hermes",
      hermesReadinessTimeoutMs: 240_000,
      runnerMaxAgents: 1,
      region: "nyc3",
      sizeSlug: "s-2vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "runner"],
      sshSourceAddresses: ["2001:db8::/64", "203.0.113.5/32"],
    });
  });

  it("parses local Docker provider mode for manual cloud-runner smoke tests", () => {
    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "local_docker",
        AGENTBAY_DIGITALOCEAN_TOKEN: "local-docker",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: "agentbay-runner:local",
        AGENTBAY_LOCAL_CLOUD_RUNNER_ENDPOINT_URL: "http://host.docker.internal:3045",
        AGENTBAY_LOCAL_CLOUD_RUNNER_CONTAINER_NAME: "agentbay-local-cloud-runner",
        AGENTBAY_LOCAL_CLOUD_RUNNER_START_DELAY_MS: "0",
      }),
    ).toMatchObject({
      token: "local-docker",
      providerMode: "local_docker",
      runnerBearerToken: "runner-command-token",
      runnerImage: "agentbay-runner:local",
      localRunnerEndpointUrl: "http://host.docker.internal:3045",
      localRunnerContainerName: "agentbay-local-cloud-runner",
      localRunnerStartDelayMs: 0,
    });
  });

  it("parses DigitalOcean SSH access configuration for Droplet creation", () => {
    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "52830696, c3:2a:31",
        AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/32, 2001:db8::/64",
      }),
    ).toMatchObject({
      sshKeyIds: ["52830696", "c3:2a:31"],
      sshSourceAddresses: ["2001:db8::/64", "203.0.113.5/32"],
    });

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "auto",
      }),
    ).not.toHaveProperty("sshKeyIds");

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "none",
      }),
    ).toMatchObject({ sshKeyIds: [] });
  });

  it("requires explicit public SSH source access opt-in", () => {
    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
      }),
    ).toMatchObject({ sshSourceAddresses: [] });

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "true",
      }),
    ).toMatchObject({ sshSourceAddresses: ["0.0.0.0/0", "::/0"] });

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: HOSTED_RUNNER_IMAGE,
        AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "false",
      }),
    ).toMatchObject({ sshSourceAddresses: [] });
  });

  it("rejects malformed cloud runner provider settings without echoing raw values", () => {
    const invalidRunnerImage = "ghcr.io/ametel01/agentbay-runner:latest;rm";

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: invalidRunnerImage,
      }),
    ).toThrow("AGENTBAY_RUNNER_IMAGE must be a valid container image reference");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_HERMES_WORKLOAD_IMAGE: "ghcr.io/ametel01/agentbay-hermes:latest;rm",
      }),
    ).toThrow("AGENTBAY_HERMES_WORKLOAD_IMAGE must be a valid container image reference");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_HERMES_STATE_ROOT: "../agentbay",
      }),
    ).toThrow("AGENTBAY_HERMES_STATE_ROOT must be an absolute runtime path");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_HERMES_PRIVATE_NETWORK: "agentbay hermes",
      }),
    ).toThrow("AGENTBAY_HERMES_PRIVATE_NETWORK must be a Docker network name");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_HERMES_READINESS_TIMEOUT_MS: "0",
      }),
    ).toThrow("AGENTBAY_HERMES_READINESS_TIMEOUT_MS must be a positive integer");

    try {
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: invalidRunnerImage,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect(String(error)).not.toContain(invalidRunnerImage);
    }

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_REGION: "nyc 3",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_REGION must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SIZE_SLUG: "s/1vcpu",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_SIZE_SLUG must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_IMAGE: "ubuntu,24",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_IMAGE must be a DigitalOcean slug");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_TAGS: "agentbay,pre beta",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_TAGS entries must not contain whitespace");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "52830696, bad key",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS entries must not contain whitespace");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS: "example.com",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must be valid");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/33",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS entries must use a valid");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "yes",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS: "203.0.113.5/32",
        AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH: "yes",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH must be true");
  });

  it("rejects blank DigitalOcean provider configuration", () => {
    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: " ",
      }),
    ).toThrowError(EnvValidationError);

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_RUNNER_IMAGE: " ",
      }),
    ).toThrow("AGENTBAY_RUNNER_IMAGE cannot be blank when DigitalOcean is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_REGION: " ",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_REGION cannot be blank when DigitalOcean is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: " ",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS cannot be blank when set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
      }),
    ).toThrow("AGENTBAY_RUNNER_BEARER_TOKEN is required when DigitalOcean provisioning is set.");

    expect(() =>
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_PROVIDER_MODE: "fake",
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
      }),
    ).toThrow("AGENTBAY_DIGITALOCEAN_PROVIDER_MODE must be digitalocean or local_docker");
  });

  it("keeps DigitalOcean provider tokens out of shared validation and client components", async () => {
    await expect(readFile("src/env/validation.ts", "utf8")).resolves.not.toContain(
      "AGENTBAY_DIGITALOCEAN_TOKEN",
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

      expect(source).not.toContain("AGENTBAY_DIGITALOCEAN");
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
