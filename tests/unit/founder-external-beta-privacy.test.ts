import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderExternalBetaConsentReceipts,
  founderExternalBetaInvitations,
  founderExternalBetaMeasurements,
  founderExternalBetaRecordings,
  founderReleaseDecisions,
  operators,
  users,
} from "@/src/server/db/schema";
import {
  captureFounderExternalBetaMeasurement,
  decideFounderExternalBetaConsent,
  deleteFounderExternalBetaMeasurements,
  exportFounderExternalBetaPrivacyData,
  FOUNDER_EXTERNAL_BETA_RECORDING_RECONCILIATION_LEAD_MS,
  FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS,
  getFounderExternalBetaPrivacyStatusForUser,
  parseFounderExternalBetaMeasurement,
  reconcileFounderExternalBetaRecordingRetention,
  registerFounderExternalBetaRecording,
} from "@/src/server/founder-product-contract/external-beta-privacy";

const OWNER_ID = "00000000-0000-4000-8000-000000003790";
const OWNER_OPERATOR_ID = "00000000-0000-4000-8000-000000003791";
const PARTICIPANT_ID = "00000000-0000-4000-8000-000000003792";
const PARTICIPANT_OPERATOR_ID = "00000000-0000-4000-8000-000000003793";
const OTHER_ID = "00000000-0000-4000-8000-000000003794";
const OTHER_OPERATOR_ID = "00000000-0000-4000-8000-000000003795";
const INVITATION_ID = "00000000-0000-4000-8000-000000003796";
const NOW = new Date("2026-08-23T00:00:00.000Z");
const ACCESS_EXPIRES_AT = new Date("2026-09-06T00:00:00.000Z");
const WORKSPACE_DIGEST = `sha256:${"a".repeat(64)}` as const;
const OTHER_WORKSPACE_DIGEST = `sha256:${"b".repeat(64)}` as const;
const ARTIFACT_REFERENCE_DIGEST = `sha256:${"c".repeat(64)}` as const;

describe("External Beta privacy boundary", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table users restart identity cascade");
    await seedAdmittedParticipant(connection);
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table users restart identity cascade");
    await connection.close();
  });

  it("accepts only the static event and property taxonomy", () => {
    expect(parseFounderExternalBetaMeasurement({ event: "activation_completed" })).toEqual({
      event: "activation_completed",
    });
    expect(
      parseFounderExternalBetaMeasurement({ event: "journey_completed", journey: "privacy" }),
    ).toEqual({ event: "journey_completed", journey: "privacy" });
    expect(
      parseFounderExternalBetaMeasurement({
        event: "journey_timing_recorded",
        journey: "morning_brief",
        durationSeconds: 15,
      }),
    ).toMatchObject({ event: "journey_timing_recorded", durationSeconds: 15 });
    expect(
      parseFounderExternalBetaMeasurement({
        event: "capability_state_observed",
        capability: "anthropic",
        capabilityState: "paused",
      }),
    ).toMatchObject({ event: "capability_state_observed", capability: "anthropic" });
    expect(
      parseFounderExternalBetaMeasurement({
        event: "safe_failure_observed",
        safeFailureCategory: "provider_unavailable",
      }),
    ).toMatchObject({ event: "safe_failure_observed" });
    expect(
      parseFounderExternalBetaMeasurement({
        event: "support_duration_recorded",
        durationSeconds: 90,
      }),
    ).toMatchObject({ event: "support_duration_recorded" });

    for (const forbidden of [
      "messageBody",
      "calendarContent",
      "recipient",
      "prompt",
      "providerResponse",
      "credential",
      "metadata",
    ]) {
      expect(() =>
        parseFounderExternalBetaMeasurement({
          event: "activation_completed",
          [forbidden]: "private",
        }),
      ).toThrow("non-allowlisted property");
    }
    expect(() =>
      parseFounderExternalBetaMeasurement({
        event: "capability_state_observed",
        capability: "gmail_reading",
        capabilityState: "private-content",
      }),
    ).toThrow("capability state");
  });

  it("is private by default, isolates participant and workspace, and never relabels evidence", async () => {
    const dependencies = { createConnection: () => connection };
    const initial = await getFounderExternalBetaPrivacyStatusForUser(PARTICIPANT_ID, dependencies);
    expect(initial).toMatchObject({
      state: "available",
      collection: { autocapture: false, sessionReplay: false, personProfiles: false },
      consent: { measurement: "not_granted", recording: "not_granted" },
      accessUnaffectedByRefusal: true,
    });
    await expect(
      captureFounderExternalBetaMeasurement(
        PARTICIPANT_ID,
        { event: "activation_completed" },
        NOW,
        dependencies,
      ),
    ).rejects.toThrow("Separate measurement consent");

    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "measurement", decision: "grant", decidedAt: NOW },
      dependencies,
    );
    await captureFounderExternalBetaMeasurement(
      PARTICIPANT_ID,
      { event: "activation_completed" },
      NOW,
      { ...dependencies, expectedWorkspaceDigest: WORKSPACE_DIGEST },
    );
    await expect(
      captureFounderExternalBetaMeasurement(
        PARTICIPANT_ID,
        { event: "activation_completed" },
        NOW,
        { ...dependencies, expectedWorkspaceDigest: OTHER_WORKSPACE_DIGEST },
      ),
    ).rejects.toThrow("workspace boundary");
    await expect(
      captureFounderExternalBetaMeasurement(
        OTHER_ID,
        { event: "activation_completed" },
        NOW,
        dependencies,
      ),
    ).rejects.toThrow("privacy controls are unavailable");

    expect(await connection.db.select().from(founderExternalBetaMeasurements)).toEqual([
      expect.objectContaining({
        invitationId: INVITATION_ID,
        participantUserId: PARTICIPANT_ID,
        participantOperatorId: PARTICIPANT_OPERATOR_ID,
        workspaceDigest: WORKSPACE_DIGEST,
        event: "activation_completed",
        evidenceClassification: "product_hardening",
      }),
    ]);
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "measurement", decision: "refuse", decidedAt: new Date(NOW.valueOf() + 1) },
      dependencies,
    );
    const [membership] = await connection.db.select().from(founderExternalBetaInvitations);
    expect(membership?.status).toBe("admitted");
    await expect(
      captureFounderExternalBetaMeasurement(
        PARTICIPANT_ID,
        { event: "activation_completed" },
        new Date(NOW.valueOf() + 2),
        dependencies,
      ),
    ).rejects.toThrow("Separate measurement consent");
  });

  it("rejects ambiguous same-instant decisions for one consent purpose", async () => {
    const dependencies = { createConnection: () => connection };
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "measurement", decision: "grant", decidedAt: NOW },
      dependencies,
    );
    await expect(
      decideFounderExternalBetaConsent(
        PARTICIPANT_ID,
        { purpose: "measurement", decision: "withdraw", decidedAt: NOW },
        dependencies,
      ),
    ).rejects.toThrow("later decision instant");
  });

  it("requires separate recording and marketing decisions and verifies deletion by day 30", async () => {
    const dependencies = { createConnection: () => connection };
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "recording", decision: "refuse", decidedAt: NOW },
      dependencies,
    );
    await expect(
      registerFounderExternalBetaRecording(
        PARTICIPANT_ID,
        { artifactReferenceDigest: ARTIFACT_REFERENCE_DIGEST, recordedAt: NOW },
        dependencies,
      ),
    ).rejects.toThrow("Separate recording consent");
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "recording", decision: "grant", decidedAt: new Date(NOW.valueOf() + 1) },
      dependencies,
    );
    const recordedAt = new Date(NOW.valueOf() + 1);
    const recording = await registerFounderExternalBetaRecording(
      PARTICIPANT_ID,
      { artifactReferenceDigest: ARTIFACT_REFERENCE_DIGEST, recordedAt },
      dependencies,
    );
    expect(recording.deletionDueAt).toBe(
      new Date(recordedAt.valueOf() + FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS).toISOString(),
    );
    for (const purpose of [
      "feedback",
      "testimonial",
      "identity",
      "name",
      "logo",
      "quotation",
      "case_study",
    ] as const) {
      await decideFounderExternalBetaConsent(
        PARTICIPANT_ID,
        { purpose, decision: "refuse", decidedAt: NOW },
        dependencies,
      );
    }
    const status = await getFounderExternalBetaPrivacyStatusForUser(PARTICIPANT_ID, dependencies);
    expect(status).toMatchObject({
      state: "available",
      consent: {
        feedback: "refused",
        recording: "granted",
        testimonial: "refused",
        identity: "refused",
        name: "refused",
        logo: "refused",
        quotation: "refused",
        case_study: "refused",
      },
    });

    const provider = { deleteAndVerifyAbsent: vi.fn(async () => ({ absent: true as const })) };
    expect(
      await reconcileFounderExternalBetaRecordingRetention(
        new Date(
          new Date(recording.deletionDueAt).valueOf() -
            FOUNDER_EXTERNAL_BETA_RECORDING_RECONCILIATION_LEAD_MS -
            1,
        ),
        provider,
        dependencies,
      ),
    ).toEqual({ deleted: 0, late: 0, failed: 0 });
    expect(provider.deleteAndVerifyAbsent).not.toHaveBeenCalled();
    expect(
      await reconcileFounderExternalBetaRecordingRetention(
        new Date(recording.deletionDueAt),
        provider,
        dependencies,
      ),
    ).toEqual({ deleted: 1, late: 0, failed: 0 });
    expect(provider.deleteAndVerifyAbsent).toHaveBeenCalledWith({
      artifactReferenceDigest: ARTIFACT_REFERENCE_DIGEST,
    });
    expect(await connection.db.select().from(founderExternalBetaRecordings)).toEqual([
      expect.objectContaining({
        status: "deleted",
        providerDeletionVerified: true,
        deletedAt: new Date(recording.deletionDueAt),
      }),
    ]);
  });

  it("persists a terminal breach receipt when a retried recording deletion is late", async () => {
    const dependencies = { createConnection: () => connection };
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "recording", decision: "grant", decidedAt: NOW },
      dependencies,
    );
    const recording = await registerFounderExternalBetaRecording(
      PARTICIPANT_ID,
      { artifactReferenceDigest: ARTIFACT_REFERENCE_DIGEST, recordedAt: NOW },
      dependencies,
    );
    const deletedAt = new Date(new Date(recording.deletionDueAt).valueOf() + 1);
    const provider = { deleteAndVerifyAbsent: vi.fn(async () => ({ absent: true as const })) };

    await expect(
      reconcileFounderExternalBetaRecordingRetention(deletedAt, provider, dependencies),
    ).resolves.toEqual({ deleted: 1, late: 1, failed: 0 });

    expect(await connection.db.select().from(founderExternalBetaRecordings)).toEqual([
      expect.objectContaining({
        status: "deleted_late",
        providerDeletionVerified: true,
        deletedAt,
        deletionDueAt: new Date(recording.deletionDueAt),
        deletionReceiptDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      }),
    ]);
    await expect(
      reconcileFounderExternalBetaRecordingRetention(
        new Date(deletedAt.valueOf() + 60_000),
        provider,
        dependencies,
      ),
    ).resolves.toEqual({ deleted: 0, late: 0, failed: 0 });
    expect(provider.deleteAndVerifyAbsent).toHaveBeenCalledTimes(1);
  });

  it("exports only bounded facts and honors measurement deletion", async () => {
    const dependencies = { createConnection: () => connection };
    await decideFounderExternalBetaConsent(
      PARTICIPANT_ID,
      { purpose: "measurement", decision: "grant", decidedAt: NOW },
      dependencies,
    );
    await captureFounderExternalBetaMeasurement(
      PARTICIPANT_ID,
      { event: "support_duration_recorded", durationSeconds: 120 },
      NOW,
      dependencies,
    );
    const exported = await exportFounderExternalBetaPrivacyData(PARTICIPANT_ID, dependencies);
    expect(exported).toMatchObject({
      schemaVersion: "bruno.external-beta-privacy-export.v1",
      evidenceClassification: "product_hardening",
      measurements: [{ event: "support_duration_recorded", durationSeconds: 120 }],
    });
    expect(JSON.stringify(exported)).not.toMatch(
      /messageBody|calendarContent|recipient|prompt|providerResponse|credential|metadata/i,
    );
    await expect(
      deleteFounderExternalBetaMeasurements(PARTICIPANT_ID, dependencies),
    ).resolves.toEqual({ deleted: 1 });
    expect(
      (await exportFounderExternalBetaPrivacyData(PARTICIPANT_ID, dependencies)).measurements,
    ).toEqual([]);
  });
});

async function seedAdmittedParticipant(connection: DatabaseConnection): Promise<void> {
  await connection.db
    .insert(users)
    .values([{ id: OWNER_ID }, { id: PARTICIPANT_ID }, { id: OTHER_ID }]);
  await connection.db.insert(operators).values([
    { id: OWNER_OPERATOR_ID, userId: OWNER_ID, createdAt: NOW, updatedAt: NOW },
    { id: PARTICIPANT_OPERATOR_ID, userId: PARTICIPANT_ID, createdAt: NOW, updatedAt: NOW },
    { id: OTHER_OPERATOR_ID, userId: OTHER_ID, createdAt: NOW, updatedAt: NOW },
  ]);
  const [stageDecision] = await connection.db
    .insert(founderReleaseDecisions)
    .values({
      userId: OWNER_ID,
      operatorId: OWNER_OPERATOR_ID,
      stage: "external_beta",
      outcome: "enter",
      applicationRevision: "d".repeat(40),
      runtimeRevision: "runtime-379",
      capabilityManifest: [
        "openai",
        "anthropic",
        "calendar_reading",
        "gmail_reading",
        "gmail_sending",
      ],
      externalBetaCohort: "external-beta-379",
      evidenceDigests: [`sha256:${"d".repeat(64)}`],
      decidedAt: NOW,
      createdAt: NOW,
    })
    .returning({ id: founderReleaseDecisions.id });
  const [admissionDecision] = await connection.db
    .insert(founderReleaseDecisions)
    .values({
      userId: PARTICIPANT_ID,
      operatorId: PARTICIPANT_OPERATOR_ID,
      stage: "external_beta",
      outcome: "enter",
      applicationRevision: "d".repeat(40),
      runtimeRevision: "runtime-379",
      capabilityManifest: [
        "openai",
        "anthropic",
        "calendar_reading",
        "gmail_reading",
        "gmail_sending",
      ],
      externalBetaCohort: "external-beta-379",
      evidenceDigests: [`sha256:${"e".repeat(64)}`],
      decidedAt: NOW,
      createdAt: NOW,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!stageDecision || !admissionDecision)
    throw new Error("Test release authority is unavailable.");
  await connection.db.insert(founderExternalBetaInvitations).values({
    id: INVITATION_ID,
    cohortOwnerUserId: OWNER_ID,
    stageDecisionId: stageDecision.id,
    cohort: "external-beta-379",
    cohortSlot: 1,
    invitationDigest: `sha256:${"1".repeat(64)}`,
    invitedClerkSubjectDigest: `sha256:${"2".repeat(64)}`,
    namedFounderDigest: `sha256:${"3".repeat(64)}`,
    workspaceDigest: WORKSPACE_DIGEST,
    independenceEvidenceDigest: `sha256:${"4".repeat(64)}`,
    status: "admitted",
    participantUserId: PARTICIPANT_ID,
    participantOperatorId: PARTICIPANT_OPERATOR_ID,
    admissionDecisionId: admissionDecision.id,
    betaCompactDigest: `sha256:${"5".repeat(64)}`,
    invitedAt: new Date(NOW.valueOf() - 60_000),
    invitationExpiresAt: new Date(NOW.valueOf() - 60_000 + 7 * 24 * 60 * 60 * 1_000),
    admittedAt: NOW,
    accessExpiresAt: ACCESS_EXPIRES_AT,
    retirementDueAt: new Date(ACCESS_EXPIRES_AT.valueOf() + 60 * 60 * 1_000),
    createdAt: NOW,
    updatedAt: NOW,
  });
  expect(await connection.db.select().from(founderExternalBetaConsentReceipts)).toEqual([]);
}
