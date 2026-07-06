import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvValidationError } from "@/src/env/validation";
import { readDigitalOceanProviderConfig } from "@/src/server/env";

describe("server-only provider environment validation", () => {
  it("returns null when DigitalOcean provisioning is not configured", () => {
    expect(readDigitalOceanProviderConfig({})).toBeNull();
  });

  it("validates DigitalOcean token and non-secret provisioning defaults on the server path", () => {
    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
      }),
    ).toMatchObject({
      runnerBearerToken: "runner-command-token",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "agentbay-runner"],
      sshSourceAddresses: ["0.0.0.0/0", "::/0"],
    });

    const config = readDigitalOceanProviderConfig({
      AGENTBAY_DIGITALOCEAN_TOKEN: " dop_v1_test_token ",
      AGENTBAY_RUNNER_BEARER_TOKEN: " runner-command-token ",
      AGENTBAY_DIGITALOCEAN_REGION: " nyc3 ",
      AGENTBAY_DIGITALOCEAN_SIZE_SLUG: " s-2vcpu-2gb ",
      AGENTBAY_DIGITALOCEAN_IMAGE: " ubuntu-24-04-x64 ",
      AGENTBAY_DIGITALOCEAN_TAGS: "runner, agentbay, runner",
    });

    expect(config).toEqual({
      token: "dop_v1_test_token",
      runnerBearerToken: "runner-command-token",
      region: "nyc3",
      sizeSlug: "s-2vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay", "runner"],
      sshSourceAddresses: ["0.0.0.0/0", "::/0"],
    });
  });

  it("parses DigitalOcean SSH access configuration for Droplet creation", () => {
    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
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
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "auto",
      }),
    ).not.toHaveProperty("sshKeyIds");

    expect(
      readDigitalOceanProviderConfig({
        AGENTBAY_DIGITALOCEAN_TOKEN: "dop_v1_test_token",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-command-token",
        AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS: "none",
      }),
    ).toMatchObject({ sshKeyIds: [] });
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
