import { describe, expect, it } from "vitest";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import {
  evaluateFounderGoogleMailSendingRelease,
  FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_SCHEMA,
} from "@/src/server/operators/founder-google-mail-sending-release";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REVISION = "d".repeat(40);

function environment(overrides: Record<string, unknown> = {}) {
  const value = JSON.parse(buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION)) as Record<
    string,
    unknown
  >;
  return {
    VERCEL_GIT_COMMIT_SHA: REVISION,
    BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify({
      ...value,
      ...overrides,
    }),
  };
}

describe("Founder Google Mail Sending release evidence", () => {
  it("releases only from a complete exact-revision record", () => {
    expect(evaluateFounderGoogleMailSendingRelease(environment(), NOW)).toMatchObject({
      released: true,
      evidence: { capability: "gmail_sending", sourceRevision: REVISION },
    });
  });

  it("rejects missing, stale, failed, mismatched, and partial records", () => {
    expect(evaluateFounderGoogleMailSendingRelease({}, NOW)).toEqual({
      released: false,
      reason: "connected_acceptance_missing",
    });
    expect(
      evaluateFounderGoogleMailSendingRelease(environment({ outcome: "failed" }), NOW),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
    expect(
      evaluateFounderGoogleMailSendingRelease(environment({ sourceRevision: "e".repeat(40) }), NOW),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
    expect(
      evaluateFounderGoogleMailSendingRelease(environment({ expiresAt: NOW.toISOString() }), NOW),
    ).toMatchObject({ released: false, reason: "connected_acceptance_stale" });

    const partial = JSON.parse(buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION)) as {
      gates: Record<string, boolean>;
    };
    delete partial.gates.exactlyOneCopy;
    expect(
      evaluateFounderGoogleMailSendingRelease(
        {
          VERCEL_GIT_COMMIT_SHA: REVISION,
          BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(partial),
        },
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
  });

  it("requires the sending grant to match the immutable reading identity", () => {
    expect(
      evaluateFounderGoogleMailSendingRelease(
        environment({ sendingIdentityDigest: `sha256:${"9".repeat(64)}` }),
        NOW,
      ),
    ).toMatchObject({ released: false, reason: "connected_acceptance_mismatch" });
  });

  it("keeps the schema stable and binds test evidence to the candidate revision", () => {
    expect(FOUNDER_GOOGLE_MAIL_SENDING_ACCEPTANCE_SCHEMA).toBe(
      "bruno.founder-google-mail-sending-connected-acceptance.v1",
    );
    expect(JSON.parse(buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION))).toMatchObject({
      sourceRevision: REVISION,
      operatorReleaseRevision: REVISION,
    });
  });
});
