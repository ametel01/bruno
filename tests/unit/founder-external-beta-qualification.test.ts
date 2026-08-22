import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestAnthropicAcceptanceRelease } from "@/scripts/founder-anthropic-test-release";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderPreviewQualifications } from "@/src/server/db/schema";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  type FounderExternalBetaQualificationError,
  requireFounderExternalBetaQualifications,
} from "@/src/server/founder-product-contract/external-beta-qualification";
import {
  getFounderExternalBetaManifest,
  persistFounderExternalBetaQualificationsInTransaction,
  projectFounderExternalBetaManifestStatus,
} from "@/src/server/founder-product-contract/external-beta-manifest";

const NOW = new Date("2026-08-23T06:00:00.000Z");
const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "external-beta-runtime-v1";
const COHORT = `external-beta-test-${randomUUID()}`;

describe("External Beta exact-candidate qualification", () => {
  it("requires five independent capabilities before exposing the complete manifest", () => {
    const qualifications = requireFounderExternalBetaQualifications(candidate(), environment());

    expect(qualifications.map(({ capability }) => capability)).toEqual(
      FOUNDER_EXTERNAL_BETA_CAPABILITIES,
    );
    expect(new Set(qualifications.map(({ evidenceDigest }) => evidenceDigest))).toHaveLength(5);
  });

  it.each([
    ["missing", {}, "qualification_missing"],
    [
      "malformed",
      { ...environment(), BRUNO_EXTERNAL_BETA_QUALIFICATIONS: "{" },
      "qualification_malformed",
    ],
    [
      "mismatched",
      environment({ applicationRevision: "b".repeat(40) }),
      "qualification_mismatched",
    ],
    [
      "expired",
      environment({ capability: "anthropic", expiresAt: NOW.toISOString() }),
      "qualification_expired",
    ],
    [
      "stale",
      environment({
        capability: "openai",
        observedAt: new Date(NOW.valueOf() - 10 * 24 * 60 * 60 * 1_000).toISOString(),
      }),
      "qualification_stale",
    ],
  ])("denies the complete manifest when qualification is %s", (_name, env, code) => {
    expect(() => requireFounderExternalBetaQualifications(candidate(), env)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("never lets AI providers or Gmail capabilities borrow sibling evidence", () => {
    expect(() =>
      requireFounderExternalBetaQualifications(
        candidate(),
        environment({
          capability: "anthropic",
          evidenceDigest: `sha256:${"c".repeat(64)}`,
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<FounderExternalBetaQualificationError>>({
        code: "qualification_mismatched",
      }),
    );
    expect(() =>
      requireFounderExternalBetaQualifications(
        candidate(),
        environment({
          capability: "gmail_sending",
          evidenceDigest: `sha256:${"7".repeat(64)}`,
        }),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<FounderExternalBetaQualificationError>>({
        code: "qualification_mismatched",
      }),
    );
  });

  it("denies all five when a required capability is omitted or duplicated", () => {
    const env = environment();
    const value = JSON.parse(env.BRUNO_EXTERNAL_BETA_QUALIFICATIONS ?? "") as {
      qualifications: Array<Record<string, unknown>>;
    };
    value.qualifications[4] = { ...value.qualifications[3] };
    expect(() =>
      requireFounderExternalBetaQualifications(candidate(), {
        ...env,
        BRUNO_EXTERNAL_BETA_QUALIFICATIONS: JSON.stringify(value),
      }),
    ).toThrowError(expect.objectContaining({ code: "qualification_malformed" }));
  });
});

describe("persisted External Beta manifest", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await deleteTestQualifications(connection);
  });

  afterEach(async () => {
    await deleteTestQualifications(connection);
    await connection.close();
  });

  it("persists independent records idempotently and degrades only the expired capability", async () => {
    const qualifications = requireFounderExternalBetaQualifications(candidate(), environment()).map(
      (qualification) =>
        qualification.capability === "openai"
          ? {
              ...qualification,
              expiresAt: new Date(NOW.valueOf() + 60 * 60 * 1_000).toISOString(),
            }
          : qualification,
    );
    await connection.db.transaction((tx) =>
      persistFounderExternalBetaQualificationsInTransaction(tx, qualifications, NOW),
    );
    await connection.db.transaction((tx) =>
      persistFounderExternalBetaQualificationsInTransaction(tx, qualifications, NOW),
    );

    const current = await getFounderExternalBetaManifest(candidate(), {
      createConnection: () => connection,
    });
    expect(current).toMatchObject({
      complete: true,
      qualifiedCapabilities: FOUNDER_EXTERNAL_BETA_CAPABILITIES,
      unavailableCapabilities: [],
    });

    const degraded = await getFounderExternalBetaManifest(
      { ...candidate(), now: new Date(NOW.valueOf() + 2 * 60 * 60 * 1_000) },
      { createConnection: () => connection },
    );
    expect(degraded.complete).toBe(false);
    expect(degraded.qualifiedCapabilities).toEqual([
      "anthropic",
      "calendar_reading",
      "gmail_reading",
      "gmail_sending",
    ]);
    expect(degraded.unavailableCapabilities).toEqual(["openai"]);
    expect(degraded.safeWorkCheckpointsPreserved).toBe(true);
  });

  it("fails closed when a persisted row has an over-long qualification window", async () => {
    await connection.db.insert(founderPreviewQualifications).values({
      stage: "external_beta",
      cohort: COHORT,
      capability: "openai",
      applicationRevision: REVISION,
      runtimeRevision: RUNTIME_REVISION,
      evidenceDigest: `sha256:${"c".repeat(64)}`,
      observedAt: NOW,
      expiresAt: new Date(NOW.valueOf() + 9 * 24 * 60 * 60 * 1_000),
      createdAt: NOW,
    });

    const manifest = await getFounderExternalBetaManifest(candidate(), {
      createConnection: () => connection,
    });

    expect(manifest.qualifiedCapabilities).toEqual([]);
    expect(manifest.unavailableCapabilities).toContain("openai");
  });

  it("rejects an over-long qualification window at the persistence boundary", async () => {
    const qualifications = requireFounderExternalBetaQualifications(candidate(), environment()).map(
      (qualification) =>
        qualification.capability === "openai"
          ? {
              ...qualification,
              expiresAt: new Date(NOW.valueOf() + 9 * 24 * 60 * 60 * 1_000).toISOString(),
            }
          : qualification,
    );

    await expect(
      connection.db.transaction((tx) =>
        persistFounderExternalBetaQualificationsInTransaction(tx, qualifications, NOW),
      ),
    ).rejects.toThrow("External Beta qualification manifest is incomplete or inconsistent.");
  });

  it("projects only nontechnical Founder-readable status", () => {
    const status = projectFounderExternalBetaManifestStatus({
      complete: false,
      qualifiedCapabilities: ["anthropic", "calendar_reading", "gmail_reading", "gmail_sending"],
      unavailableCapabilities: ["openai"],
    });
    expect(status).toMatchObject({
      stage: "External Beta",
      state: "limited",
      providerChoice: "Connect OpenAI, Anthropic, or both",
      capacityBoundary: "Uses only your connected provider accounts",
    });
    expect(JSON.stringify(status)).not.toMatch(
      /model|credential|token|runner|hermes|digest|revision/i,
    );
  });
});

async function deleteTestQualifications(connection: DatabaseConnection): Promise<void> {
  await connection.db
    .delete(founderPreviewQualifications)
    .where(eq(founderPreviewQualifications.cohort, COHORT));
}

function candidate() {
  return {
    cohort: COHORT,
    applicationRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    now: NOW,
  };
}

function environment(
  qualificationOverride: Record<string, unknown> & { capability?: string } = {},
): Record<string, string | undefined> {
  const openai = withEvidence(
    JSON.parse(buildTestOpenAiConnectedAcceptanceRelease(NOW, REVISION)),
    "c",
  );
  const anthropic = withEvidence(
    JSON.parse(buildTestAnthropicAcceptanceRelease(NOW, REVISION)),
    "5",
  );
  const calendar = withEvidence(
    JSON.parse(buildTestGoogleConnectedAcceptanceRelease("calendar_reading", NOW, REVISION)),
    "6",
  );
  const mail = withEvidence(
    JSON.parse(buildTestGoogleConnectedAcceptanceRelease("gmail_reading", NOW, REVISION)),
    "7",
  );
  const sending = withEvidence(
    JSON.parse(buildTestGoogleMailSendingAcceptanceRelease(NOW, REVISION)),
    "2",
  );
  const evidence = {
    openai,
    anthropic,
    calendar_reading: calendar,
    gmail_reading: mail,
    gmail_sending: sending,
  };
  const qualifications = FOUNDER_EXTERNAL_BETA_CAPABILITIES.map((capability) => ({
    schemaVersion: "bruno.preview-qualification.v1",
    outcome: "passed",
    stage: "external_beta",
    cohort: COHORT,
    capability,
    applicationRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    evidenceDigest: evidence[capability].evidenceDigest,
    observedAt: evidence[capability].qualifiedAt,
    expiresAt: evidence[capability].expiresAt,
    ...(qualificationOverride.capability === undefined ||
    qualificationOverride.capability === capability
      ? qualificationOverride
      : {}),
  }));
  return {
    VERCEL_GIT_COMMIT_SHA: REVISION,
    BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(openai),
    BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(anthropic),
    BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(calendar),
    BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(mail),
    BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE: JSON.stringify(sending),
    BRUNO_EXTERNAL_BETA_QUALIFICATIONS: JSON.stringify({
      schemaVersion: "bruno.external-beta-qualifications.v1",
      cohort: COHORT,
      qualifications,
    }),
  };
}

function withEvidence(
  value: Record<string, unknown>,
  digit: string,
): Record<string, unknown> & { evidenceDigest: string; qualifiedAt: string; expiresAt: string } {
  if (typeof value.qualifiedAt !== "string" || typeof value.expiresAt !== "string") {
    throw new Error("Test release time is invalid.");
  }
  return {
    ...value,
    evidenceDigest: `sha256:${digit.repeat(64)}`,
    qualifiedAt: value.qualifiedAt,
    expiresAt: value.expiresAt,
  };
}
