import { createHash } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { buildTestAnthropicAcceptanceRelease } from "@/scripts/founder-anthropic-test-release";
import { buildTestGoogleMailSendingAcceptanceRelease } from "@/scripts/founder-google-mail-sending-test-release";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { createDatabaseConnection } from "@/src/server/db/client";
import {
  founderGeneralReleaseActivations,
  founderReleaseDecisions,
  operatorCalendarConnections,
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorPrimaryCommunicationsSuites,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  persistProtectedFounderGeneralReleaseDecisionForOwner,
  readFounderGeneralReleaseAuthority,
  readPersistedFounderGeneralReleaseAuthorityInTransaction,
} from "@/src/server/founder-product-contract/general-release-authority";
import {
  confirmFounderGeneralReleaseEligibility,
  createFounderGeneralReleaseOperator,
  founderGeneralReleaseSetupAuthorizesInTransaction,
  getFounderGeneralReleaseActivationForUser,
  hasFounderGeneralReleaseSetupAccessForUser,
} from "@/src/server/founder-product-contract/initial-general-release";
import { buildDeterministicFounderGeneralReleaseAuthorityFixture } from "@/src/testing/founder-general-release-authority";

const OWNER_ID = "00000000-0000-4000-8000-000000000387";
const APPLICANT_ID = "00000000-0000-4000-8000-000000000388";
const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-387";
const NOW = new Date("2026-08-23T08:00:00.000Z");

describe("Initial General Release global authority", () => {
  it("strictly binds the protected artifact to the exact deployed candidate", () => {
    const raw = decisionArtifact(NOW);
    expect(readFounderGeneralReleaseAuthority({ ...releasedEnvironment(NOW) }, NOW)).toMatchObject({
      approved: false,
      reason: "decision_missing",
    });
    expect(
      readFounderGeneralReleaseAuthority(
        {
          ...releasedEnvironment(NOW),
          BRUNO_INITIAL_GENERAL_RELEASE_DECISION: raw,
          VERCEL_GIT_COMMIT_SHA: "b".repeat(40),
        },
        NOW,
      ),
    ).toMatchObject({ approved: false, reason: "application_revision_mismatch" });
    expect(
      readFounderGeneralReleaseAuthority(
        { ...releasedEnvironment(NOW), BRUNO_INITIAL_GENERAL_RELEASE_DECISION: raw },
        new Date(NOW.valueOf() + 9 * 24 * 60 * 60 * 1_000),
      ),
    ).toMatchObject({ approved: false, reason: "decision_stale" });
    const reused = JSON.parse(raw) as Record<string, unknown>;
    const reusedEvidence = reused.evidence as Record<string, unknown>;
    reusedEvidence.privacyDigest = reusedEvidence.operationalDigest;
    expect(
      readFounderGeneralReleaseAuthority(
        {
          ...releasedEnvironment(NOW),
          BRUNO_INITIAL_GENERAL_RELEASE_DECISION: recomputeSummaryDigest(reused),
        },
        NOW,
      ),
    ).toMatchObject({ approved: false, reason: "decision_invalid" });
  });

  it("imports only through the mapped Owner seam and persists an idempotent global decision", async () => {
    const connection = createDatabaseConnection();
    try {
      await seedUsers(connection);
      const raw = decisionArtifact(NOW);
      const dependencies = {
        createConnection: () => connection,
        env: releasedEnvironment(NOW),
        now: NOW,
      };
      const decisionId = await persistProtectedFounderGeneralReleaseDecisionForOwner(
        OWNER_ID,
        raw,
        dependencies,
      );
      await expect(
        persistProtectedFounderGeneralReleaseDecisionForOwner(OWNER_ID, raw, dependencies),
      ).resolves.toBe(decisionId);
      await expect(
        persistProtectedFounderGeneralReleaseDecisionForOwner(APPLICANT_ID, raw, dependencies),
      ).rejects.toThrow("restricted to the mapped Bruno.Ai Owner");

      expect(await connection.db.select().from(founderReleaseDecisions)).toEqual([
        expect.objectContaining({
          id: decisionId,
          userId: null,
          operatorId: null,
          stage: "initial_general_release",
          outcome: "enter",
          applicationRevision: REVISION,
          runtimeRevision: RUNTIME_REVISION,
          capabilityManifest: [
            "openai",
            "anthropic",
            "calendar_reading",
            "gmail_reading",
            "gmail_sending",
          ],
        }),
      ]);
    } finally {
      await reset(connection);
    }
  });

  it("binds admission, retains scoped Holds, and requires an explicit fresh resume", async () => {
    const connection = createDatabaseConnection();
    try {
      await seedUsers(connection);
      const enterId = await persistProtectedFounderGeneralReleaseDecisionForOwner(
        OWNER_ID,
        decisionArtifact(NOW),
        { createConnection: () => connection, env: releasedEnvironment(NOW), now: NOW },
      );
      await confirmFounderGeneralReleaseEligibility(
        {
          userId: APPLICANT_ID,
          serviceBusinessConfirmed: true,
          geographyCode: "PH",
          now: NOW,
        },
        { createConnection: () => connection, env: releasedEnvironment(NOW) },
      );
      expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
        expect.objectContaining({ userId: APPLICANT_ID, releaseDecisionId: enterId }),
      ]);
      const [applicantOperator] = await connection.db
        .select({ id: operators.id })
        .from(operators)
        .where(eq(operators.userId, APPLICANT_ID));
      if (!applicantOperator) throw new Error("Applicant Operator fixture is unavailable.");
      const [calendarConnection] = await connection.db
        .insert(operatorCalendarConnections)
        .values({
          operatorId: applicantOperator.id,
          providerSubjectId: "google-sub-general-release",
          accountLabel: "founder@example.test",
          status: "ready",
          authorizationState: "authorized",
          accessTokenCiphertext: "calendar-ciphertext",
          accessTokenIv: "calendar-iv",
          accessTokenAuthTag: "calendar-tag",
          refreshTokenCiphertext: "calendar-refresh-ciphertext",
          refreshTokenIv: "calendar-refresh-iv",
          refreshTokenAuthTag: "calendar-refresh-tag",
          secretKeyVersion: "test-v1",
          lastVerifiedAt: NOW,
          lastEvidenceAt: NOW,
          evidenceState: "current",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      if (!calendarConnection) throw new Error("Applicant Calendar fixture is unavailable.");
      const [mailConnection] = await connection.db
        .insert(operatorMailConnections)
        .values({
          operatorId: applicantOperator.id,
          providerSubjectId: "google-sub-general-release",
          accountLabel: "founder@example.test",
          status: "ready",
          authorizationState: "authorized",
          accessTokenCiphertext: "mail-ciphertext",
          accessTokenIv: "mail-iv",
          accessTokenAuthTag: "mail-tag",
          refreshTokenCiphertext: "mail-refresh-ciphertext",
          refreshTokenIv: "mail-refresh-iv",
          refreshTokenAuthTag: "mail-refresh-tag",
          secretKeyVersion: "test-v1",
          suiteStatus: "matched",
          lastVerifiedAt: NOW,
          lastEvidenceAt: NOW,
          evidenceState: "current",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .returning();
      if (!mailConnection) throw new Error("Applicant Mail fixture is unavailable.");
      await connection.db.insert(operatorPrimaryCommunicationsSuites).values({
        operatorId: applicantOperator.id,
        calendarConnectionId: calendarConnection.id,
        mailConnectionId: mailConnection.id,
        providerSubjectId: "google-sub-general-release",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
      });
      await connection.db.insert(operatorMailSendingConnections).values({
        operatorId: applicantOperator.id,
        mailConnectionId: mailConnection.id,
        status: "ready",
        authorizationState: "authorized",
        providerSubjectId: "google-sub-general-release",
        accountLabel: "founder@example.test",
        accessTokenCiphertext: "ciphertext",
        accessTokenIv: "iv",
        accessTokenAuthTag: "tag",
        refreshTokenCiphertext: "refresh-ciphertext",
        refreshTokenIv: "refresh-iv",
        refreshTokenAuthTag: "refresh-tag",
        secretKeyVersion: "test-v1",
        tokenExpiresAt: new Date(NOW.valueOf() + 60_000),
        grantedScopes: ["https://www.googleapis.com/auth/gmail.send"],
        authorizedAt: NOW,
        lastVerifiedAt: NOW,
      });
      await expect(
        getFounderGeneralReleaseActivationForUser(APPLICANT_ID, {
          createConnection: () => connection,
          env: releasedEnvironment(NOW),
          now: () => NOW,
        }),
      ).resolves.toMatchObject({
        release: {
          qualified: true,
          decisionState: "approved",
          sending: "On only after each Founder approves it",
        },
      });
      await connection.db
        .update(operatorMailSendingConnections)
        .set({ tokenExpiresAt: NOW })
        .where(eq(operatorMailSendingConnections.operatorId, applicantOperator.id));
      await expect(
        getFounderGeneralReleaseActivationForUser(APPLICANT_ID, {
          createConnection: () => connection,
          env: releasedEnvironment(NOW),
          now: () => NOW,
        }),
      ).resolves.toMatchObject({ release: { sending: "Off" } });
      await connection.db
        .update(operatorMailSendingConnections)
        .set({ tokenExpiresAt: new Date(NOW.valueOf() + 60_000) })
        .where(eq(operatorMailSendingConnections.operatorId, applicantOperator.id));
      await expect(
        hasFounderGeneralReleaseSetupAccessForUser(
          APPLICANT_ID,
          {
            createConnection: () => connection,
            env: releasedEnvironment(NOW),
            now: () => NOW,
          },
          ["openai"],
        ),
      ).resolves.toBe(true);
      await expect(
        hasFounderGeneralReleaseSetupAccessForUser(
          APPLICANT_ID,
          {
            createConnection: () => connection,
            env: releasedEnvironment(NOW),
            now: () => new Date(NOW.valueOf() + 9 * 24 * 60 * 60 * 1_000),
          },
          ["openai"],
        ),
      ).resolves.toBe(false);

      const heldEnvironment = {
        ...releasedEnvironment(NOW),
        BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE: undefined,
      };
      const [held, concurrentHeld] = await Promise.all(
        [connection, createDatabaseConnection()].map(async (candidateConnection, index) => {
          try {
            return await candidateConnection.db.transaction((tx) =>
              readPersistedFounderGeneralReleaseAuthorityInTransaction(tx, heldEnvironment, NOW, {
                reconcileHold: true,
              }),
            );
          } finally {
            if (index > 0) await candidateConnection.close();
          }
        }),
      );
      expect(held).toMatchObject({
        approved: true,
        decisionOutcome: "hold",
        heldCapabilities: ["gmail_sending"],
      });
      expect(concurrentHeld).toMatchObject({
        approved: true,
        decisionOutcome: "hold",
        heldCapabilities: ["gmail_sending"],
      });
      await expect(
        getFounderGeneralReleaseActivationForUser(APPLICANT_ID, {
          createConnection: () => connection,
          env: heldEnvironment,
          now: () => NOW,
        }),
      ).resolves.toMatchObject({
        release: { qualified: false, decisionState: "held", sending: "Off" },
        setup: { canCreate: false },
      });
      await expect(
        connection.db.transaction((tx) =>
          founderGeneralReleaseSetupAuthorizesInTransaction(
            tx,
            APPLICANT_ID,
            NOW,
            ["openai"],
            heldEnvironment,
          ),
        ),
      ).resolves.toBe(true);
      await expect(
        connection.db.transaction((tx) =>
          founderGeneralReleaseSetupAuthorizesInTransaction(
            tx,
            APPLICANT_ID,
            NOW,
            ["gmail_sending"],
            heldEnvironment,
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        confirmFounderGeneralReleaseEligibility(
          {
            userId: OWNER_ID,
            serviceBusinessConfirmed: true,
            geographyCode: "PH",
            now: NOW,
          },
          { createConnection: () => connection, env: heldEnvironment },
        ),
      ).rejects.toMatchObject({ code: "general_release_hold", status: 503 });

      const later = new Date(NOW.valueOf() + 60_000);
      const beforeResume = await connection.db
        .select()
        .from(founderReleaseDecisions)
        .orderBy(asc(founderReleaseDecisions.decidedAt));
      expect(beforeResume.map((decision) => decision.outcome)).toEqual(["enter", "hold"]);
      expect(held).toMatchObject({
        decisionId: beforeResume[1]?.id,
        decisionDecidedAt: beforeResume[1]?.decidedAt.toISOString(),
        evidenceDigests: beforeResume[1]?.evidenceDigests,
      });
      expect(concurrentHeld).toMatchObject({
        decisionId: beforeResume[1]?.id,
        decisionDecidedAt: beforeResume[1]?.decidedAt.toISOString(),
        evidenceDigests: beforeResume[1]?.evidenceDigests,
      });
      await expect(
        persistProtectedFounderGeneralReleaseDecisionForOwner(OWNER_ID, decisionArtifact(NOW), {
          createConnection: () => connection,
          env: releasedEnvironment(later),
          now: later,
        }),
      ).rejects.toThrow("A Hold requires a fresh complete Initial General Release Decision");
      expect(
        (await connection.db.select().from(founderReleaseDecisions)).map(
          (decision) => decision.outcome,
        ),
      ).toEqual(["enter", "hold"]);
      await expect(
        persistProtectedFounderGeneralReleaseDecisionForOwner(OWNER_ID, decisionArtifact(later), {
          createConnection: () => connection,
          env: releasedEnvironment(later),
          now: later,
        }),
      ).rejects.toThrow("A Hold requires a fresh complete Initial General Release Decision");
      await expect(
        persistProtectedFounderGeneralReleaseDecisionForOwner(
          OWNER_ID,
          partiallyFreshDecisionArtifact(later),
          {
            createConnection: () => connection,
            env: releasedEnvironment(later),
            now: later,
          },
        ),
      ).rejects.toThrow("A Hold requires a fresh complete Initial General Release Decision");
      const resumeId = await persistProtectedFounderGeneralReleaseDecisionForOwner(
        OWNER_ID,
        freshDecisionArtifact(later),
        {
          createConnection: () => connection,
          env: releasedEnvironment(later),
          now: later,
        },
      );
      const afterResume = await connection.db
        .select()
        .from(founderReleaseDecisions)
        .orderBy(asc(founderReleaseDecisions.decidedAt));
      expect(afterResume.map((decision) => decision.outcome)).toEqual(["enter", "hold", "resume"]);
      expect(afterResume[1]).toMatchObject({ affectedCapabilities: ["gmail_sending"] });
      await expect(
        getFounderGeneralReleaseActivationForUser(APPLICANT_ID, {
          createConnection: () => connection,
          env: releasedEnvironment(later),
          now: () => later,
        }),
      ).resolves.toMatchObject({
        release: { qualified: false, decisionState: "denied", sending: "Off" },
        setup: { requiresReleaseReconfirmation: true, canCreate: false },
      });
      await confirmFounderGeneralReleaseEligibility(
        {
          userId: APPLICANT_ID,
          serviceBusinessConfirmed: true,
          geographyCode: "PH",
          now: later,
        },
        { createConnection: () => connection, env: releasedEnvironment(later) },
      );
      expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
        expect.objectContaining({ userId: APPLICANT_ID, releaseDecisionId: resumeId }),
      ]);
    } finally {
      await reset(connection);
    }
  });

  it("leaves pre-authority activation rows unbound and unable to inherit a decision", async () => {
    const connection = createDatabaseConnection();
    try {
      await seedUsers(connection);
      const [operator] = await connection.db
        .select()
        .from(operators)
        .where(eq(operators.userId, APPLICANT_ID));
      if (!operator) throw new Error("Applicant Operator fixture is unavailable.");
      await connection.db.insert(founderGeneralReleaseActivations).values({
        userId: APPLICANT_ID,
        operatorId: operator.id,
        status: "setup",
        serviceBusinessConfirmedAt: NOW,
        geographyCode: "PH",
        admissionState: "eligible",
        admissionReason: "Legacy unbound fixture.",
        publishedPriceLabel: "$30/month",
        capacityObservedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
      await persistProtectedFounderGeneralReleaseDecisionForOwner(OWNER_ID, decisionArtifact(NOW), {
        createConnection: () => connection,
        env: releasedEnvironment(NOW),
        now: NOW,
      });
      await expect(
        connection.db.transaction((tx) =>
          founderGeneralReleaseSetupAuthorizesInTransaction(
            tx,
            APPLICANT_ID,
            NOW,
            ["openai"],
            releasedEnvironment(NOW),
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        hasFounderGeneralReleaseSetupAccessForUser(
          APPLICANT_ID,
          {
            createConnection: () => connection,
            env: releasedEnvironment(NOW),
            now: () => NOW,
          },
          ["openai"],
        ),
      ).resolves.toBe(false);
      await expect(
        createFounderGeneralReleaseOperator(
          { userId: APPLICANT_ID, now: NOW },
          { createConnection: () => connection, env: releasedEnvironment(NOW) },
        ),
      ).rejects.toMatchObject({ code: "general_release_decision_required" });
      await expect(
        getFounderGeneralReleaseActivationForUser(APPLICANT_ID, {
          createConnection: () => connection,
          env: releasedEnvironment(NOW),
          now: () => NOW,
        }),
      ).resolves.toMatchObject({
        release: { qualified: false, decisionState: "denied" },
        setup: { canCreate: false },
      });
      expect(await connection.db.select().from(founderGeneralReleaseActivations)).toEqual([
        expect.objectContaining({ userId: APPLICANT_ID, releaseDecisionId: null }),
      ]);
    } finally {
      await reset(connection);
    }
  });
});

function decisionArtifact(decidedAt: Date): string {
  return buildDeterministicFounderGeneralReleaseAuthorityFixture({
    sourceRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    decidedAt,
  });
}

function freshDecisionArtifact(decidedAt: Date): string {
  const value = JSON.parse(decisionArtifact(decidedAt)) as Record<string, unknown>;
  const evidence = value.evidence as Record<string, unknown>;
  for (const key of Object.keys(evidence)) {
    evidence[key] = `sha256:${createHash("sha256")
      .update(`fresh-initial-general-release:${key}:${decidedAt.toISOString()}`)
      .digest("hex")}`;
  }
  return recomputeSummaryDigest(value);
}

function partiallyFreshDecisionArtifact(decidedAt: Date): string {
  const value = JSON.parse(decisionArtifact(decidedAt)) as Record<string, unknown>;
  const evidence = value.evidence as Record<string, unknown>;
  evidence.operationalDigest = `sha256:${createHash("sha256")
    .update(`fresh-but-incomplete:${decidedAt.toISOString()}`)
    .digest("hex")}`;
  return recomputeSummaryDigest(value);
}

function recomputeSummaryDigest(value: Record<string, unknown>): string {
  const { summaryDigest: _summaryDigest, ...payload } = value;
  return JSON.stringify({
    ...payload,
    summaryDigest: `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`,
  });
}

function releasedEnvironment(now: Date): Record<string, string | undefined> {
  return {
    VERCEL_GIT_COMMIT_SHA: REVISION,
    BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION: RUNTIME_REVISION,
    BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY: "open",
    BRUNO_INITIAL_GENERAL_RELEASE_GEOGRAPHIES: "PH",
    BRUNO_INITIAL_GENERAL_RELEASE_PRICE_LABEL: "$30/month",
    BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
      now,
      REVISION,
    ),
    BRUNO_ANTHROPIC_CONNECTED_ACCEPTANCE_RELEASE: buildTestAnthropicAcceptanceRelease(
      now,
      REVISION,
    ),
    BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
      "calendar_reading",
      now,
      REVISION,
    ),
    BRUNO_GOOGLE_MAIL_READING_CONNECTED_ACCEPTANCE_RELEASE:
      buildTestGoogleConnectedAcceptanceRelease("gmail_reading", now, REVISION),
    BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE:
      buildTestGoogleMailSendingAcceptanceRelease(now, REVISION),
  };
}

async function seedUsers(connection: ReturnType<typeof createDatabaseConnection>): Promise<void> {
  await connection.db.insert(users).values([{ id: OWNER_ID }, { id: APPLICANT_ID }]);
  await connection.db.insert(operators).values([{ userId: OWNER_ID }, { userId: APPLICANT_ID }]);
}

async function reset(connection: ReturnType<typeof createDatabaseConnection>): Promise<void> {
  await connection.client.unsafe("truncate table app_metadata restart identity cascade");
  await connection.client.unsafe("truncate table users restart identity cascade");
  await connection.client.unsafe(
    "truncate table founder_release_decisions restart identity cascade",
  );
  await connection.close();
}
