import { describe, expect, it, vi } from "vitest";
import { importFounderGeneralReleaseDecision } from "@/scripts/import-founder-general-release-decision";

const OWNER_ID = "00000000-0000-4000-8000-000000000387";
const NOW = new Date("2026-08-23T08:00:00.000Z");

describe("protected Initial General Release Decision import", () => {
  it("passes the selected sanitized artifact to the mapped-Owner persistence boundary", async () => {
    const readArtifact = vi.fn(async () => "sanitized-complete-decision");
    const persistDecision = vi.fn(async () => "00000000-0000-4000-8000-000000000389");
    const env = { BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID: OWNER_ID };

    await expect(
      importFounderGeneralReleaseDecision("/protected/decision.json", {
        env,
        now: () => NOW,
        readArtifact: readArtifact as never,
        persistDecision,
      }),
    ).resolves.toBe("00000000-0000-4000-8000-000000000389");
    expect(readArtifact).toHaveBeenCalledWith("/protected/decision.json", "utf8");
    expect(persistDecision).toHaveBeenCalledWith(OWNER_ID, "sanitized-complete-decision", {
      env,
      now: NOW,
    });
  });

  it("rejects a missing or non-UUID Owner before reading the artifact", async () => {
    const readArtifact = vi.fn();
    await expect(
      importFounderGeneralReleaseDecision("decision.json", {
        env: {},
        readArtifact: readArtifact as never,
      }),
    ).rejects.toThrow("BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID is required");
    await expect(
      importFounderGeneralReleaseDecision("decision.json", {
        env: { BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID: "not-an-owner" },
        readArtifact: readArtifact as never,
      }),
    ).rejects.toThrow("must be a UUID");
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
