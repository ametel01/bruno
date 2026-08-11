import { describe, expect, it } from "vitest";
import { buildCloudRunnerBootstrapContent } from "@/src/server/runners/cloud-runner-bootstrap";
import {
  LocalDockerDigitalOceanProvider,
  localDockerRunnerBootstrapFailureCode,
} from "@/src/server/runners/local-docker-digitalocean-provider";

describe("local Docker DigitalOcean provider", () => {
  it("runs generated cloud runner bootstrap user-data inside a local Ubuntu droplet simulator", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      agentSmokeMode: true,
      containerName: "bruno-local-cloud-runner-test",
      endpointUrl: "http://host.docker.internal:3045",
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "http://host.docker.internal:3000",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      commandBearerToken: "runner-command-token",
      endpointDiscovery: { type: "digitalocean_metadata" },
      runnerImage: "bruno-runner:local",
      runnerName: "Bruno Cloud Runner",
    });

    const created = await provider.createRunner({
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-2gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
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
    expect(dockerCalls[0]).toEqual(["rm", "--force", "--volumes", "bruno-local-cloud-runner-test"]);
    expect(dockerCalls[1]).toEqual(["rm", "--force", "bruno-runner"]);
    expect(dockerCalls[2]?.slice(0, 21)).toEqual([
      "run",
      "--detach",
      "--platform",
      "linux/amd64",
      "--name",
      "bruno-local-cloud-runner-test",
      "--cpus",
      "1",
      "--memory",
      "2048m",
      "--privileged",
      "--cgroupns",
      "host",
      "--volume",
      "/var/lib/docker",
      "--publish",
      "127.0.0.1:3045:3045",
      "--volume",
      "/tmp/bruno-local-agent-smoke/images.tar:/opt/bruno/images.tar:ro",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
    expect(dockerCalls[2]).not.toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(dockerCalls[2]).toContain("bruno-local-droplet:ubuntu-24.04");
    expect(dockerCalls[2]).toContain(
      "BRUNO_LOCAL_RUNNER_ENDPOINT_URL=http://host.docker.internal:3045",
    );
    expect(dockerCalls[2]).toContain("DOCKER_DEFAULT_PLATFORM=linux/amd64");

    const bootstrapScriptEnv = dockerCalls[2]?.find((arg) =>
      arg.startsWith("BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64="),
    );
    expect(bootstrapScriptEnv).toBeDefined();

    const bootstrapScript = Buffer.from(
      bootstrapScriptEnv?.replace("BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64=", "") ?? "",
      "base64",
    ).toString("utf8");

    expect(bootstrapScript).not.toContain("apt-get install");
    expect(bootstrapScript).toContain(
      "dockerd --host=unix:///var/run/docker.sock --storage-driver=overlay2",
    );
    expect(bootstrapScript).toContain("/usr/bin/docker load --input /opt/bruno/images.tar");
    expect(bootstrapScript).toContain(
      "getent ahostsv4 host.docker.internal | awk 'NR == 1 { print $1 }'",
    );
    expect(bootstrapScript).toContain(
      "169.254.169.254/metadata/v1/interfaces/public/0/ipv4/address",
    );
    expect(bootstrapScript).toContain(
      `if [[ "${"$"}{1:-}" == "pull" && ( "${"$"}{2:-}" == "bruno-runner:local" || "${"$"}{2:-}" == "bruno-hermes:local" || "${"$"}{2:-}" == "busybox:1.36" ) ]]; then`,
    );
    expect(bootstrapScript).toContain('exec /usr/bin/docker "$@"');
    expect(bootstrapScript).toContain(
      'translated=("run" "--add-host" "host.docker.internal:$host_gateway")',
    );
    expect(bootstrapScript).toContain("BRUNO_BOOTSTRAP_STEP=docker_pull");
    expect(bootstrapScript).toContain("BRUNO_BOOTSTRAP_STEP=agent_image_pull");
    expect(bootstrapScript).toContain("BRUNO_BOOTSTRAP_STEP=hermes_image_pull");
    expect(bootstrapScript).toContain("BRUNO_BOOTSTRAP_STEP=runner_container_start");
    expect(bootstrapScript).toContain(
      "/usr/local/bin/bruno-bootstrap-event bootstrapping started 'Installing cloud runner packages.' package_install",
    );
    expect(bootstrapScript).toContain(
      "/usr/local/bin/bruno-bootstrap-event bootstrapping completed 'Cloud runner packages were already installed in the local smoke image.' package_install",
    );
    expect(bootstrapScript).toContain("for attempt in 1 2 3; do");
    expect(bootstrapScript).toContain(
      "Local cloud-init parity check failed: /etc/bruno/runner.env was not created.",
    );
    expect(bootstrapScript).toContain("https://.sslip.io");
    expect(bootstrapScript).toContain(
      `sed -i "s#^BRUNO_RUNNER_ENDPOINT_URL=.*#BRUNO_RUNNER_ENDPOINT_URL=${"$"}{BRUNO_LOCAL_RUNNER_ENDPOINT_URL}#" /etc/bruno/runner.env`,
    );
    expect(bootstrapScript).toContain("docker run --detach --name");
    expect(bootstrapScript).toContain("bruno-runner");
    expect(bootstrapScript).toContain("--restart always --network");
    expect(bootstrapScript).toContain("--env-file");
    expect(bootstrapScript).toContain("/etc/bruno/runner.env");
    expect(bootstrapScript).toContain("BRUNO_RUNNER_MAX_AGENTS=1");
    expect(bootstrapScript).toContain("BRUNO_LOCAL_AGENT_SMOKE_MODE=synthetic-external-boundaries");
    expect(bootstrapScript).toContain("docker network create");
    expect(bootstrapScript).toContain("hermes_image_pull");
    expect(bootstrapScript).toContain(
      "BRUNO_HERMES_WORKLOAD_IMAGE=nousresearch/hermes-agent:v2026.7.7.2@sha256",
    );
    expect(bootstrapScript).toContain("/var/lib/bruno/agents:/var/lib/bruno/agents");
    expect(bootstrapScript).toContain("/var/lib/bruno/boot-self-test");
    expect(bootstrapScript).not.toContain('translated_source="$bridge_dir$source_path"');
    expect(bootstrapScript).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(bootstrapScript).toContain("127.0.0.1:3045:3045");
    expect(bootstrapScript).toContain("bruno-runner:local");
    expect(bootstrapScript).toContain("BRUNO_RUNNER_ENV_FILE=/etc/bruno/runner.env");
    expect(bootstrapScript).toContain("bash -lc");
    expect(dockerCalls[2]).not.toContain("bruno-runner:local");
    expect(dockerCalls[2]?.at(-1)).toContain("exec tail --follow /dev/null");
  });

  it("preserves production swap setup while keeping it outside the local Docker simulator", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      containerName: "bruno-local-cloud-runner-test",
      endpointUrl: "http://host.docker.internal:3045",
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });
    const content = buildCloudRunnerBootstrapContent({
      appBaseUrl: "http://host.docker.internal:3000",
      registrationToken: "bruno_reg_1234567890123456789012345678901234567890123",
      commandBearerToken: "runner-command-token",
      endpointDiscovery: { type: "digitalocean_metadata" },
      enableSwap: true,
      runnerImage: "bruno-runner:local",
      runnerName: "Bruno Cloud Runner",
    });

    await provider.createRunner({
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
      userData: content.userData,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const bootstrapScriptEnv = dockerCalls[2]?.find((arg) =>
      arg.startsWith("BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64="),
    );
    const bootstrapScript = Buffer.from(
      bootstrapScriptEnv?.replace("BRUNO_LOCAL_CLOUD_INIT_SCRIPT_B64=", "") ?? "",
      "base64",
    ).toString("utf8");

    expect(content.userData).toContain("BRUNO_BOOTSTRAP_STEP=swap_setup");
    expect(content.userData).toContain("fallocate -l 1G /swapfile");
    expect(content.userData).toContain("mkswap /swapfile");
    expect(bootstrapScript).toContain("Local cloud simulation skips host swap activation.");
    expect(bootstrapScript).not.toContain("fallocate -l 1G /swapfile");
    expect(bootstrapScript).not.toContain("mkswap /swapfile");
    expect(bootstrapScript).not.toContain("swapon /swapfile");
    expect(bootstrapScript).toContain("Docker Desktop");
    expect(bootstrapScript).toContain(
      "network inspect --format '{{(index .IPAM.Config 0).Gateway}}'",
    );
    expect(bootstrapScript).toContain(
      'translated+=("run" "--add-host" "host.docker.internal:$host_gateway")',
    );
  });

  it("classifies only closed runner bootstrap diagnostics", () => {
    expect(
      localDockerRunnerBootstrapFailureCode(
        "exited",
        "bruno runner bootstrap failed: registration_failed",
      ),
    ).toBe("runner_registration_failed");
    expect(
      localDockerRunnerBootstrapFailureCode(
        "restarting",
        "error: ConnectionRefused while fetching the callback",
      ),
    ).toBe("runner_callback_unreachable");
    expect(localDockerRunnerBootstrapFailureCode("running", "private untrusted output")).toBe(
      "runner_running_without_registration",
    );
    expect(localDockerRunnerBootstrapFailureCode("unknown", "private untrusted output")).toBeNull();
  });

  it("removes the droplet simulator and production-named runner during cleanup", async () => {
    const dockerCalls: string[][] = [];
    const provider = new LocalDockerDigitalOceanProvider({
      containerName: "bruno-local-cloud-runner-test",
      startDelayMs: 0,
      docker: async (args) => {
        dockerCalls.push([...args]);
        return { stdout: "ok\n", stderr: "" };
      },
    });

    await provider.createRunner({
      name: "Bruno Cloud Runner",
      region: "sfo3",
      sizeSlug: "s-1vcpu-512mb-10gb",
      image: "ubuntu-24-04-x64",
      tags: ["bruno"],
    });

    const cleaned = await provider.cleanupResource({
      providerResourceId: "local-docker-droplet",
    });

    expect(cleaned).toMatchObject({ ok: true, value: { deletedAt: expect.any(String) } });
    expect(dockerCalls).toEqual([
      ["rm", "--force", "bruno-local-cloud-runner-test"],
      ["rm", "--force", "bruno-runner"],
    ]);
  });

  it("uses a stable unique firewall identity for each simulated Droplet session", async () => {
    const createSession = async () => {
      const provider = new LocalDockerDigitalOceanProvider({
        docker: async () => ({ stdout: "ok\n", stderr: "" }),
      });
      await provider.createRunner({
        name: "Bruno Cloud Runner",
        region: "sfo3",
        sizeSlug: "s-1vcpu-512mb-10gb",
        image: "ubuntu-24-04-x64",
        tags: ["bruno"],
      });
      return provider;
    };
    const firstProvider = await createSession();
    const first = await firstProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "bruno-runners-local-docker-droplet",
      sshSourceAddresses: [],
    });
    const replay = await firstProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "bruno-runners-local-docker-droplet",
      sshSourceAddresses: [],
    });
    const secondProvider = await createSession();
    const second = await secondProvider.applyFirewall({
      providerResourceId: "local-docker-droplet",
      firewallName: "bruno-runners-local-docker-droplet",
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
