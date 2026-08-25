import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/operator/external-beta-manifest/route";

describe("Founder External Beta manifest route", () => {
  it("returns a no-store nontechnical projection for the authenticated Founder", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/external-beta-manifest"),
      undefined,
      {
        requireApplicationUser: async () => ({
          ok: true as const,
          userId: "00000000-0000-4000-8000-000000003770",
        }),
        getManifest: async () => ({
          stage: "external_beta",
          cohort: "external-beta-contract",
          applicationRevision: "a".repeat(40),
          runtimeRevision: "runtime-v1",
          complete: false,
          qualifiedCapabilities: [
            "anthropic",
            "calendar_reading",
            "gmail_reading",
            "gmail_sending",
          ],
          unavailableCapabilities: ["openai"],
          safeWorkCheckpointsPreserved: true,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      externalBeta: {
        stage: "External Beta",
        state: "limited",
        providerChoice: "Connect OpenAI, Anthropic, or both",
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /cohort|model|credential|runner|hermes|digest|revision/i,
    );
  });

  it("fails closed without exposing why qualification is unavailable", async () => {
    const response = await GET(
      new Request("http://localhost/api/operator/external-beta-manifest"),
      undefined,
      {
        requireApplicationUser: async () => ({
          ok: true as const,
          userId: "00000000-0000-4000-8000-000000003770",
        }),
        getManifest: async () => {
          throw new Error("raw evidence mismatch");
        },
      },
    );
    await expect(response.json()).resolves.toMatchObject({
      externalBeta: { state: "waiting" },
    });
  });
});
