import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { FakeBackupObjectStorage } from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  appMetadata,
  founderExternalBetaInvitations,
  founderPreviewQualifications,
  founderReleaseDecisions,
  founderTrustedPreviewInvitations,
  operatorPreparations,
  operatorRuntimes,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  admitFounderToExternalBeta,
  enterFounderExternalBetaStage,
  FOUNDER_EXTERNAL_BETA_ACCESS_MS,
  FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
  FOUNDER_EXTERNAL_BETA_INVITATION_MS,
  FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
  getFounderExternalBetaStatusForUser,
  issueFounderExternalBetaInvitation,
  reconcileFounderExternalBetaExpiry,
  withdrawFounderFromExternalBeta,
} from "@/src/server/founder-product-contract/external-beta-admission";
import { EncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { getFounderOwnerPreviewAccessForUser } from "@/src/server/founder-product-contract/release-stage-access";
import { FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY } from "@/src/server/founder-product-contract/owner-preview-release-decision";

const OWNER_ID = "00000000-0000-4000-8000-000000003780";
const PARTICIPANT_ID = "00000000-0000-4000-8000-000000003781";
const OTHER_ID = "00000000-0000-4000-8000-000000003782";
const OWNER_OPERATOR_ID = "00000000-0000-4000-8000-000000003790";
const PARTICIPANT_OPERATOR_ID = "00000000-0000-4000-8000-000000003791";
const OTHER_OPERATOR_ID = "00000000-0000-4000-8000-000000003792";
const APPLICATION_REVISION = "a".repeat(40);
const COHORT = "external-beta-378";
const START = new Date("2026-08-23T00:00:00.000Z");
const TOKEN = "E".repeat(43);
const WORKSPACE = "founder-workspace-378";
const CAPABILITIES = [
  "openai",
  "anthropic",
  "calendar_reading",
  "gmail_reading",
  "gmail_sending",
] as const;
const ENV = {
  BRUNO_AUTH_MODE: "clerk",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_external_beta",
  CLERK_SECRET_KEY: "sk_test_external_beta",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
  VERCEL_GIT_COMMIT_SHA: APPLICATION_REVISION,
};

describe("External Beta admission", () => {
  let connection: DatabaseConnection;
  const provider = new EncryptedFounderRecoveryArchiveProvider({
    storage: new FakeBackupObjectStorage("external-beta-378"),
    masterKey: new Uint8Array(32).fill(37),
  });

  beforeAll(() => {
    connection = createDatabaseConnection();
  });

  beforeEach(async () => {
    await reset(connection);
    await seedReadyCandidate(
      connection,
      OWNER_ID,
      OWNER_OPERATOR_ID,
      "clerk-owner",
      "runtime-owner",
    );
    await seedReadyCandidate(
      connection,
      PARTICIPANT_ID,
      PARTICIPANT_OPERATOR_ID,
      "clerk-participant",
      "runtime-participant",
    );
    await seedReadyCandidate(
      connection,
      OTHER_ID,
      OTHER_OPERATOR_ID,
      "clerk-other",
      "runtime-other",
    );
    await connection.db.insert(appMetadata).values({
      key: FOUNDER_OWNER_PREVIEW_OWNER_METADATA_KEY,
      value: OWNER_ID,
      updatedAt: START,
    });
    const [decision] = await connection.db
      .insert(founderReleaseDecisions)
      .values({
        userId: OWNER_ID,
        operatorId: OWNER_OPERATOR_ID,
        stage: "external_beta",
        outcome: "enter",
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-owner",
        capabilityManifest: CAPABILITIES,
        externalBetaCohort: COHORT,
        evidenceDigests: [digest(1)],
        decidedAt: START,
        createdAt: START,
      })
      .returning({ id: founderReleaseDecisions.id });
    if (!decision) throw new Error("Expected External Beta decision.");
    await connection.db.insert(founderPreviewQualifications).values(
      CAPABILITIES.map((capability, index) => ({
        stage: "external_beta" as const,
        cohort: COHORT,
        capability,
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: "runtime-owner",
        evidenceDigest: digest(10 + index),
        observedAt: START,
        expiresAt: new Date(START.valueOf() + 8 * 24 * 60 * 60 * 1_000),
        createdAt: START,
      })),
    );
  });

  afterAll(async () => {
    await reset(connection);
    await connection.close();
  });

  it("binds a seven-day opaque invitation to one Clerk identity and workspace", async () => {
    const invitation = await issueInvitation();
    expect(invitation).toEqual({
      invitationToken: TOKEN,
      workspaceReference: WORKSPACE,
      cohortSlot: 1,
      expiresAt: new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_INVITATION_MS).toISOString(),
    });
    const [persisted] = await connection.db.select().from(founderExternalBetaInvitations);
    expect(persisted).toMatchObject({
      status: "invited",
      cohort: COHORT,
      cohortSlot: 1,
      invitationExpiresAt: new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_INVITATION_MS),
      paymentMethodCollected: false,
      automaticPaidConversion: false,
    });
    expect(JSON.stringify(persisted)).not.toContain(TOKEN);
    expect(JSON.stringify(persisted)).not.toContain(WORKSPACE);

    await expect(
      admitFounderToExternalBeta(
        OTHER_ID,
        { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
        dependencies(START),
      ),
    ).rejects.toThrow("invalid or expired");
    await expect(
      admitFounderToExternalBeta(
        PARTICIPANT_ID,
        { invitationToken: TOKEN, workspaceReference: "copied-workspace", compact: compact() },
        dependencies(START),
      ),
    ).rejects.toThrow("invalid or expired");
  });

  it("enters only after exact Trusted Preview promotion and the complete persisted manifest", async () => {
    const trustedParticipants = await seedTrustedPromotionGate(connection);
    const decisionAt = new Date(START.valueOf() + 60 * 60 * 1_000);
    const result = await enterFounderExternalBetaStage(OWNER_ID, {
      applicationRevision: APPLICATION_REVISION,
      cohort: COHORT,
      createConnection: () => connection,
      env: {
        ...ENV,
        BRUNO_TRUSTED_PREVIEW_PROMOTION_EVIDENCE: JSON.stringify(
          trustedPromotionEvidence(trustedParticipants),
        ),
      },
      now: () => decisionAt,
    });
    expect(result).toMatchObject({ cohort: COHORT });
    const [decision] = await connection.db
      .select()
      .from(founderReleaseDecisions)
      .where(eq(founderReleaseDecisions.id, result.decisionId));
    expect(decision).toMatchObject({
      userId: OWNER_ID,
      operatorId: OWNER_OPERATOR_ID,
      stage: "external_beta",
      outcome: "enter",
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: "runtime-owner",
      externalBetaCohort: COHORT,
      capabilityManifest: CAPABILITIES,
    });
  });

  it("requires the complete Compact and rejects acceptance at the exact invitation expiry", async () => {
    await issueInvitation();
    await expect(
      admitFounderToExternalBeta(
        PARTICIPANT_ID,
        {
          invitationToken: TOKEN,
          workspaceReference: WORKSPACE,
          compact: { ...compact(), instabilityAccepted: false as never },
        },
        dependencies(START),
      ),
    ).rejects.toThrow("complete Beta Compact");
    const expiry = new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_INVITATION_MS);
    await expect(
      admitFounderToExternalBeta(
        PARTICIPANT_ID,
        { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
        dependencies(expiry),
      ),
    ).rejects.toThrow("invalid or expired");
    await expect(
      issueFounderExternalBetaInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: "clerk-participant",
          namedFounder: "Named Founder",
          workspaceReference: "different-workspace",
          independenceEvidenceDigest: digest(99),
        },
        { ...dependencies(expiry), createInvitationToken: () => "z".repeat(43) },
      ),
    ).rejects.toThrow("already has an External Beta invitation");
  });

  it("grants one nonextendable 14-day window and stops access at the exact boundary", async () => {
    await issueInvitation();
    const admitted = await admitFounderToExternalBeta(
      PARTICIPANT_ID,
      { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
      dependencies(START),
    );
    const accessExpiresAt = new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS);
    expect(admitted).toEqual({
      accessExpiresAt: accessExpiresAt.toISOString(),
      retirementDueAt: new Date(
        accessExpiresAt.valueOf() + FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
      ).toISOString(),
    });
    await expect(
      getFounderOwnerPreviewAccessForUser(PARTICIPANT_ID, START, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({
      admitted: true,
      stage: "external_beta",
      availableCapabilities: CAPABILITIES,
    });
    await expect(
      getFounderOwnerPreviewAccessForUser(PARTICIPANT_ID, accessExpiresAt, {
        applicationRevision: APPLICATION_REVISION,
        createConnection: () => connection,
      }),
    ).resolves.toMatchObject({ admitted: false, stage: "external_beta" });
    await expect(
      admitFounderToExternalBeta(
        PARTICIPANT_ID,
        { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
        dependencies(START),
      ),
    ).rejects.toThrow("invalid or expired");
    await expect(
      issueFounderExternalBetaInvitation(
        {
          cohortOwnerUserId: OWNER_ID,
          invitedClerkSubject: "clerk-participant",
          namedFounder: "Named Founder",
          workspaceReference: "reset-workspace",
          independenceEvidenceDigest: digest(98),
        },
        { ...dependencies(accessExpiresAt), createInvitationToken: () => "y".repeat(43) },
      ),
    ).rejects.toThrow("already has an External Beta invitation");
  });

  it("expires or withdraws without deleting retained local data and starts the one-hour retirement clock", async () => {
    await issueInvitation();
    await admitFounderToExternalBeta(
      PARTICIPANT_ID,
      { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
      dependencies(START),
    );
    const accessExpiresAt = new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS);
    await expect(
      reconcileFounderExternalBetaExpiry(PARTICIPANT_ID, accessExpiresAt, {
        createConnection: () => connection,
      }),
    ).resolves.toBe(true);
    const status = await getFounderExternalBetaStatusForUser(PARTICIPANT_ID, accessExpiresAt, {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
    });
    expect(status).toMatchObject({
      state: "expired",
      remainingSeconds: 0,
      exportAvailable: true,
      deletionAvailable: true,
    });
    const [operator] = await connection.db
      .select()
      .from(operators)
      .where(eq(operators.id, PARTICIPANT_OPERATOR_ID));
    expect(operator).toMatchObject({
      externalActionPause: true,
      externalActionPausedAt: accessExpiresAt,
    });
  });

  it("withdraws immediately without moving the original access end", async () => {
    await issueInvitation();
    await admitFounderToExternalBeta(
      PARTICIPANT_ID,
      { invitationToken: TOKEN, workspaceReference: WORKSPACE, compact: compact() },
      dependencies(START),
    );
    const withdrawnAt = new Date(START.valueOf() + 60_000);
    await expect(
      withdrawFounderFromExternalBeta(PARTICIPANT_ID, withdrawnAt, {
        createConnection: () => connection,
      }),
    ).resolves.toEqual({
      retirementDueAt: new Date(
        START.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS + FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
      ).toISOString(),
    });
    const [membership] = await connection.db.select().from(founderExternalBetaInvitations);
    expect(membership).toMatchObject({
      status: "withdrawn",
      withdrawnAt,
      accessExpiresAt: new Date(START.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS),
    });
  });

  function dependencies(now: Date) {
    return {
      applicationRevision: APPLICATION_REVISION,
      createConnection: () => connection,
      createProvider: () => provider,
      env: ENV,
      now: () => now,
    };
  }

  async function issueInvitation() {
    return issueFounderExternalBetaInvitation(
      {
        cohortOwnerUserId: OWNER_ID,
        invitedClerkSubject: "clerk-participant",
        namedFounder: "Named Founder",
        workspaceReference: WORKSPACE,
        independenceEvidenceDigest: digest(50),
      },
      { ...dependencies(START), createInvitationToken: () => TOKEN },
    );
  }
});

async function seedReadyCandidate(
  connection: DatabaseConnection,
  userId: string,
  operatorId: string,
  clerkUserId: string,
  runtimeRevision: string,
) {
  await connection.db
    .insert(users)
    .values({ id: userId, clerkUserId, createdAt: START, updatedAt: START });
  await connection.db
    .insert(operators)
    .values({ id: operatorId, userId, status: "active", createdAt: START, updatedAt: START });
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
    configRevision: runtimeRevision,
    runtimeIdentity: `runtime-${operatorId}`,
    attemptCount: 1,
    startedAt: START,
    readyAt: START,
    createdAt: START,
    updatedAt: START,
  });
}

async function seedTrustedPromotionGate(
  connection: DatabaseConnection,
): Promise<readonly { userId: string; operatorId: string; activeDecisionId: string }[]> {
  await connection.db
    .delete(founderReleaseDecisions)
    .where(eq(founderReleaseDecisions.stage, "external_beta"));
  const [stageDecision] = await connection.db
    .insert(founderReleaseDecisions)
    .values({
      userId: OWNER_ID,
      operatorId: OWNER_OPERATOR_ID,
      stage: "trusted_preview",
      outcome: "enter",
      applicationRevision: APPLICATION_REVISION,
      runtimeRevision: "runtime-owner",
      capabilityManifest: ["openai", "calendar_reading"],
      openAiQualificationExpiresAt: new Date(START.valueOf() + 7 * 24 * 60 * 60 * 1_000),
      calendarQualificationExpiresAt: new Date(START.valueOf() + 7 * 24 * 60 * 60 * 1_000),
      evidenceDigests: [digest(60)],
      decidedAt: START,
      createdAt: START,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!stageDecision) throw new Error("Expected Trusted Preview stage decision.");
  const admitted: { userId: string; operatorId: string; activeDecisionId: string }[] = [];
  for (const [index, participant] of [
    { userId: PARTICIPANT_ID, operatorId: PARTICIPANT_OPERATOR_ID, runtime: "runtime-participant" },
    { userId: OTHER_ID, operatorId: OTHER_OPERATOR_ID, runtime: "runtime-other" },
  ].entries()) {
    const [participantDecision] = await connection.db
      .insert(founderReleaseDecisions)
      .values({
        userId: participant.userId,
        operatorId: participant.operatorId,
        stage: "trusted_preview",
        outcome: "enter",
        applicationRevision: APPLICATION_REVISION,
        runtimeRevision: participant.runtime,
        capabilityManifest: ["openai", "calendar_reading"],
        openAiQualificationExpiresAt: new Date(START.valueOf() + 7 * 24 * 60 * 60 * 1_000),
        calendarQualificationExpiresAt: new Date(START.valueOf() + 7 * 24 * 60 * 60 * 1_000),
        evidenceDigests: [digest(70 + index)],
        decidedAt: START,
        createdAt: START,
      })
      .returning({ id: founderReleaseDecisions.id });
    if (!participantDecision) throw new Error("Expected Trusted Preview participant decision.");
    admitted.push({
      userId: participant.userId,
      operatorId: participant.operatorId,
      activeDecisionId: participantDecision.id,
    });
    await connection.db.insert(founderTrustedPreviewInvitations).values({
      cohortOwnerUserId: OWNER_ID,
      stageDecisionId: stageDecision.id,
      cohortSlot: index + 1,
      invitationDigest: digest(80 + index),
      invitedClerkSubjectDigest: digest(82 + index),
      serviceBusinessEvidenceDigest: digest(84 + index),
      status: "admitted",
      participantUserId: participant.userId,
      participantOperatorId: participant.operatorId,
      admissionDecisionId: participantDecision.id,
      invitedAt: START,
      admittedAt: START,
      createdAt: START,
    });
  }
  return admitted;
}

function trustedPromotionEvidence(
  participants: readonly { userId: string; operatorId: string; activeDecisionId: string }[],
) {
  return {
    schemaVersion: "bruno.trusted-preview-promotion-evidence.v1",
    stage: "trusted_preview",
    classification: "learning_round",
    supportMode: "attended",
    applicationRevision: APPLICATION_REVISION,
    participants: participants.map((participant, participantIndex) => ({
      ...participant,
      attendedObservation: true,
      journeys: Object.fromEntries(
        ["activation", "recurring_use", "authority", "recovery", "privacy"].map(
          (journey, journeyIndex) => [
            journey,
            {
              occurredAt: new Date(START.valueOf() + (journeyIndex + 1) * 1_000).toISOString(),
              evidenceDigest: digest(100 + participantIndex * 10 + journeyIndex),
            },
          ],
        ),
      ),
    })),
    unresolvedReleaseBlockers: 0,
    unresolvedCriticalFailures: 0,
  };
}

function compact() {
  return {
    version: FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
    instabilityAccepted: true,
    capabilityBoundaryAccepted: true,
    reactiveSupportAccepted: true,
    companyDataHandlingAccepted: true,
    feedbackBoundaryAccepted: true,
    withdrawalExportDeletionAccepted: true,
    freeNonconvertingBoundaryAccepted: true,
  } as const;
}

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table founder_external_beta_invitations, founder_trusted_preview_invitations, founder_recovery_archives, founder_preview_qualifications, founder_release_decisions, operator_runtimes, operator_preparations, operators, users restart identity cascade",
  );
  await connection.db.delete(appMetadata);
}

function digest(index: number): `sha256:${string}` {
  return `sha256:${index.toString(16).padStart(64, "0")}`;
}
