import "server-only";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
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
import {
  FOUNDER_OWNER_PREVIEW_CAPABILITIES,
  requireFounderOwnerPreviewQualifications,
} from "./preview-qualification";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

const OWNER_PREVIEW_ARCHIVE_WINDOW_MS = 24 * 60 * 60 * 1_000;

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
  freshQualificationEvidenceDigests: readonly `sha256:${string}`[];
  qualificationObservedAt: Date;
  recoveryArchiveId: string;
  now: Date;
};

export async function admitFounderOperatorToOwnerPreview(
  userId: string,
  dependencies: FounderOwnerPreviewAdmissionDependencies = {},
): Promise<{ archiveId: string }> {
  const clock = dependencies.now ?? (() => new Date());
  const now = clock();
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
    const authority = await connection.db.transaction((tx) =>
      requireReadyFounderOperatorAuthorityInTransaction(tx, userId),
    );
    requireFounderOwnerPreviewQualifications(
      {
        userId,
        operatorId: authority.operatorId,
        applicationRevision,
        runtimeRevision: authority.runtimeRevision,
        now,
      },
      environment,
    );
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId, now },
      provider,
      connection,
      clock,
    );
    await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, userId);
      if (operatorId !== authority.operatorId || runtimeRevision !== authority.runtimeRevision) {
        throw new Error("Owner Preview authority changed during admission.");
      }
      const committedAt = clock();
      const committedOpenAIQualification = evaluateFounderOpenAiRelease(environment, committedAt);
      if (!committedOpenAIQualification.released) {
        throw new Error("Owner Preview OpenAI qualification is unavailable.");
      }
      const committedCalendarQualification = evaluateFounderGoogleCalendarRelease(
        environment,
        committedAt,
      );
      if (!committedCalendarQualification.released) {
        throw new Error("Owner Preview Calendar qualification is unavailable.");
      }
      const committedPreviewQualifications = requireFounderOwnerPreviewQualifications(
        {
          userId,
          operatorId,
          applicationRevision,
          runtimeRevision,
          now: committedAt,
        },
        environment,
      );
      const [archive] = await tx
        .select({ id: founderRecoveryArchives.id })
        .from(founderRecoveryArchives)
        .where(
          and(
            eq(founderRecoveryArchives.id, archiveId),
            eq(founderRecoveryArchives.userId, userId),
            eq(founderRecoveryArchives.operatorId, operatorId),
            eq(founderRecoveryArchives.status, "verified"),
            eq(founderRecoveryArchives.formatVersion, 1),
            eq(founderRecoveryArchives.restorableVerified, true),
            lte(founderRecoveryArchives.observedAt, committedAt),
            gt(
              founderRecoveryArchives.observedAt,
              new Date(committedAt.valueOf() - OWNER_PREVIEW_ARCHIVE_WINDOW_MS),
            ),
            gt(founderRecoveryArchives.expiresAt, committedAt),
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
          ...committedPreviewQualifications.map((qualification) => qualification.evidenceDigest),
          committedOpenAIQualification.evidence.evidenceDigest,
          committedCalendarQualification.evidence.evidenceDigest,
        ],
        freshQualificationEvidenceDigests: committedPreviewQualifications.map(
          (qualification) => qualification.evidenceDigest,
        ),
        qualificationObservedAt: new Date(
          Math.min(
            ...committedPreviewQualifications.map((qualification) =>
              new Date(qualification.qualifiedAt).valueOf(),
            ),
          ),
        ),
        recoveryArchiveId: archiveId,
        now: committedAt,
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
  const capabilityManifest = FOUNDER_OWNER_PREVIEW_CAPABILITIES;
  const archiveEvidenceDigest = founderProductContractDigest(
    `recovery-archive:${input.recoveryArchiveId}`,
  );
  const evidenceDigests = [
    founderProductContractDigest(`clerk:${input.identitySubject}`),
    ...input.qualificationEvidenceDigests,
    archiveEvidenceDigest,
  ];
  const [latestDecision] = await tx
    .select({
      outcome: founderReleaseDecisions.outcome,
      decidedAt: founderReleaseDecisions.decidedAt,
      applicationRevision: founderReleaseDecisions.applicationRevision,
      runtimeRevision: founderReleaseDecisions.runtimeRevision,
      capabilityManifest: founderReleaseDecisions.capabilityManifest,
      evidenceDigests: founderReleaseDecisions.evidenceDigests,
    })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, input.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1)
    .for("update");
  const alreadyQualified =
    (latestDecision?.outcome === "enter" || latestDecision?.outcome === "resume") &&
    latestDecision.applicationRevision === input.applicationRevision &&
    latestDecision.runtimeRevision === input.runtimeRevision &&
    latestDecision.capabilityManifest.length === capabilityManifest.length &&
    capabilityManifest.every((capability) =>
      latestDecision.capabilityManifest.includes(capability),
    ) &&
    evidenceDigests.every((digest) => latestDecision.evidenceDigests.includes(digest));
  if (alreadyQualified) return;
  if (latestDecision?.outcome === "hold") {
    const [priorActiveDecision] = await tx
      .select({ evidenceDigests: founderReleaseDecisions.evidenceDigests })
      .from(founderReleaseDecisions)
      .where(
        and(
          eq(founderReleaseDecisions.userId, input.userId),
          eq(founderReleaseDecisions.operatorId, input.operatorId),
          eq(founderReleaseDecisions.stage, "owner_preview"),
          inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
        ),
      )
      .orderBy(desc(founderReleaseDecisions.decidedAt))
      .limit(1)
      .for("update");
    if (
      input.qualificationObservedAt <= latestDecision.decidedAt ||
      input.freshQualificationEvidenceDigests.length === 0 ||
      !priorActiveDecision ||
      input.freshQualificationEvidenceDigests.some((digest) =>
        priorActiveDecision.evidenceDigests.includes(digest),
      )
    ) {
      throw new Error("Release Hold requires fresh Preview Qualification evidence.");
    }
  }
  await tx.insert(founderReleaseDecisions).values({
    userId: input.userId,
    operatorId: input.operatorId,
    stage: "owner_preview",
    outcome: latestDecision?.outcome === "hold" ? "resume" : "enter",
    applicationRevision: input.applicationRevision,
    runtimeRevision: input.runtimeRevision,
    capabilityManifest,
    evidenceDigests,
    decidedAt: input.now,
    createdAt: input.now,
  });
}
