import "server-only";

import { and, desc, eq, gt, inArray, lte } from "drizzle-orm";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderRecoveryArchives, founderReleaseDecisions, users } from "@/src/server/db/schema";
import { evaluateFounderGoogleCalendarRelease } from "@/src/server/operators/founder-google-reading-release";
import { evaluateFounderOpenAiRelease } from "@/src/server/operators/founder-openai-release";
import { requireFounderApplicationRevision } from "./application-revision";
import { founderProductContractDigest } from "./digest";
import { createEncryptedFounderRecoveryArchiveProvider } from "./encrypted-recovery-archive-provider";
import {
  type FounderProductContractTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import {
  type FounderOwnerPreviewDenialReason,
  persistFounderOwnerPreviewDenialInTransaction,
  requireFounderOwnerPreviewOwnerMappingInTransaction,
} from "./owner-preview-release-decision";
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
  identityKind: "clerk" | "operator";
  identitySubject: string;
  qualificationEvidenceDigests: readonly `sha256:${string}`[];
  freshQualificationEvidenceDigests: readonly `sha256:${string}`[];
  qualificationObservedAt: Date;
  qualificationExpiresAt: Readonly<Record<"openai" | "calendar_reading", Date>>;
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
  const applicationRevision = requireFounderApplicationRevision(
    { applicationRevision: dependencies.applicationRevision, env: environment },
    "Owner Preview application revision is unavailable.",
  );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  let authority: { operatorId: string; runtimeRevision: string } | null = null;
  let hadPriorAdmission = false;
  let denialReason: FounderOwnerPreviewDenialReason = "admission_evidence_incomplete";
  let denialEvidenceDigests: readonly `sha256:${string}`[] = [];

  try {
    const [identity] = await connection.db
      .select({ subject: users.clerkUserId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const authMode = resolveAuthMode(environment).mode;
    const identityEvidence =
      authMode === "operator"
        ? { kind: "operator" as const, subject: userId }
        : identity?.subject
          ? { kind: "clerk" as const, subject: identity.subject }
          : null;
    authority = await connection.db.transaction((tx) =>
      requireReadyFounderOperatorAuthorityInTransaction(tx, userId),
    );
    const candidateAuthority = authority;
    const [priorAdmission] = await connection.db
      .select({ id: founderReleaseDecisions.id })
      .from(founderReleaseDecisions)
      .where(
        and(
          eq(founderReleaseDecisions.userId, userId),
          eq(founderReleaseDecisions.operatorId, candidateAuthority.operatorId),
          eq(founderReleaseDecisions.stage, "owner_preview"),
          inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
          eq(founderReleaseDecisions.applicationRevision, applicationRevision),
          eq(founderReleaseDecisions.runtimeRevision, candidateAuthority.runtimeRevision),
        ),
      )
      .limit(1);
    hadPriorAdmission = Boolean(priorAdmission);
    if (!identityEvidence) {
      denialReason = "identity_unavailable";
      throw new Error("Owner Preview requires an authenticated production identity.");
    }
    await connection.db.transaction((tx) =>
      requireFounderOwnerPreviewOwnerMappingInTransaction(tx, userId, false),
    );
    const openAIQualification = evaluateFounderOpenAiRelease(environment, now);
    if (!openAIQualification.released) {
      denialReason = "provider_gate_unavailable";
      throw new Error("Owner Preview OpenAI qualification is unavailable.");
    }
    const calendarQualification = evaluateFounderGoogleCalendarRelease(environment, now);
    if (!calendarQualification.released) {
      denialReason = "provider_gate_unavailable";
      throw new Error("Owner Preview Calendar qualification is unavailable.");
    }
    denialReason = "preview_qualification_unavailable";
    const initialPreviewQualifications = requireFounderOwnerPreviewQualifications(
      {
        userId,
        operatorId: candidateAuthority.operatorId,
        applicationRevision,
        runtimeRevision: candidateAuthority.runtimeRevision,
        now,
      },
      environment,
    );
    denialEvidenceDigests = [
      ...initialPreviewQualifications.map((qualification) => qualification.evidenceDigest),
      openAIQualification.evidence.evidenceDigest,
      calendarQualification.evidence.evidenceDigest,
    ];
    denialReason = "recovery_archive_unavailable";
    const provider = dependencies.createProvider
      ? dependencies.createProvider()
      : createEncryptedFounderRecoveryArchiveProvider();
    if (!provider) throw new Error("Recovery Archive provider is unavailable.");
    const archiveId = await createDurableRecoveryArchive(
      { action: "release_stage_admission", userId, now, applicationRevision },
      provider,
      connection,
      clock,
    );
    denialReason = "admission_evidence_incomplete";
    await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, userId);
      if (
        operatorId !== candidateAuthority.operatorId ||
        runtimeRevision !== candidateAuthority.runtimeRevision
      ) {
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
            eq(founderRecoveryArchives.applicationRevision, applicationRevision),
            eq(founderRecoveryArchives.runtimeRevision, runtimeRevision),
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
        identityKind: identityEvidence.kind,
        identitySubject: identityEvidence.subject,
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
        qualificationExpiresAt: {
          openai: new Date(
            committedPreviewQualifications.find(
              (qualification) => qualification.capability === "openai",
            )?.expiresAt ?? "",
          ),
          calendar_reading: new Date(
            committedPreviewQualifications.find(
              (qualification) => qualification.capability === "calendar_reading",
            )?.expiresAt ?? "",
          ),
        },
        recoveryArchiveId: archiveId,
        now: committedAt,
      });
    });
    return { archiveId };
  } catch (error) {
    if (authority && !hadPriorAdmission) {
      const reason = isOwnerMappingMismatch(error) ? "owner_mismatch" : denialReason;
      await connection.db.transaction((tx) =>
        persistFounderOwnerPreviewDenialInTransaction(tx, {
          userId,
          operatorId: authority?.operatorId ?? "",
          applicationRevision,
          runtimeRevision: authority?.runtimeRevision ?? "",
          reason,
          evidenceDigests: denialEvidenceDigests,
          decidedAt: clock(),
        }),
      );
    }
    throw error;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function persistQualifiedFounderOwnerPreviewAdmissionInTransaction(
  tx: FounderProductContractTransaction,
  input: QualifiedOwnerPreviewAdmissionInput,
): Promise<void> {
  if (
    !input.identitySubject.trim() ||
    input.qualificationEvidenceDigests.length === 0 ||
    Number.isNaN(input.qualificationExpiresAt.openai.valueOf()) ||
    Number.isNaN(input.qualificationExpiresAt.calendar_reading.valueOf()) ||
    input.qualificationExpiresAt.openai <= input.now ||
    input.qualificationExpiresAt.calendar_reading <= input.now
  ) {
    throw new Error("Owner Preview qualification evidence is incomplete.");
  }
  const capabilityManifest = FOUNDER_OWNER_PREVIEW_CAPABILITIES;
  await requireFounderOwnerPreviewOwnerMappingInTransaction(tx, input.userId, true);
  const archiveEvidenceDigest = founderProductContractDigest(
    `recovery-archive:${input.recoveryArchiveId}`,
  );
  const evidenceDigests = [
    founderProductContractDigest(`${input.identityKind}:${input.identitySubject}`),
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
  const [latestHold] = await tx
    .select({ decidedAt: founderReleaseDecisions.decidedAt })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, input.userId),
        eq(founderReleaseDecisions.operatorId, input.operatorId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        eq(founderReleaseDecisions.outcome, "hold"),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1)
    .for("update");
  const [priorActiveDecision] = await tx
    .select({
      evidenceDigests: founderReleaseDecisions.evidenceDigests,
      decidedAt: founderReleaseDecisions.decidedAt,
    })
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
  const held = Boolean(
    latestHold && (!priorActiveDecision || latestHold.decidedAt > priorActiveDecision.decidedAt),
  );
  if (held) {
    if (
      input.qualificationObservedAt <= (latestHold?.decidedAt ?? input.now) ||
      input.freshQualificationEvidenceDigests.length === 0 ||
      !priorActiveDecision ||
      input.freshQualificationEvidenceDigests.some((digest) =>
        priorActiveDecision.evidenceDigests.includes(digest),
      )
    ) {
      throw new Error("Release Hold requires fresh Preview Qualification evidence.");
    }
  }
  const decidedAt =
    latestDecision && input.now <= latestDecision.decidedAt
      ? new Date(latestDecision.decidedAt.valueOf() + 1)
      : input.now;
  await tx.insert(founderReleaseDecisions).values({
    userId: input.userId,
    operatorId: input.operatorId,
    stage: "owner_preview",
    outcome: held ? "resume" : "enter",
    applicationRevision: input.applicationRevision,
    runtimeRevision: input.runtimeRevision,
    capabilityManifest,
    openAiQualificationExpiresAt: input.qualificationExpiresAt.openai,
    calendarQualificationExpiresAt: input.qualificationExpiresAt.calendar_reading,
    evidenceDigests,
    decidedAt,
    createdAt: decidedAt,
  });
}

function isOwnerMappingMismatch(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === "Owner Preview is restricted to the mapped Bruno.Ai Owner."
  );
}
