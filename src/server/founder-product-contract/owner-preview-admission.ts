import "server-only";

import { and, desc, eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderRecoveryArchives, founderReleaseDecisions, users } from "@/src/server/db/schema";
import { evaluateFounderGoogleCalendarRelease } from "@/src/server/operators/founder-google-reading-release";
import { evaluateFounderOpenAiRelease } from "@/src/server/operators/founder-openai-release";
import { founderProductContractDigest } from "./digest";
import { createEncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import {
  type FounderProductContractTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

export type FounderOwnerPreviewAdmissionDependencies = {
  applicationRevision?: string;
  createConnection?: () => DatabaseConnection;
  createProvider?: () => FounderRecoveryArchiveProvider | null;
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

type QualifiedOwnerPreviewAdmissionInput = {
  userId: string;
  operatorId: string;
  applicationRevision: string;
  runtimeRevision: string;
  identitySubject: string;
  qualificationEvidenceDigests: readonly `sha256:${string}`[];
  recoveryArchiveId: string;
  now: Date;
};

export async function admitFounderOperatorToOwnerPreview(
  userId: string,
  dependencies: FounderOwnerPreviewAdmissionDependencies = {},
): Promise<{ archiveId: string }> {
  const now = dependencies.now?.() ?? new Date();
  const environment = dependencies.env ?? process.env;
  const applicationRevision =
    dependencies.applicationRevision ?? environment.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/.test(applicationRevision)) {
    throw new Error("Owner Preview application revision is unavailable.");
  }
  const openAIQualification = evaluateFounderOpenAiRelease(environment, now);
  if (!openAIQualification.released) {
    throw new Error("Owner Preview OpenAI qualification is unavailable.");
  }
  const calendarQualification = evaluateFounderGoogleCalendarRelease(environment, now);
  if (!calendarQualification.released) {
    throw new Error("Owner Preview Calendar qualification is unavailable.");
  }
  const provider = dependencies.createProvider
    ? dependencies.createProvider()
    : createEncryptedFounderRecoveryArchiveProvider();
  if (!provider) throw new Error("Recovery Archive provider is unavailable.");
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!identity?.subject) {
      throw new Error("Owner Preview requires an authenticated Clerk identity.");
    }
    const identitySubject = identity.subject;
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId, now },
      provider,
      connection,
    );
    await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, userId);
      const [archive] = await tx
        .select({ id: founderRecoveryArchives.id })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.id, archiveId),
            eq(founderRecoveryArchives.userId, userId),
            eq(founderRecoveryArchives.status, "verified"),
            eq(founderRecoveryArchives.formatVersion, 1),
            eq(founderRecoveryArchives.restorableVerified, true),
          ),
        )
        .limit(1);
      if (!archive) throw new Error("A verified-restorable Recovery Archive is required.");
      await persistQualifiedFounderOwnerPreviewAdmissionInTransaction(tx, {
        userId,
        operatorId,
        applicationRevision,
        runtimeRevision,
        identitySubject,
        qualificationEvidenceDigests: [
          openAIQualification.evidence.evidenceDigest,
          calendarQualification.evidence.evidenceDigest,
        ],
        recoveryArchiveId: archiveId,
        now,
      });
    });
    return { archiveId };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function persistQualifiedFounderOwnerPreviewAdmissionInTransaction(
  tx: FounderProductContractTransaction,
  input: QualifiedOwnerPreviewAdmissionInput,
): Promise<void> {
  if (!input.identitySubject.trim() || input.qualificationEvidenceDigests.length === 0) {
    throw new Error("Owner Preview qualification evidence is incomplete.");
  }
  const capabilityManifest = ["openai", "calendar_reading"] as const;
  const archiveEvidenceDigest = founderProductContractDigest(
    `recovery-archive:${input.recoveryArchiveId}`,
  );
  const evidenceDigests = [
    founderProductContractDigest(`clerk:${input.identitySubject}`),
    ...input.qualificationEvidenceDigests,
    archiveEvidenceDigest,
  ];
  const existingCandidates = await tx
    .select({
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
      evidenceDigests: founderReleaseDecisions.evidenceDigests,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, input.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        eq(founderReleaseDecisions.outcome, "enter"),
        eq(founderReleaseDecisions.applicationRevision, input.applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, input.runtimeRevision),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt));
  const alreadyQualified = existingCandidates.some(
    (decision) =>
      decision.capabilityManifest.length === capabilityManifest.length &&
      capabilityManifest.every((capability) => decision.capabilityManifest.includes(capability)) &&
      evidenceDigests.every((digest) => decision.evidenceDigests.includes(digest)),
  );
  if (alreadyQualified) return;
  await tx.insert(founderReleaseDecisions).values({
    userId: input.userId,
    operatorId: input.operatorId,
    stage: "owner_preview",
    outcome: "enter",
    applicationRevision: input.applicationRevision,
    runtimeRevision: input.runtimeRevision,
    capabilityManifest,
    evidenceDigests,
    decidedAt: input.now,
    createdAt: input.now,
  });
}
