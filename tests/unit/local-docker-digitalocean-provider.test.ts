import { describe, expect, it } from "vitest";
import { buildCloudRunnerBootstrapContent } from "@/src/server/runners/cloud-runner-bootstrap";
import { LocalDockerDigitalOceanProvider } from "@/src/server/runners/local-docker-digitalocean-provider";

describe("local Docker DigitalOcean provider", () => {
  it("starts the runner image from generated cloud runner bootstrap user-data", async () => {
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
      runnerName: "AgentBay Cloud Runner",
    });

    const created = await provider.createRunner({
      name: "AgentBay Cloud Runner",
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
    expect(dockerCalls[1]).toEqual([
      "run",
      "--detach",
      "--name",
      "agentbay-local-cloud-runner-test",
      "--restart",
      "unless-stopped",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "-p",
      "0.0.0.0:3045:3045",
      "-v",
      "/var/run/docker.sock:/var/run/docker.sock",
      "--env",
      "AGENTBAY_APP_URL=http://host.docker.internal:3000",
      "--env",
      "AGENTBAY_RUNNER_REGISTRATION_TOKEN=agb_reg_1234567890123456789012345678901234567890123",
      "--env",
      "AGENTBAY_RUNNER_ENDPOINT_URL=http://host.docker.internal:3045",
      "--env",
      "AGENTBAY_RUNNER_NAME=AgentBay Cloud Runner",
      "--env",
      "AGENTBAY_RUNNER_IMAGE=agentbay-runner:local",
      "--env",
      "AGENTBAY_RUNNER_ENV_FILE=/tmp/agentbay-runner.env",
      "--env",
      "AGENTBAY_RUNNER_BEARER_TOKEN=runner-command-token",
      "--env",
      "AGENTBAY_RUNNER_HOST=0.0.0.0",
      "--env",
      "AGENTBAY_RUNNER_PORT=3045",
      "--env",
      "AGENTBAY_RUNNER_HEARTBEAT_INTERVAL_MS=1000",
      "agentbay-runner:local",
    ]);
  });
});
