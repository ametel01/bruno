import "server-only";

import { and, asc, desc, eq, lte } from "drizzle-orm";
import {
  createBackupObjectStorage,
  type DeletableBackupObjectStorage,
} from "@/src/server/backups/backup-storage";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderExternalBetaConsentReceipts,
  founderExternalBetaInvitations,
  founderExternalBetaMeasurements,
  founderExternalBetaRecordings,
} from "@/src/server/db/schema";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  type FounderExternalBetaCapability,
} from "@/src/shared/founder-external-beta";
import { founderProductContractDigest } from "./digest";

export const FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const FOUNDER_EXTERNAL_BETA_RECORDING_RECONCILIATION_LEAD_MS = 60_000;
export const FOUNDER_EXTERNAL_BETA_EVIDENCE_CLASSIFICATION = "product_hardening" as const;

export const FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES = [
  "measurement",
  "feedback",
  "recording",
  "testimonial",
  "identity",
  "name",
  "logo",
  "quotation",
  "case_study",
] as const;

export const FOUNDER_EXTERNAL_BETA_JOURNEYS = [
  "activation",
  "operator_setup",
  "company_connections",
  "morning_brief",
  "lead_to_client_loop",
  "authority",
  "recovery",
  "privacy",
] as const;

export const FOUNDER_EXTERNAL_BETA_SAFE_FAILURE_CATEGORIES = [
  "provider_unavailable",
  "authorization_required",
  "qualification_expired",
  "connection_unavailable",
  "recovery_exhausted",
  "support_required",
] as const;

export type FounderExternalBetaConsentPurpose =
  (typeof FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES)[number];
export type FounderExternalBetaConsentDecision = "grant" | "refuse" | "withdraw";
export type FounderExternalBetaJourney = (typeof FOUNDER_EXTERNAL_BETA_JOURNEYS)[number];
export type FounderExternalBetaSafeFailureCategory =
  (typeof FOUNDER_EXTERNAL_BETA_SAFE_FAILURE_CATEGORIES)[number];

export type FounderExternalBetaMeasurement =
  | { event: "activation_completed" }
  | { event: "journey_completed"; journey: FounderExternalBetaJourney }
  | {
      event: "journey_timing_recorded";
      journey: FounderExternalBetaJourney;
      durationSeconds: number;
    }
  | {
      event: "capability_state_observed";
      capability: FounderExternalBetaCapability;
      capabilityState: "available" | "paused";
    }
  | { event: "safe_failure_observed"; safeFailureCategory: FounderExternalBetaSafeFailureCategory }
  | { event: "support_duration_recorded"; durationSeconds: number };

export type FounderExternalBetaPrivacyStatus =
  | { state: "unavailable" }
  | {
      state: "available";
      collection: {
        allowlistedFacts: readonly [
          "Activation",
          "Journey completion",
          "Timing",
          "Capability state",
          "Safe failure category",
          "Support duration",
        ];
        neverCollected: readonly [
          "Message bodies",
          "Calendar content",
          "Recipients",
          "Prompts",
          "Provider responses",
          "Credentials",
          "Unrestricted metadata",
        ];
        autocapture: false;
        sessionReplay: false;
        personProfiles: false;
      };
      consent: Record<FounderExternalBetaConsentPurpose, ConsentState>;
      recordingRetentionDays: 30;
      exportAvailable: true;
      deletionAvailable: true;
      accessUnaffectedByRefusal: true;
      evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence";
    };

type ConsentState = "not_granted" | "granted" | "refused" | "withdrawn";

export type FounderExternalBetaRecordingProvider = {
  deleteAndVerifyAbsent(input: {
    artifactReferenceDigest: `sha256:${string}`;
  }): Promise<{ absent: true }>;
};

export class BackupStorageFounderExternalBetaRecordingProvider
  implements FounderExternalBetaRecordingProvider
{
  constructor(private readonly storage: DeletableBackupObjectStorage) {}

  async deleteAndVerifyAbsent(input: {
    artifactReferenceDigest: `sha256:${string}`;
  }): Promise<{ absent: true }> {
    const safeBefore = await this.storage.verifyDeletionSafety();
    if (!safeBefore.ok || safeBefore.versioning !== "disabled") {
      throw new Error("External Beta recording storage cannot prove permanent deletion.");
    }
    const key = recordingObjectKey(input.artifactReferenceDigest);
    const deletion = await this.storage.delete({ key });
    if (!deletion.ok) throw new Error("External Beta recording deletion failed.");
    const presence = await this.storage.exists({ key });
    if (!presence.ok || presence.exists) {
      throw new Error("External Beta recording provider absence was not verified.");
    }
    const safeAfter = await this.storage.verifyDeletionSafety();
    if (!safeAfter.ok || safeAfter.versioning !== "disabled") {
      throw new Error("External Beta recording deletion safety changed during verification.");
    }
    return { absent: true };
  }
}

export function createFounderExternalBetaRecordingProvider(): FounderExternalBetaRecordingProvider | null {
  const storage = createBackupObjectStorage();
  return storage ? new BackupStorageFounderExternalBetaRecordingProvider(storage) : null;
}

export function recordingObjectKey(artifactReferenceDigest: `sha256:${string}`): string {
  if (!isDigest(artifactReferenceDigest)) {
    throw new Error("External Beta recording reference is invalid.");
  }
  return `external-beta-recordings/${artifactReferenceDigest.slice("sha256:".length)}.enc`;
}

type Dependencies = {
  createConnection?: () => DatabaseConnection;
};

export async function getFounderExternalBetaPrivacyStatusForUser(
  userId: string,
  dependencies: Dependencies = {},
): Promise<FounderExternalBetaPrivacyStatus> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const membership = await findMembership(connection, userId);
    if (!membership) return { state: "unavailable" };
    const receipts = await connection.db
      .select({
        purpose: founderExternalBetaConsentReceipts.purpose,
        decision: founderExternalBetaConsentReceipts.decision,
      })
      .from(founderExternalBetaConsentReceipts)
      .where(eq(founderExternalBetaConsentReceipts.invitationId, membership.id))
      .orderBy(asc(founderExternalBetaConsentReceipts.decidedAt));
    const consent = Object.fromEntries(
      FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES.map((purpose) => {
        const latest = receipts.findLast((receipt) => receipt.purpose === purpose);
        return [purpose, consentState(latest?.decision)];
      }),
    ) as Record<FounderExternalBetaConsentPurpose, ConsentState>;
    return {
      state: "available",
      collection: {
        allowlistedFacts: [
          "Activation",
          "Journey completion",
          "Timing",
          "Capability state",
          "Safe failure category",
          "Support duration",
        ],
        neverCollected: [
          "Message bodies",
          "Calendar content",
          "Recipients",
          "Prompts",
          "Provider responses",
          "Credentials",
          "Unrestricted metadata",
        ],
        autocapture: false,
        sessionReplay: false,
        personProfiles: false,
      },
      consent,
      recordingRetentionDays: 30,
      exportAvailable: true,
      deletionAvailable: true,
      accessUnaffectedByRefusal: true,
      evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function decideFounderExternalBetaConsent(
  userId: string,
  input: {
    purpose: FounderExternalBetaConsentPurpose;
    decision: FounderExternalBetaConsentDecision;
    decidedAt: Date;
    expectedWorkspaceDigest?: `sha256:${string}`;
  },
  dependencies: Dependencies = {},
): Promise<void> {
  if (!FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES.includes(input.purpose)) {
    throw new Error("External Beta consent purpose is not allowlisted.");
  }
  if (!(["grant", "refuse", "withdraw"] as const).includes(input.decision)) {
    throw new Error("External Beta consent decision is invalid.");
  }
  requireExactInstant(input.decidedAt);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction(async (tx) => {
      const membership = await lockMembership(tx, userId);
      assertWorkspace(membership.workspaceDigest, input.expectedWorkspaceDigest);
      if (
        input.decision === "grant" &&
        (membership.status !== "admitted" ||
          !membership.accessExpiresAt ||
          input.decidedAt < membership.admittedAt ||
          input.decidedAt >= membership.accessExpiresAt)
      ) {
        throw new Error("Active External Beta access is required to grant new consent.");
      }
      const [latest] = await tx
        .select({ decidedAt: founderExternalBetaConsentReceipts.decidedAt })
        .from(founderExternalBetaConsentReceipts)
        .where(
          and(
            eq(founderExternalBetaConsentReceipts.invitationId, membership.id),
            eq(founderExternalBetaConsentReceipts.purpose, input.purpose),
          ),
        )
        .orderBy(desc(founderExternalBetaConsentReceipts.decidedAt))
        .limit(1);
      if (latest && input.decidedAt <= latest.decidedAt) {
        throw new Error("External Beta consent decisions require a later decision instant.");
      }
      await tx.insert(founderExternalBetaConsentReceipts).values({
        invitationId: membership.id,
        participantUserId: membership.participantUserId,
        participantOperatorId: membership.participantOperatorId,
        workspaceDigest: membership.workspaceDigest,
        purpose: input.purpose,
        decision: input.decision,
        decidedAt: input.decidedAt,
        createdAt: input.decidedAt,
      });
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function captureFounderExternalBetaMeasurement(
  userId: string,
  value: unknown,
  capturedAt: Date,
  dependencies: Dependencies & { expectedWorkspaceDigest?: `sha256:${string}` } = {},
): Promise<void> {
  requireExactInstant(capturedAt);
  const measurement = parseFounderExternalBetaMeasurement(value);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction(async (tx) => {
      const membership = await lockMembership(tx, userId);
      assertWorkspace(membership.workspaceDigest, dependencies.expectedWorkspaceDigest);
      if (
        membership.status !== "admitted" ||
        !membership.accessExpiresAt ||
        capturedAt < membership.admittedAt ||
        capturedAt >= membership.accessExpiresAt
      ) {
        throw new Error("Active External Beta access is required for measurement.");
      }
      await requireGrantedConsent(tx, membership.id, "measurement", capturedAt);
      await tx.insert(founderExternalBetaMeasurements).values({
        invitationId: membership.id,
        participantUserId: membership.participantUserId,
        participantOperatorId: membership.participantOperatorId,
        workspaceDigest: membership.workspaceDigest,
        event: measurement.event,
        ...(measurement.event === "journey_completed" ||
        measurement.event === "journey_timing_recorded"
          ? { journey: measurement.journey }
          : {}),
        ...(measurement.event === "journey_timing_recorded" ||
        measurement.event === "support_duration_recorded"
          ? { durationSeconds: measurement.durationSeconds }
          : {}),
        ...(measurement.event === "capability_state_observed"
          ? {
              capability: measurement.capability,
              capabilityState: measurement.capabilityState,
            }
          : {}),
        ...(measurement.event === "safe_failure_observed"
          ? { safeFailureCategory: measurement.safeFailureCategory }
          : {}),
        evidenceClassification: FOUNDER_EXTERNAL_BETA_EVIDENCE_CLASSIFICATION,
        capturedAt,
        createdAt: capturedAt,
      });
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function registerFounderExternalBetaRecording(
  userId: string,
  input: {
    artifactReferenceDigest: `sha256:${string}`;
    recordedAt: Date;
    expectedWorkspaceDigest?: `sha256:${string}`;
  },
  dependencies: Dependencies = {},
): Promise<{ deletionDueAt: string }> {
  if (!isDigest(input.artifactReferenceDigest)) {
    throw new Error("External Beta recording reference is invalid.");
  }
  requireExactInstant(input.recordedAt);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const membership = await lockMembership(tx, userId);
      assertWorkspace(membership.workspaceDigest, input.expectedWorkspaceDigest);
      if (
        membership.status !== "admitted" ||
        !membership.accessExpiresAt ||
        input.recordedAt < membership.admittedAt ||
        input.recordedAt >= membership.accessExpiresAt
      ) {
        throw new Error("Active External Beta access is required for recording.");
      }
      await requireGrantedConsent(tx, membership.id, "recording", input.recordedAt);
      const deletionDueAt = new Date(
        input.recordedAt.valueOf() + FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS,
      );
      await tx.insert(founderExternalBetaRecordings).values({
        invitationId: membership.id,
        participantUserId: membership.participantUserId,
        participantOperatorId: membership.participantOperatorId,
        workspaceDigest: membership.workspaceDigest,
        artifactReferenceDigest: input.artifactReferenceDigest,
        status: "active",
        recordedAt: input.recordedAt,
        deletionDueAt,
        createdAt: input.recordedAt,
        updatedAt: input.recordedAt,
      });
      return { deletionDueAt: deletionDueAt.toISOString() };
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function reconcileFounderExternalBetaRecordingRetention(
  now: Date,
  provider: FounderExternalBetaRecordingProvider | null,
  dependencies: Dependencies = {},
): Promise<{ deleted: number; late: number; failed: number }> {
  requireExactInstant(now);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    // The minute scheduler claims recordings just before their deadline so provider
    // verification can complete without crossing the hard 30-day retention limit.
    const claimThrough = new Date(
      now.valueOf() + FOUNDER_EXTERNAL_BETA_RECORDING_RECONCILIATION_LEAD_MS,
    );
    const due = await connection.db
      .select()
      .from(founderExternalBetaRecordings)
      .where(
        and(
          eq(founderExternalBetaRecordings.status, "active"),
          lte(founderExternalBetaRecordings.deletionDueAt, claimThrough),
        ),
      )
      .orderBy(asc(founderExternalBetaRecordings.deletionDueAt));
    let deleted = 0;
    let late = 0;
    let failed = 0;
    for (const recording of due) {
      try {
        if (!provider) throw new Error("External Beta recording provider is unavailable.");
        const result = await provider.deleteAndVerifyAbsent({
          artifactReferenceDigest: recording.artifactReferenceDigest as `sha256:${string}`,
        });
        if (!result.absent) throw new Error("Recording provider absence was not verified.");
        const retentionOutcome = now > recording.deletionDueAt ? "late" : "within_deadline";
        const deletionReceiptDigest = founderProductContractDigest(
          JSON.stringify({
            kind: "external_beta_recording_deletion",
            recordingId: recording.id,
            artifactReferenceDigest: recording.artifactReferenceDigest,
            deletedAt: now.toISOString(),
            deletionDueAt: recording.deletionDueAt.toISOString(),
            retentionOutcome,
          }),
        );
        const [updated] = await connection.db
          .update(founderExternalBetaRecordings)
          .set({
            status: retentionOutcome === "late" ? "deleted_late" : "deleted",
            deletedAt: now,
            providerDeletionVerified: true,
            deletionReceiptDigest,
            updatedAt: now,
          })
          .where(
            and(
              eq(founderExternalBetaRecordings.id, recording.id),
              eq(founderExternalBetaRecordings.status, "active"),
            ),
          )
          .returning({ id: founderExternalBetaRecordings.id });
        if (updated) {
          deleted += 1;
          if (retentionOutcome === "late") late += 1;
        }
      } catch {
        failed += 1;
      }
    }
    return { deleted, late, failed };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function exportFounderExternalBetaPrivacyData(
  userId: string,
  dependencies: Dependencies = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const membership = await findMembership(connection, userId);
    if (!membership) throw new Error("External Beta privacy controls are unavailable.");
    const [consent, measurements, recordings] = await Promise.all([
      connection.db
        .select({
          purpose: founderExternalBetaConsentReceipts.purpose,
          decision: founderExternalBetaConsentReceipts.decision,
          decidedAt: founderExternalBetaConsentReceipts.decidedAt,
        })
        .from(founderExternalBetaConsentReceipts)
        .where(eq(founderExternalBetaConsentReceipts.invitationId, membership.id))
        .orderBy(asc(founderExternalBetaConsentReceipts.decidedAt)),
      connection.db
        .select({
          event: founderExternalBetaMeasurements.event,
          journey: founderExternalBetaMeasurements.journey,
          durationSeconds: founderExternalBetaMeasurements.durationSeconds,
          capability: founderExternalBetaMeasurements.capability,
          capabilityState: founderExternalBetaMeasurements.capabilityState,
          safeFailureCategory: founderExternalBetaMeasurements.safeFailureCategory,
          evidenceClassification: founderExternalBetaMeasurements.evidenceClassification,
          capturedAt: founderExternalBetaMeasurements.capturedAt,
        })
        .from(founderExternalBetaMeasurements)
        .where(eq(founderExternalBetaMeasurements.invitationId, membership.id))
        .orderBy(asc(founderExternalBetaMeasurements.capturedAt)),
      connection.db
        .select({
          status: founderExternalBetaRecordings.status,
          recordedAt: founderExternalBetaRecordings.recordedAt,
          deletionDueAt: founderExternalBetaRecordings.deletionDueAt,
          deletedAt: founderExternalBetaRecordings.deletedAt,
          providerDeletionVerified: founderExternalBetaRecordings.providerDeletionVerified,
          deletionReceiptDigest: founderExternalBetaRecordings.deletionReceiptDigest,
        })
        .from(founderExternalBetaRecordings)
        .where(eq(founderExternalBetaRecordings.invitationId, membership.id))
        .orderBy(asc(founderExternalBetaRecordings.recordedAt)),
    ]);
    return {
      schemaVersion: "bruno.external-beta-privacy-export.v1" as const,
      evidenceClassification: FOUNDER_EXTERNAL_BETA_EVIDENCE_CLASSIFICATION,
      consent: consent.map((receipt) => ({
        ...receipt,
        decidedAt: receipt.decidedAt.toISOString(),
      })),
      measurements: measurements.map((measurement) => ({
        ...measurement,
        capturedAt: measurement.capturedAt.toISOString(),
      })),
      recordings: recordings.map((recording) => ({
        ...recording,
        recordedAt: recording.recordedAt.toISOString(),
        deletionDueAt: recording.deletionDueAt.toISOString(),
        deletedAt: recording.deletedAt?.toISOString() ?? null,
      })),
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function deleteFounderExternalBetaMeasurements(
  userId: string,
  dependencies: Dependencies = {},
): Promise<{ deleted: number }> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const membership = await findMembership(connection, userId);
    if (!membership) throw new Error("External Beta privacy controls are unavailable.");
    const deleted = await connection.db
      .delete(founderExternalBetaMeasurements)
      .where(eq(founderExternalBetaMeasurements.invitationId, membership.id))
      .returning({ id: founderExternalBetaMeasurements.id });
    return { deleted: deleted.length };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function parseFounderExternalBetaMeasurement(
  value: unknown,
): FounderExternalBetaMeasurement {
  if (!isRecord(value) || typeof value.event !== "string") {
    throw new Error("External Beta measurement is invalid.");
  }
  switch (value.event) {
    case "activation_completed":
      requireExactKeys(value, ["event"]);
      return { event: value.event };
    case "journey_completed":
      requireExactKeys(value, ["event", "journey"]);
      if (!isJourney(value.journey)) throw new Error("External Beta journey is not allowlisted.");
      return { event: value.event, journey: value.journey };
    case "journey_timing_recorded":
      requireExactKeys(value, ["durationSeconds", "event", "journey"]);
      if (!isJourney(value.journey)) throw new Error("External Beta journey is not allowlisted.");
      requireDuration(value.durationSeconds);
      return {
        event: value.event,
        journey: value.journey,
        durationSeconds: value.durationSeconds,
      };
    case "capability_state_observed":
      requireExactKeys(value, ["capability", "capabilityState", "event"]);
      if (!isCapability(value.capability)) {
        throw new Error("External Beta capability is not allowlisted.");
      }
      if (value.capabilityState !== "available" && value.capabilityState !== "paused") {
        throw new Error("External Beta capability state is not allowlisted.");
      }
      return {
        event: value.event,
        capability: value.capability,
        capabilityState: value.capabilityState,
      };
    case "safe_failure_observed":
      requireExactKeys(value, ["event", "safeFailureCategory"]);
      if (!isSafeFailureCategory(value.safeFailureCategory)) {
        throw new Error("External Beta failure category is not allowlisted.");
      }
      return { event: value.event, safeFailureCategory: value.safeFailureCategory };
    case "support_duration_recorded":
      requireExactKeys(value, ["durationSeconds", "event"]);
      requireDuration(value.durationSeconds);
      return { event: value.event, durationSeconds: value.durationSeconds };
    default:
      throw new Error("External Beta measurement event is not allowlisted.");
  }
}

type Membership = {
  id: string;
  status: string;
  participantUserId: string;
  participantOperatorId: string;
  workspaceDigest: string;
  admittedAt: Date;
  accessExpiresAt: Date | null;
};

async function findMembership(
  connection: DatabaseConnection,
  userId: string,
): Promise<Membership | null> {
  const [membership] = await connection.db
    .select({
      id: founderExternalBetaInvitations.id,
      status: founderExternalBetaInvitations.status,
      participantUserId: founderExternalBetaInvitations.participantUserId,
      participantOperatorId: founderExternalBetaInvitations.participantOperatorId,
      workspaceDigest: founderExternalBetaInvitations.workspaceDigest,
      admittedAt: founderExternalBetaInvitations.admittedAt,
      accessExpiresAt: founderExternalBetaInvitations.accessExpiresAt,
    })
    .from(founderExternalBetaInvitations)
    .where(eq(founderExternalBetaInvitations.participantUserId, userId))
    .orderBy(desc(founderExternalBetaInvitations.admittedAt))
    .limit(1);
  if (
    !membership?.participantUserId ||
    !membership.participantOperatorId ||
    !membership.admittedAt
  ) {
    return null;
  }
  return membership as Membership;
}

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

async function lockMembership(tx: Transaction, userId: string): Promise<Membership> {
  const [membership] = await tx
    .select({
      id: founderExternalBetaInvitations.id,
      status: founderExternalBetaInvitations.status,
      participantUserId: founderExternalBetaInvitations.participantUserId,
      participantOperatorId: founderExternalBetaInvitations.participantOperatorId,
      workspaceDigest: founderExternalBetaInvitations.workspaceDigest,
      admittedAt: founderExternalBetaInvitations.admittedAt,
      accessExpiresAt: founderExternalBetaInvitations.accessExpiresAt,
    })
    .from(founderExternalBetaInvitations)
    .where(eq(founderExternalBetaInvitations.participantUserId, userId))
    .orderBy(desc(founderExternalBetaInvitations.admittedAt))
    .limit(1)
    .for("update");
  if (
    !membership?.participantUserId ||
    !membership.participantOperatorId ||
    !membership.admittedAt
  ) {
    throw new Error("External Beta privacy controls are unavailable.");
  }
  return membership as Membership;
}

async function requireGrantedConsent(
  tx: Transaction,
  invitationId: string,
  purpose: "measurement" | "recording",
  asOf: Date,
): Promise<void> {
  const [receipt] = await tx
    .select({ decision: founderExternalBetaConsentReceipts.decision })
    .from(founderExternalBetaConsentReceipts)
    .where(
      and(
        eq(founderExternalBetaConsentReceipts.invitationId, invitationId),
        eq(founderExternalBetaConsentReceipts.purpose, purpose),
        lte(founderExternalBetaConsentReceipts.decidedAt, asOf),
      ),
    )
    .orderBy(desc(founderExternalBetaConsentReceipts.decidedAt))
    .limit(1);
  if (receipt?.decision !== "grant") {
    throw new Error(`Separate ${purpose} consent is required.`);
  }
}

function assertWorkspace(actual: string, expected?: `sha256:${string}`): void {
  if (expected !== undefined && actual !== expected) {
    throw new Error("External Beta workspace boundary did not match.");
  }
}

function consentState(decision: string | undefined): ConsentState {
  if (decision === "grant") return "granted";
  if (decision === "refuse") return "refused";
  if (decision === "withdraw") return "withdrawn";
  return "not_granted";
}

function requireDuration(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 2_592_000) {
    throw new Error("External Beta duration is outside the allowlist boundary.");
  }
}

function requireExactInstant(value: Date): void {
  if (Number.isNaN(value.valueOf())) {
    throw new Error("External Beta privacy instant is invalid.");
  }
}

function requireExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("External Beta measurement contains a non-allowlisted property.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJourney(value: unknown): value is FounderExternalBetaJourney {
  return (
    typeof value === "string" &&
    FOUNDER_EXTERNAL_BETA_JOURNEYS.includes(value as FounderExternalBetaJourney)
  );
}

function isCapability(value: unknown): value is FounderExternalBetaCapability {
  return (
    typeof value === "string" &&
    FOUNDER_EXTERNAL_BETA_CAPABILITIES.includes(value as FounderExternalBetaCapability)
  );
}

function isSafeFailureCategory(value: unknown): value is FounderExternalBetaSafeFailureCategory {
  return (
    typeof value === "string" &&
    FOUNDER_EXTERNAL_BETA_SAFE_FAILURE_CATEGORIES.includes(
      value as FounderExternalBetaSafeFailureCategory,
    )
  );
}

function isDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
