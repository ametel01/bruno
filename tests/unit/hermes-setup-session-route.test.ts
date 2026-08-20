import { describe, expect, it } from "vitest";
import { POST } from "@/app/api/agents/[agentId]/hermes-setup-session/route";

describe("legacy agent Hermes setup route", () => {
  it("does not expose a terminal outside Founder Troubleshooting", async () => {
    const response = await POST(
      new Request(
        "http://localhost/api/agents/00000000-0000-4000-8000-000000000123/hermes-setup-session",
        { method: "POST" },
      ),
      { params: Promise.resolve({ agentId: "00000000-0000-4000-8000-000000000123" }) },
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "troubleshooting_required" },
    });
  });
});
