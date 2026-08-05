import { describe, expect, it } from "vitest";
import { buildCloudRunnerBootstrapContent } from "@/src/server/runners/cloud-runner-bootstrap";
import { LocalDockerDigitalOceanProvider } from "@/src/server/runners/local-docker-digitalocean-provider";

describe("local Docker DigitalOcean provider", () => {
  it("runs generated cloud runner bootstrap user-data inside a local Ubuntu droplet simulator", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      containerName: "agentbay-local-cloud-runner-test",
      endpointUrl: "http://host.docker.internal:3045",
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "http://host.docker.internal:3000",
      registrationToken: "agb_reg_1234567890123456789012345678901234567890123",
      commandBearerToken: "runner-command-token",
      endpointDiscovery: { type: "digitalocean_metadata" },
      runnerImage: "agentbay-runner:local",
      runnerName: "plingpling Cloud Runner",
    });

    const created = await provider.createRunner({
      name: "plingpling Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay"],
      userData: content.userData,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toMatchObject({
      ok: true,
      value: {
        provider: "digitalocean",
        providerResourceId: "local-docker-droplet",
        publicEndpointUrl: "http://host.docker.internal:3045",
        publicIpv4: null,
      },
    });
    expect(dockerCalls[0]).toEqual(["rm", "--force", "agentbay-local-cloud-runner-test"]);
    expect(dockerCalls[1]).toEqual(["rm", "--force", "agentbay-runner"]);
    expect(dockerCalls[2]?.slice(0, 14)).toEqual([
      "run",
      "--detach",
      "--platform",
      "linux/amd64",
      "--name",
      "agentbay-local-cloud-runner-test",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    expect(dockerCalls[2]).toContain("ubuntu:24.04");
    expect(dockerCalls[2]).toContain(
      "AGENTBAY_LOCAL_RUNNER_ENDPOINT_URL=http://host.docker.internal:3045",
    );
    expect(dockerCalls[2]).toContain("DOCKER_DEFAULT_PLATFORM=linux/amd64");

    const bootstrapScriptEnv = dockerCalls[2]?.find((arg) =>
      arg.startsWith("AGENTBAY_LOCAL_CLOUD_INIT_SCRIPT_B64="),
    );
    expect(bootstrapScriptEnv).toBeDefined();

    const bootstrapScript = Buffer.from(
      bootstrapScriptEnv?.replace("AGENTBAY_LOCAL_CLOUD_INIT_SCRIPT_B64=", "") ?? "",
      "base64",
    ).toString("utf8");

    expect(bootstrapScript).toContain("apt-get install -y bash ca-certificates curl gnupg python3");
    expect(bootstrapScript).toContain(
      "169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address",
    );
    expect(bootstrapScript).toContain(
      `if [[ "${"$"}{1:-}" == "pull" && "${"$"}{2:-}" == "agentbay-runner:local" ]]; then`,
    );
    expect(bootstrapScript).toContain('exec /usr/bin/docker "$@"');
    expect(bootstrapScript).toContain(
      'translated+=("run" "--add-host" "host.docker.internal:host-gateway")',
    );
    expect(bootstrapScript).toContain("AGENTBAY_BOOTSTRAP_STEP=docker_container_start");
    expect(bootstrapScript).toContain(
      "Local cloud-init parity check failed: /etc/agentbay/runner.env was not created.",
    );
    expect(bootstrapScript).toContain("https://.sslip.io");
    expect(bootstrapScript).toContain(
      `sed -i "s#^AGENTBAY_RUNNER_ENDPOINT_URL=.*#AGENTBAY_RUNNER_ENDPOINT_URL=${"$"}{AGENTBAY_LOCAL_RUNNER_ENDPOINT_URL}#" /etc/agentbay/runner.env`,
    );
    expect(bootstrapScript).toContain("docker run --detach --name");
    expect(bootstrapScript).toContain("agentbay-runner");
    expect(bootstrapScript).toContain("--restart always --network");
    expect(bootstrapScript).toContain("--env-file");
    expect(bootstrapScript).toContain("/etc/agentbay/runner.env");
    expect(bootstrapScript).toContain("AGENTBAY_RUNNER_MAX_AGENTS=1");
    expect(bootstrapScript).toContain("docker network create");
    expect(bootstrapScript).toContain("hermes_image_pull");
    expect(bootstrapScript).toContain(
      "AGENTBAY_HERMES_WORKLOAD_IMAGE=nousresearch/hermes-agent:v2026.7.7.2@sha256",
    );
    expect(bootstrapScript).toContain("/var/lib/agentbay/agents:/var/lib/agentbay/agents");
    expect(bootstrapScript).toContain("/var/lib/agentbay/boot-self-test");
    expect(bootstrapScript).toContain('translated_source="$bridge_dir$source_path"');
    expect(bootstrapScript).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(bootstrapScript).toContain("127.0.0.1:3045:3045");
    expect(bootstrapScript).toContain("agentbay-runner:local");
    expect(bootstrapScript).toContain("AGENTBAY_RUNNER_ENV_FILE=/etc/agentbay/runner.env");
    expect(bootstrapScript).toContain("bash -lc");
    expect(dockerCalls[2]).not.toContain("agentbay-runner:local");
  });

  it("removes the droplet simulator and production-named runner during cleanup", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      containerName: "agentbay-local-cloud-runner-test",
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await provider.createRunner({
      name: "plingpling Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["agentbay"],
    });

    const cleaned = await provider.cleanupResource({
      providerResourceId: "local-docker-droplet",
    });

    expect(cleaned).toMatchObject({ ok: true, value: { deletedAt: expect.any(String) } });
    expect(dockerCalls).toEqual([
      ["rm", "--force", "agentbay-local-cloud-runner-test"],
      ["rm", "--force", "agentbay-runner"],
    ]);
  });

  it("uses a stable unique firewall identity for each simulated Droplet session", async () => {
    const createSession = async () => {
      const provider = new LocalDockerDigitalOceanProvider({
        docker: async () => ({ stdout: "ok\n", stderr: "" }),
      });
      await provider.createRunner({
        name: "plingpling Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        tags: ["agentbay"],
      });
      return provider;
    };
    const firstProvider = await createSession();
    const first = await firstProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "agentbay-runners-local-docker-droplet",
      sshSourceAddresses: [],
    });
    const replay = await firstProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "agentbay-runners-local-docker-droplet",
      sshSourceAddresses: [],
    });
    const secondProvider = await createSession();
    const second = await secondProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "agentbay-runners-local-docker-droplet",
      sshSourceAddresses: [],
    });

    expect(first.ok && first.value.providerFirewallId).toMatch(
      /^local-docker-firewall-[0-9a-f-]{36}$/,
    );
    expect(replay.ok && replay.value.providerFirewallId).toBe(
      first.ok ? first.value.providerFirewallId : null,
    );
    expect(second.ok && second.value.providerFirewallId).not.toBe(
      first.ok ? first.value.providerFirewallId : null,
    );
  });
});
