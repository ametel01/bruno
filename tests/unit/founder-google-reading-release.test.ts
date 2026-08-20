import { describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import {
  evaluateFounderGoogleCalendarRelease,
  evaluateFounderGoogleMailReadingRelease,
  FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_SCHEMA,
} from "@/src/server/operators/founder-google-reading-release";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REVISION = "d".repeat(40);

function environment(
  capability: "calendar_reading" | "gmail_reading",
  overrides: Record<string, unknown> = {},
) {
  const value = JSON.parse(
    buildTestGoogleConnectedAcceptanceRelease(capability, NOW, REVISION),
  ) as Record<string, unknown>;
  return {
    VERCEL_GIT_COMMIT_SHA: REVISION,
    [capability === "calendar_reading"
      ? "BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE"
      : "BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE"]: JSON.stringify({
      ...value,
      ...overrides,
    }),
  };
}

describe("Founder Google reading release evidence", () => {
  it("releases Calendar and Gmail only from their own complete exact-revision records", () => {
    expect(
      evaluateFounderGoogleCalendarRelease(environment("calendar_reading"), NOW),
    ).toMatchObject({ released: true, evidence: { capability: "calendar_reading" } });
    expect(
      evaluateFounderGoogleMailReadingRelease(environment("gmail_reading"), NOW),
    ).toMatchObject({ released: true, evidence: { capability: "gmail_reading" } });
  });

  it("does not let one capability's acceptance release its sibling", () => {
    const calendarOnly = environment("calendar_reading");
    const mailOnly = environment("gmail_reading");

    expect(evaluateFounderGoogleMailReadingRelease(calendarOnly, NOW)).toEqual({
      released: false,
      reason: "connected_acceptance_missing",
    });
    expect(evaluateFounderGoogleCalendarRelease(mailOnly, NOW)).toEqual({
      released: false,
      reason: "connected_acceptance_missing",
    });
  });

  it("rejects missing, stale, failed, mismatched, and partial records", () => {
    expect(evaluateFounderGoogleCalendarRelease({}, NOW)).toEqual({
      released: false,
      reason: "connected_acceptance_missing",
    });
    expect(
      evaluateFounderGoogleCalendarRelease(
        environment("calendar_reading", { outcome: "failed" }),
        NOW,
      ),
    ).toMatchObject({ released: false });
    expect(
      evaluateFounderGoogleCalendarRelease(
        environment("calendar_reading", { sourceRevision: "e".repeat(40) }),
        NOW,
      ),
    ).toMatchObject({ released: false });
    expect(
      evaluateFounderGoogleCalendarRelease(
        environment("calendar_reading", { expiresAt: NOW.toISOString() }),
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_stale" });

    const mail = JSON.parse(
      buildTestGoogleConnectedAcceptanceRelease("gmail_reading", NOW, REVISION),
    ) as { gates: Record<string, boolean> };
    delete mail.gates.restrictedScopeVerification;
    expect(
      evaluateFounderGoogleMailReadingRelease(
        {
          VERCEL_GIT_COMMIT_SHA: REVISION,
          BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(mail),
        },
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
  });

  it("keeps the schema stable and binds test evidence to the candidate revision", () => {
    expect(FOUNDER_GOOGLE_CONNECTED_ACCEPTANCE_SCHEMA).toBe(
      "bruno.founder-google-connected-acceptance.v1",
    );
    expect(
      JSON.parse(buildTestGoogleConnectedAcceptanceRelease("calendar_reading", NOW, REVISION)),
    ).toMatchObject({ sourceRevision: REVISION, operatorReleaseRevision: REVISION });
  });
});
