import { randomUUID } from "node:crypto";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestGoogleConnectedAcceptanceRelease } from "@/scripts/founder-google-test-release";
import { buildTestOpenAiConnectedAcceptanceRelease } from "@/scripts/founder-openai-test-release";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  appMetadata,
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
  operatorPreparations,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import { EncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY } from "@/src/server/founder-product-contract/owner-preview-release-decision";
import { createDurableRecoveryArchive } from "@/src/server/founder-product-contract/recovery-archive";
import { getFounderOwnerPreviewAccessForUser } from "@/src/server/founder-product-contract/release-stage-access";
import { persistFounderOwnerPreviewHoldInTransaction } from "@/src/server/founder-product-contract/release-stage-hold";
import {
  admitFounderToTrustedPreview,
  enterFounderTrustedPreviewStage,
  issueFounderTrustedPreviewInvitation,
} from "@/src/server/founder-product-contract/trusted-preview-admission";
import {
  assessFounderTrustedPreviewPromotionEvidenceForCohort,
  FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
} from "@/src/server/founder-product-contract/trusted-preview-promotion";
import {
  FOUNDER_TRUSTED_PREVIEW_COHORT_LOCK_KEY,
  persistFounderTrustedPreviewStageHoldInTransaction,
} from "@/src/server/founder-product-contract/trusted-preview-release-decision";
import { withFounderOwnerPreviewWorkAuthority } from "@/src/server/founder-product-contract/work-authority";

const OWNER_ID = "00000000-0000-4000-8000-000000003760";
const OWNER_OPERATOR_ID = "00000000-0000-4000-8000-000000003761";
const PARTICIPANTS = [
  {
    userId: "00000000-0000-4000-8000-000000003762",
    operatorId: "00000000-0000-4000-8000-000000003763",
    clerk: "user_trusted_preview_1",
  },
  {
    userId: "00000000-0000-4000-8000-000000003764",
    operatorId: "00000000-0000-4000-8000-000000003765",
    clerk: "user_trusted_preview_2",
  },
  {
    userId: "00000000-0000-4000-8000-000000003766",
    operatorId: "00000000-0000-4000-8000-000000003767",
    clerk: "user_trusted_preview_3",
  },
  {
    userId: "00000000-0000-4000-8000-000000003768",
    operatorId: "00000000-0000-4000-8000-000000003769",
    clerk: "user_trusted_preview_4",
  },
] as const;
const APPLICATION_REVISION = "7".repeat(40);
const START = new Date("2026-08-23T00:00:00.000Z");
const EXPIRES_AT = new Date(START.valueOf() + 7 * 24 * 60 * 60 * 1_000);
const ENV = {
  BRUNO_AUTH_MODE: "clerk",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_trusted_preview",
  CLERK_SECRET_KEY: "sk_test_trusted_preview",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  VERCEL_GIT_COMMIT_SHA: APPLICATION_REVISION,
};

describe("Trusted Preview admission authority", () => {
  let connection: DatabaseConnection;
  let provider: EncryptedFounderRecoveryArchiveProvider;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    provider = new EncryptedFounderRecoveryArchiveProvider({
      storage: new FakeBackupObjectStorage("trusted-preview-test"),
      masterKey: new Uint8Array(32).fill(76),
    });
    await reset(connection);
    await seedReadyCandidate(connection, OWNER_ID, OWNER_OPERATOR_ID, "user_preview_owner");
    for (const participant of PARTICIPANTS) {
      await seedReadyCandidate(
        connection,
        participant.userId,
        participant.operatorId,
        participant.clerk,
      );
    }
    await connection.db.insert(appMetadata).values({
      key: FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY,
      value: OWNER_ID,
      updatedAt: START,
    });
    await insertOwnerPreviewDecision(connection);
    await insertStageDecision(connection, "enter", START);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("serializes three identity-bound slots and denies Clerk-only or cross-identity access", async () => {
    await expect(
      issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: "user_preview_owner",
          serviceBusinessEvidenceDigest: digest(9),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => "O".repeat(43),
          env: ENV,
          now: () => START,
        },
      ),
    ).rejects.toThrow("Owner cannot occupy a trusted-contact cohort slot");

    const tokens: string[] = [];
    for (const [index, participant] of PARTICIPANTS.slice(0, 3).entries()) {
      const token = String.fromCharCode(65 + index).repeat(43);
      const invitation = await issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: participant.clerk,
          serviceBusinessEvidenceDigest: digest(index + 1),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => token,
          env: ENV,
          now: () => START,
        },
      );
      expect(invitation).toEqual({ invitationToken: token, cohortSlot: index + 1 });
      tokens.push(token);
    }

    await expect(
      issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: PARTICIPANTS[3].clerk,
          serviceBusinessEvidenceDigest: digest(4),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => "D".repeat(43),
          env: ENV,
          now: () => START,
        },
      ),
    ).rejects.toThrow("Trusted Preview is limited to three contacts.");

    const clerkOnly = await getFounderOwnerPreviewAccessForUser(PARTICIPANTS[3].userId, START, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
    });
    expect(clerkOnly).toEqual({
      admitted: false,
      availableCapabilities: [],
      stage: "trusted_preview",
    });

    await expect(
      admitFounderToTrustedPreview(PARTICIPANTS[1].userId, tokens[0] ?? "", {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => START,
      }),
    ).rejects.toThrow("valid invitation for this Clerk identity");

    await expect(
      admitFounderToTrustedPreview(PARTICIPANTS[0].userId, tokens[0] ?? "", {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => START,
      }),
    ).resolves.toMatchObject({ cohortSlot: 1 });
    await expect(
      admitFounderToTrustedPreview(PARTICIPANTS[1].userId, tokens[1] ?? "", {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => START,
      }),
    ).resolves.toMatchObject({ cohortSlot: 2 });

    const firstAccess = await getFounderOwnerPreviewAccessForUser(PARTICIPANTS[0].userId, START, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
    });
    const secondAccess = await getFounderOwnerPreviewAccessForUser(PARTICIPANTS[1].userId, START, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
    });
    expect(firstAccess).toEqual({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
      stage: "trusted_preview",
      cohortSlot: 1,
    });
    expect(secondAccess).toEqual({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
      stage: "trusted_preview",
      cohortSlot: 2,
    });
  });

  it("derives promotion participants only from persisted admitted cohort authority", async () => {
    const tokens = ["P".repeat(43), "Q".repeat(43)] as const;
    for (const [index, participant] of PARTICIPANTS.slice(0, 2).entries()) {
      await issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: participant.clerk,
          serviceBusinessEvidenceDigest: digest(20 + index),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => tokens[index] ?? "",
          env: ENV,
          now: () => START,
        },
      );
      await admitFounderToTrustedPreview(participant.userId, tokens[index] ?? "", {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => START,
      });
    }
    const admitted = await connection.db
      .select({
        userId: founderTrustedPreviewInvitations.participantUserId,
        operatorId: founderTrustedPreviewInvitations.participantOperatorId,
        activeDecisionId: founderTrustedPreviewInvitations.admissionDecisionId,
        admittedAt: founderTrustedPreviewInvitations.admittedAt,
      })
      .from(founderTrustedPreviewInvitations)
      .where(eq(founderTrustedPreviewInvitations.status, "admitted"))
      .orderBy(asc(founderTrustedPreviewInvitations.cohortSlot));
    const observedAt = new Date(START.valueOf() + 10_000);
    const evidence = trustedPromotionEvidence(admitted);

    await expect(
      assessFounderTrustedPreviewPromotionEvidenceForCohort({
        value: evidence,
        cohortOwnerUserId: OWNER_ID,
        applicationRevision: APPLICATION_REVISION,
        observedAt,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      promotionEligible: true,
      completedParticipants: 2,
      founderAcceptanceEligible: false,
      automaticPromotion: false,
    });

    const fabricated = structuredClone(evidence);
    const firstParticipant = fabricated.participants[0];
    if (!firstParticipant) throw new Error("Expected persisted participant evidence.");
    firstParticipant.userId = PARTICIPANTS[2].userId;
    await expect(
      assessFounderTrustedPreviewPromotionEvidenceForCohort({
        value: fabricated,
        cohortOwnerUserId: OWNER_ID,
        applicationRevision: APPLICATION_REVISION,
        observedAt,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      promotionEligible: false,
      completedParticipants: 1,
      reasons: expect.arrayContaining([
        "admitted_attended_participant_required",
        "two_completed_participants_required",
      ]),
    });
  });

  it("enters the cohort only from exact Owner learning and cohort qualification", async () => {
    await connection.db
      .delete(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.stage, "trusted_preview"));
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: OWNER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const [ownerDecision] = await connection.db
      .select({ id: founderReleaseDecisions.id, decidedAt: founderReleaseDecisions.decidedAt })
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.stage, "owner_preview"));
    if (!ownerDecision) throw new Error("Expected Owner Preview decision.");
    const qualifiedAt = new Date(START.valueOf() - 60 * 60 * 1_000);
    const result = await enterFounderTrustedPreviewStage(OWNER_ID, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
      env: {
        ...ENV,
        BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
          START,
          APPLICATION_REVISION,
        ),
        BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE:
          buildTestGoogleConnectedAcceptanceRelease(
            "calendar_reading",
            START,
            APPLICATION_REVISION,
          ),
        BRUNO_TRUSTED_PREVIEW_QUALIFICATIONS: JSON.stringify({
          schemaVersion: "bruno.trusted-preview-qualifications.v1",
          qualifications: ["openai", "calendar_reading"].map((capability, index) => ({
            schemaVersion: "bruno.trusted-preview-qualification.v1",
            outcome: "passed",
            audience: "trusted_cohort",
            cohortOwnerUserId: OWNER_ID,
            operatorId: OWNER_OPERATOR_ID,
            stage: "trusted_preview",
            applicationRevision: APPLICATION_REVISION,
            runtimeRevision: "runtime-owner",
            capability,
            qualifiedAt: qualifiedAt.toISOString(),
            expiresAt: new Date(qualifiedAt.valueOf() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
            evidenceDigest: digest(50 + index),
            gates: {
              safeAuthorization: true,
              realUse: true,
              recovery: true,
              revocation: true,
              providerDisclosure: true,
              cleanup: true,
            },
          })),
        }),
        BRUNO_OWNER_PREVIEW_PROMOTION_EVIDENCE: JSON.stringify(
          ownerPromotionEvidence(ownerDecision.id, ownerDecision.decidedAt),
        ),
      },
      now: () => START,
    });

    expect(result.decisionId).toMatch(/^[0-9a-f-]{36}$/);
    const [decision] = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.id, result.decisionId));
    expect(decision).toMatchObject({
      userId: OWNER_ID,
      operatorId: OWNER_OPERATOR_ID,
      stage: "trusted_preview",
      outcome: "enter",
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: "runtime-owner",
      capabilityManifest: ["openai", "calendar_reading"],
    });
  });

  it("denies stage entry when Owner Preview becomes held after the precheck", async () => {
    await connection.db
      .delete(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.stage, "trusted_preview"));
    await createDurableRecoveryArchive(
      {
        action: "release_stage_admission",
        userId: OWNER_ID,
        applicationRevision: APPLICATION_REVISION,
        now: START,
      },
      provider,
      connection,
      () => START,
    );
    const [ownerDecision] = await connection.db
      .select({ id: founderReleaseDecisions.id, decidedAt: founderReleaseDecisions.decidedAt })
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.stage, "owner_preview"));
    if (!ownerDecision) throw new Error("Expected Owner Preview decision.");

    await expect(
      enterFounderTrustedPreviewStage(OWNER_ID, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        env: trustedStageEntryEnvironment(ownerDecision.id, ownerDecision.decidedAt),
        now: () => START,
        beforeDecisionCommit: async () => {
          await connection.db.transaction((tx) =>
            persistFounderOwnerPreviewHoldInTransaction(tx, {
              userId: OWNER_ID,
              operatorId: OWNER_OPERATOR_ID,
              applicationRevision: APPLICATION_REVISION,
              runtimeRevision: "runtime-owner",
              affectedCapabilities: ["openai", "calendar_reading"],
              evidenceDigests: [digest(89)],
              decidedAt: START,
            }),
          );
        },
      }),
    ).rejects.toThrow("Owner Preview must remain qualified");
    await expect(
      connection.db
        .select({ id: founderReleaseDecisions.id })
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.stage, "trusted_preview")),
    ).resolves.toEqual([]);
  });

  it("holds the whole cohort, revokes pending admission, and resumes only by fresh decision", async () => {
    const tokens = ["A".repeat(43), "B".repeat(43), "C".repeat(43)] as const;
    for (const [index, participant] of PARTICIPANTS.slice(0, 3).entries()) {
      await issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: participant.clerk,
          serviceBusinessEvidenceDigest: digest(index + 10),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => tokens[index] ?? "",
          env: ENV,
          now: () => START,
        },
      );
    }
    await admitFounderToTrustedPreview(PARTICIPANTS[0].userId, tokens[0], {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
      createProvider: () => provider,
      env: ENV,
      now: () => START,
    });
    const holdAt = new Date(START.valueOf() + 1_000);
    await connection.db.transaction((tx) =>
      persistFounderTrustedPreviewStageHoldInTransaction(tx, {
        cohortOwnerUserId: OWNER_ID,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-owner",
        finding: "critical",
        affectedCapabilities: ["openai", "calendar_reading"],
        evidenceDigests: [digest(30)],
        decidedAt: holdAt,
      }),
    );

    await expect(
      admitFounderToTrustedPreview(PARTICIPANTS[1].userId, tokens[1], {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => holdAt,
      }),
    ).rejects.toThrow("valid invitation for this Clerk identity");
    await expect(
      getFounderOwnerPreviewAccessForUser(PARTICIPANTS[0].userId, holdAt, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      admitted: true,
      availableCapabilities: [],
      stage: "trusted_preview",
    });
    const pending = await connection.db
      .select({ status: founderTrustedPreviewInvitations.status })
      .from(founderTrustedPreviewInvitations)
      .where(eq(founderTrustedPreviewInvitations.cohortSlot, 2));
    expect(pending).toEqual([{ status: "revoked" }]);

    const resumeAt = new Date(holdAt.valueOf() + 1_000);
    await insertStageDecision(connection, "resume", resumeAt);
    await expect(
      getFounderOwnerPreviewAccessForUser(PARTICIPANTS[0].userId, resumeAt, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      admitted: true,
      availableCapabilities: ["openai", "calendar_reading"],
      stage: "trusted_preview",
    });

    const replacementToken = "R".repeat(43);
    await expect(
      issueFounderTrustedPreviewInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: PARTICIPANTS[1].clerk,
          serviceBusinessEvidenceDigest: digest(31),
        },
        {
          applicationRevision: APPLICATION_REVISION,
          createConnection: () => connection,
          createInvitationToken: () => replacementToken,
          env: ENV,
          now: () => resumeAt,
        },
      ),
    ).resolves.toEqual({ invitationToken: replacementToken, cohortSlot: 2 });
    await expect(
      admitFounderToTrustedPreview(PARTICIPANTS[1].userId, replacementToken, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createProvider: () => provider,
        env: ENV,
        now: () => resumeAt,
      }),
    ).resolves.toMatchObject({ cohortSlot: 2 });
    const admittedAfterResume = await connection.db
      .select({ slot: founderTrustedPreviewInvitations.cohortSlot })
      .from(founderTrustedPreviewInvitations)
      .where(eq(founderTrustedPreviewInvitations.status, "admitted"))
      .orderBy(asc(founderTrustedPreviewInvitations.cohortSlot));
    expect(admittedAfterResume).toEqual([{ slot: 1 }, { slot: 2 }]);
  });

  it("retains the cohort lock through authorized participant work", async () => {
    const invitationToken = "L".repeat(43);
    await issueFounderTrustedPreviewInvitation(
      {
        cohortOwnerUserId: OWNER_ID,
        invitedClerkSubject: PARTICIPANTS[0].clerk,
        serviceBusinessEvidenceDigest: digest(40),
      },
      {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
        createInvitationToken: () => invitationToken,
        env: ENV,
        now: () => START,
      },
    );
    await admitFounderToTrustedPreview(PARTICIPANTS[0].userId, invitationToken, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
      createProvider: () => provider,
      env: ENV,
      now: () => START,
    });
    const competingConnection = createDatabaseConnection();

    try {
      await expect(
        withFounderOwnerPreviewWorkAuthority(
          {
            userId: PARTICIPANTS[0].userId,
            now: () => START,
            requiredCapabilities: ["openai"],
          },
          {
            applicationRevision: APPLICATION_REVISION,
            createConnection: () => connection,
          },
          async () => {
            const result = await competingConnection.db.execute<{ acquired: boolean }>(
              sql`select pg_try_advisory_xact_lock(hashtextextended(${FOUNDER_TRUSTED_PREVIEW_COHORT_LOCK_KEY}, 0)) as acquired`,
            );
            expect(result[0]?.acquired).toBe(false);
            return "committed";
          },
        ),
      ).resolves.toBe("committed");
    } finally {
      await competingConnection.close();
    }
  });
});

async function seedReadyCandidate(
  connection: DatabaseConnection,
  userId: string,
  operatorId: string,
  clerkUserId: string,
): Promise<void> {
  await connection.db.insert(users).values({
    id: userId,
    clerkUserId,
    createdAt: START,
    updatedAt: START,
  });
  await connection.db.insert(operators).values({
    id: operatorId,
    userId,
    status: "active",
    createdAt: START,
    updatedAt: START,
  });
  await connection.db.insert(operatorPreparations).values({
    id: randomUUID(),
    operatorId,
    status: "ready",
    timezone: "Asia/Manila",
    timezoneConfirmedAt: START,
    startedAt: START,
    completedAt: START,
    createdAt: START,
    updatedAt: START,
  });
  await connection.db.insert(operatorRuntimes).values({
    id: randomUUID(),
    operatorId,
    status: "ready",
    transportState: "connected",
    safetyState: "verified",
    configRevision: userId === OWNER_ID ? "runtime-owner" : `runtime-${userId.slice(-4)}`,
    runtimeIdentity: `runtime-${operatorId}`,
    attemptCount: 1,
    startedAt: START,
    readyAt: START,
    createdAt: START,
    updatedAt: START,
  });
}

async function insertStageDecision(
  connection: DatabaseConnection,
  outcome: "enter" | "resume",
  decidedAt: Date,
): Promise<void> {
  await connection.db.insert(founderReleaseDecisions).values({
    userId: OWNER_ID,
    operatorId: OWNER_OPERATOR_ID,
    stage: "trusted_preview",
    outcome,
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: "runtime-owner",
    capabilityManifest: ["openai", "calendar_reading"],
    openAiQualificationExpiresAt: EXPIRES_AT,
    calendarQualificationExpiresAt: EXPIRES_AT,
    evidenceDigests: [digest(outcome === "enter" ? 40 : 41)],
    decidedAt,
    createdAt: decidedAt,
  });
}

async function insertOwnerPreviewDecision(connection: DatabaseConnection): Promise<void> {
  const decidedAt = new Date(START.valueOf() - 8 * 24 * 60 * 60 * 1_000);
  await connection.db.insert(founderReleaseDecisions).values({
    userId: OWNER_ID,
    operatorId: OWNER_OPERATOR_ID,
    stage: "owner_preview",
    outcome: "enter",
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: "runtime-owner",
    capabilityManifest: ["openai", "calendar_reading"],
    openAiQualificationExpiresAt: EXPIRES_AT,
    calendarQualificationExpiresAt: EXPIRES_AT,
    evidenceDigests: [digest(42)],
    decidedAt,
    createdAt: decidedAt,
  });
}

function trustedStageEntryEnvironment(ownerDecisionId: string, ownerDecisionAt: Date) {
  const qualifiedAt = new Date(START.valueOf() - 60 * 60 * 1_000);
  return {
    ...ENV,
    BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE: buildTestOpenAiConnectedAcceptanceRelease(
      START,
      APPLICATION_REVISION,
    ),
    BRUNO_GOOGLE_CALENDAR_CONNECTED_ACCEPTANCE_RELEASE: buildTestGoogleConnectedAcceptanceRelease(
      "calendar_reading",
      START,
      APPLICATION_REVISION,
    ),
    BRUNO_TRUSTED_PREVIEW_QUALIFICATIONS: JSON.stringify({
      schemaVersion: "bruno.trusted-preview-qualifications.v1",
      qualifications: ["openai", "calendar_reading"].map((capability, index) => ({
        schemaVersion: "bruno.trusted-preview-qualification.v1",
        outcome: "passed",
        audience: "trusted_cohort",
        cohortOwnerUserId: OWNER_ID,
        operatorId: OWNER_OPERATOR_ID,
        stage: "trusted_preview",
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-owner",
        capability,
        qualifiedAt: qualifiedAt.toISOString(),
        expiresAt: new Date(qualifiedAt.valueOf() + 7 * 24 * 60 * 60 * 1_000).toISOString(),
        evidenceDigest: digest(90 + index),
        gates: {
          safeAuthorization: true,
          realUse: true,
          recovery: true,
          revocation: true,
          providerDisclosure: true,
          cleanup: true,
        },
      })),
    }),
    BRUNO_OWNER_PREVIEW_PROMOTION_EVIDENCE: JSON.stringify(
      ownerPromotionEvidence(ownerDecisionId, ownerDecisionAt),
    ),
  };
}

function trustedPromotionEvidence(
  participants: readonly {
    userId: string | null;
    operatorId: string | null;
    activeDecisionId: string | null;
    admittedAt: Date | null;
  }[],
) {
  return {
    schemaVersion: FOUNDER_TRUSTED_PREVIEW_PROMOTION_EVIDENCE_SCHEMA,
    stage: "trusted_preview",
    classification: "learning_round",
    supportMode: "attended",
    applicationRevision: APPLICATION_REVISION,
    participants: participants.map((participant, participantIndex) => {
      if (
        !participant.userId ||
        !participant.operatorId ||
        !participant.activeDecisionId ||
        !participant.admittedAt
      ) {
        throw new Error("Expected complete persisted Trusted Preview admission.");
      }
      const admittedAt = participant.admittedAt;
      return {
        userId: participant.userId,
        operatorId: participant.operatorId,
        activeDecisionId: participant.activeDecisionId,
        attendedObservation: true,
        journeys: Object.fromEntries(
          ["activation", "recurring_use", "authority", "recovery", "privacy"].map(
            (journey, journeyIndex) => [
              journey,
              {
                occurredAt: new Date(
                  admittedAt.valueOf() + (journeyIndex + 1) * 1_000,
                ).toISOString(),
                evidenceDigest: digest(100 + participantIndex * 10 + journeyIndex),
              },
            ],
          ),
        ) as Record<
          "activation" | "recurring_use" | "authority" | "recovery" | "privacy",
          { occurredAt: string; evidenceDigest: `sha256:${string}` }
        >,
      };
    }),
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

function ownerPromotionEvidence(activeDecisionId: string, admittedAt: Date) {
  const journeys = [
    "desktop_activation",
    "phone_activation",
    "interruption_recovery",
    "provider_reauthorization",
    "provider_disconnect",
    "founder_data_export",
    "bruno_data_deletion",
  ] as const;
  return {
    schemaVersion: "bruno.owner-preview-promotion-evidence.v1",
    stage: "owner_preview",
    classification: "learning_round",
    ownerUserId: OWNER_ID,
    operatorId: OWNER_OPERATOR_ID,
    applicationRevision: APPLICATION_REVISION,
    runtimeRevision: "runtime-owner",
    activeDecisionId,
    dailyBriefs: Array.from({ length: 7 }, (_, index) => ({
      day: new Date(admittedAt.valueOf() + (index + 1) * 24 * 60 * 60 * 1_000)
        .toISOString()
        .slice(0, 10),
      occurredAt: new Date(
        admittedAt.valueOf() + (index + 1) * 24 * 60 * 60 * 1_000 + 1_000,
      ).toISOString(),
      evidenceDigest: digest(60 + index),
    })),
    journeys: Object.fromEntries(
      journeys.map((journey, index) => [
        journey,
        {
          occurredAt: new Date(admittedAt.valueOf() + (index + 1) * 2_000).toISOString(),
          evidenceDigest: digest(70 + index),
        },
      ]),
    ),
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table founder_trusted_preview_invitations, founder_recovery_archives, founder_release_decisions, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
  await connection.db
    .delete(appMetadata)
    .where(eq(appMetadata.key, FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY));
}

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
