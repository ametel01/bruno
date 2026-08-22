import { and, desc, eq, inArray } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { founderReleaseDecisions } from "@/src/server/db/schema";
import type { DigitalOceanOwnedSetProvider } from "@/src/server/runners/digitalocean-provider";
import { expireFounderRecoveryArchivesForUser } from "./archive-expiry";
import { founderProductContractDigest } from "./digest";
import { reconcileFounderCommerceEvent } from "./entitlement";
import { executeFounderInfrastructureRetirement } from "./infrastructure-retirement";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import { persistQualifiedFounderOwnerPreviewAdmissionInTransaction } from "./owner-preview-admission";
import { persistFounderOwnerPreviewDenialInTransaction } from "./owner-preview-release-decision";
import { FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS } from "./preview-qualification";
import { persistFounderOwnerPreviewHoldInTransaction } from "./release-stage-hold";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";

export type FounderProductContractLifecycleAction =
  | "release_stage_admission"
  | "product_entitlement_lifecycle"
  | "recovery_archive_lifecycle"
  | "infrastructure_retirement";

export type FounderCommerceEvent = {
  eventId: string;
  checkoutCorrelation: string;
  subscriptionId: string;
  status: FounderCommerceStatus;
  endsAt: string | null;
  occurredAt: string;
  signature: string;
};

export type FounderCommerceStatus =
  | "active"
  | "past_due"
  | "unpaid"
  | "cancelled"
  | "expired"
  | "refunded";

export type FounderLifecycleProviderBoundary = FounderRecoveryArchiveProvider & {
  authenticateIdentity(input: { userId: string }): Promise<{ subject: string }>;
  verifyCapabilityProviders(): Promise<{
    openAI: true;
    anthropic: true;
    google: true;
  }>;
  readSubscription(input: { subscriptionId: string }): Promise<{ status: FounderCommerceStatus }>;
  digitalOcean: DigitalOceanOwnedSetProvider;
  calls(): readonly string[];
};

export type FounderLifecycleCleanup = {
  resourcesBefore: number;
  resourcesAfter: number;
  verified: boolean;
  observedAt: string;
};

export type FounderLifecycleOutcome = {
  action: FounderProductContractLifecycleAction;
  status: "passed";
  observedAt: string;
  providerCalls: readonly string[];
  cleanup: FounderLifecycleCleanup;
};

type LifecycleInput = {
  action: FounderProductContractLifecycleAction;
  runId: string;
  userId: string;
  now: Date;
  commerceEvent?: FounderCommerceEvent;
};

type LifecycleDependencies = {
  providers: FounderLifecycleProviderBoundary;
  commerceWebhookSecret: string;
  applicationRevision: string;
  providerRequestTimeoutMilliseconds?: number;
  createConnection?: () => DatabaseConnection;
};

export async function executeFounderProductContractLifecycleAction(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
): Promise<FounderLifecycleOutcome> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    if (input.action !== "infrastructure_retirement") {
      await expireFounderRecoveryArchivesForUser(
        input.userId,
        input.now,
        dependencies.providers,
        connection,
      );
    }
    if (input.action === "infrastructure_retirement") {
      await connection.db.transaction(async (tx) => {
        await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
        await reconcileFounderCommerceEvent(tx, input, dependencies);
      });
      const cleanup = await executeFounderInfrastructureRetirement(
        { ...input, action: "infrastructure_retirement" },
        {
          providers: dependencies.providers,
          applicationRevision: dependencies.applicationRevision,
          ...(dependencies.providerRequestTimeoutMilliseconds !== undefined
            ? {
                providerRequestTimeoutMilliseconds: dependencies.providerRequestTimeoutMilliseconds,
              }
            : {}),
        },
        connection,
      );
      return lifecycleOutcome(input, dependencies.providers, cleanup);
    }
    const lifecycleArchiveId =
      input.action === "release_stage_admission" || input.action === "recovery_archive_lifecycle"
        ? await createDurableRecoveryArchive(
            { ...input, applicationRevision: dependencies.applicationRevision },
            dependencies.providers,
            connection,
            () => input.now,
          )
        : null;
    return await connection.db.transaction(async (tx) => {
      const { operatorId, runtimeRevision } =
        await requireReadyFounderOperatorAuthorityInTransaction(tx, input.userId);

      const cleanup = emptyCleanup(input.now);
      switch (input.action) {
        case "release_stage_admission": {
          const identity = await dependencies.providers.authenticateIdentity({
            userId: input.userId,
          });
          if (!identity.subject) throw new Error("Clerk identity authentication was inconclusive.");
          const capabilities = await dependencies.providers.verifyCapabilityProviders();
          if (!capabilities.openAI || !capabilities.google) {
            throw new Error("Owner Preview provider qualification was inconclusive.");
          }
          if (!lifecycleArchiveId) throw new Error("A verified Recovery Archive is required.");
          const qualificationEvidenceDigests = [
            founderProductContractDigest(
              JSON.stringify({ capability: "openai", qualifiedAt: input.now.toISOString() }),
            ),
            founderProductContractDigest(
              JSON.stringify({
                capability: "calendar_reading",
                qualifiedAt: input.now.toISOString(),
              }),
            ),
          ];
          await persistQualifiedFounderOwnerPreviewAdmissionInTransaction(tx, {
            userId: input.userId,
            operatorId,
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            identityKind: "clerk",
            identitySubject: identity.subject,
            qualificationEvidenceDigests,
            freshQualificationEvidenceDigests: qualificationEvidenceDigests,
            qualificationObservedAt: input.now,
            qualificationExpiresAt: {
              openai: new Date(input.now.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS),
              calendar_reading: new Date(
                input.now.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS,
              ),
            },
            recoveryArchiveId: lifecycleArchiveId,
            now: input.now,
          });
          const holdAt = new Date(input.now.valueOf() + 1);
          await persistFounderOwnerPreviewHoldInTransaction(tx, {
            userId: input.userId,
            operatorId,
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            affectedCapabilities: ["calendar_reading"],
            evidenceDigests: [
              founderProductContractDigest(
                JSON.stringify({ kind: "founder_contract_release_hold", at: holdAt.toISOString() }),
              ),
            ],
            decidedAt: holdAt,
          });
          const resumeAt = new Date(holdAt.valueOf() + 1);
          const resumedQualificationEvidenceDigests = [
            founderProductContractDigest(
              JSON.stringify({ capability: "openai", qualifiedAt: resumeAt.toISOString() }),
            ),
            founderProductContractDigest(
              JSON.stringify({
                capability: "calendar_reading",
                qualifiedAt: resumeAt.toISOString(),
              }),
            ),
          ];
          await persistQualifiedFounderOwnerPreviewAdmissionInTransaction(tx, {
            userId: input.userId,
            operatorId,
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            identityKind: "clerk",
            identitySubject: identity.subject,
            qualificationEvidenceDigests: resumedQualificationEvidenceDigests,
            freshQualificationEvidenceDigests: resumedQualificationEvidenceDigests,
            qualificationObservedAt: resumeAt,
            qualificationExpiresAt: {
              openai: new Date(resumeAt.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS),
              calendar_reading: new Date(
                resumeAt.valueOf() + FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS,
              ),
            },
            recoveryArchiveId: lifecycleArchiveId,
            now: resumeAt,
          });
          cleanup.observedAt = resumeAt.toISOString();
          break;
        }
        case "product_entitlement_lifecycle": {
          await requireReleaseDecision(
            tx,
            input.userId,
            dependencies.applicationRevision,
            runtimeRevision,
          );
          await reconcileFounderCommerceEvent(tx, input, dependencies);
          break;
        }
        case "recovery_archive_lifecycle": {
          if (!lifecycleArchiveId) throw new Error("A verified Recovery Archive is required.");
          break;
        }
        case "infrastructure_retirement":
          throw new Error("Infrastructure Retirement must use its durable execution path.");
      }

      return {
        action: input.action,
        status: "passed",
        observedAt: input.now.toISOString(),
        providerCalls: dependencies.providers.calls(),
        cleanup,
      };
    });
  } catch (error) {
    if (input.action === "release_stage_admission") {
      await connection.db.transaction(async (tx) => {
        const { operatorId, runtimeRevision } =
          await requireReadyFounderOperatorAuthorityInTransaction(tx, input.userId);
        await persistFounderOwnerPreviewDenialInTransaction(tx, {
          userId: input.userId,
          operatorId,
          applicationRevision: dependencies.applicationRevision,
          runtimeRevision,
          reason: "admission_evidence_incomplete",
          decidedAt: input.now,
        });
      });
    }
    throw error;
  } finally {
    if (ownsConnection) await connection.close();
  }
}

type Transaction = Parameters<Parameters<DatabaseConnection["db"]["transaction"]>[0]>[0];

async function requireReleaseDecision(
  tx: Transaction,
  userId: string,
  applicationRevision: string,
  runtimeRevision: string,
): Promise<void> {
  const [decision] = await tx
    .select({ id: founderReleaseDecisions.id })
    .from(founderReleaseDecisions)
    .where(
      and(
        eq(founderReleaseDecisions.userId, userId),
        eq(founderReleaseDecisions.stage, "owner_preview"),
        inArray(founderReleaseDecisions.outcome, ["enter", "resume"]),
        eq(founderReleaseDecisions.applicationRevision, applicationRevision),
        eq(founderReleaseDecisions.runtimeRevision, runtimeRevision),
      ),
    )
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (!decision) throw new Error("An exact-revision Release Decision is required.");
}

function lifecycleOutcome(
  input: LifecycleInput,
  providers: FounderLifecycleProviderBoundary,
  cleanup: FounderLifecycleCleanup,
): FounderLifecycleOutcome {
  return {
    action: input.action,
    status: "passed",
    observedAt: input.now.toISOString(),
    providerCalls: providers.calls(),
    cleanup,
  };
}

function emptyCleanup(now: Date): FounderLifecycleCleanup {
  return {
    resourcesBefore: 0,
    resourcesAfter: 0,
    verified: true,
    observedAt: now.toISOString(),
  };
}
