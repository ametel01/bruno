import { afterEach, describe, expect, it, vi } from "vitest";
import { createDigitalOceanSdkClient } from "@/src/server/runners/digitalocean-sdk-runtime";

describe("DigitalOcean SDK runtime adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads and deletes the exact encoded firewall resource", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        requests.push({ method, url });

        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : Response.json({
              firewall: {
                id: "firewall/owned",
                name: "bruno-runners-owned",
                droplet_ids: [7654321],
              },
            });
      }),
    );

    const client = createDigitalOceanSdkClient("dop_v1_not_logged", "https://provider.test/v2");
    const firewall = client.v2.firewalls.byFirewall_id?.("firewall/owned");
    if (!firewall) throw new Error("Expected exact firewall SDK methods.");

    await expect(firewall.get()).resolves.toMatchObject({
      firewall: { id: "firewall/owned", droplet_ids: [7654321] },
    });
    await expect(firewall.delete()).resolves.toBeUndefined();

    expect(requests).toEqual([
      { method: "GET", url: "https://provider.test/v2/firewalls/firewall%2Fowned" },
      { method: "DELETE", url: "https://provider.test/v2/firewalls/firewall%2Fowned" },
    ]);
    expect(JSON.stringify(requests)).not.toContain("dop_v1_not_logged");
  });
});
