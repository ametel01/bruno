import { and, desc, eq, inArray } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderCommerceEvents,
  founderCommerceLifecycleReceipts,
  founderGeneralReleaseActivations,
  founderInfrastructureRetirements,
  founderProductEntitlements,
  founderRecoveryArchiveDeletionReceipts,
  founderReleaseDecisions,
  operatorDeletionRequests,
  operators,
  runners,
} from "@/src/server/db/schema";
import { getActiveFounderAiCompatibilityPolicy } from "@/src/server/operators/founder-ai-routing";
import {
  confirmFounderCoreProcessingConsentForUser,
  openFounderCoreBriefForUser,
} from "@/src/server/operators/founder-core-operation";
import type { DigitalOceanOwnedSetProvider } from "@/src/server/runners/digitalocean-provider";
import { expireFounderRecoveryArchivesForUser } from "./archive-expiry";
import { founderProductContractDigest } from "./digest";
import {
  assertFounderSubscriptionLifecycleContract,
  reconcileFounderCommerceEvent,
} from "./entitlement";
import {
  admitFounderToExternalBeta,
  FOUNDER_EXTERNAL_BETA_ACCESS_MS,
  FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
  FOUNDER_EXTERNAL_BETA_INVITATION_MS,
  FOUNDER_EXTERNAL_BETA_RETIREMENT_MS,
  getFounderExternalBetaStatusForUser,
  issueFounderExternalBetaInvitation,
} from "./external-beta-admission";
import { persistFounderExternalBetaQualificationsInTransaction } from "./external-beta-manifest";
import {
  captureFounderExternalBetaMeasurement,
  decideFounderExternalBetaConsent,
  deleteFounderExternalBetaMeasurements,
  exportFounderExternalBetaPrivacyData,
  FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS,
  getFounderExternalBetaPrivacyStatusForUser,
  reconcileFounderExternalBetaRecordingRetention,
  registerFounderExternalBetaRecording,
} from "./external-beta-privacy";
import { assessFounderExternalBetaPromotionEvidenceForCohort } from "./external-beta-promotion";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS,
  FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA,
  type FounderExternalBetaQualification,
} from "./external-beta-qualification";
import { reconcileFounderExternalBetaRetirements } from "./external-beta-retirement";
import { executeFounderInfrastructureRetirement } from "./infrastructure-retirement";
import {
  FOUNDER_GENERAL_RELEASE_ACTIVATION_WINDOW_MS,
  type FounderGeneralReleaseActivationDto,
  FounderGeneralReleaseError,
  founderGeneralReleaseSetupAuthorizesInTransaction,
  getFounderGeneralReleaseActivationForUser,
  reconcileFounderGeneralReleaseDeadlineForUser,
  requireFounderGeneralReleasePurchaseDecisionInTransaction,
} from "./initial-general-release";
import {
  lockFounderProductContractLifecycleInTransaction,
  requireReadyFounderOperatorAuthorityInTransaction,
} from "./operator-authority";
import { persistQualifiedFounderOwnerPreviewAdmissionInTransaction } from "./owner-preview-admission";
import { persistFounderOwnerPreviewDenialInTransaction } from "./owner-preview-release-decision";
import { FOUNDER_PREVIEW_QUALIFICATION_MAX_AGE_MS } from "./preview-qualification";
import { createDurableRecoveryArchive } from "./recovery-archive";
import type { FounderRecoveryArchiveProvider } from "./recovery-archive-provider";
import { persistFounderOwnerPreviewHoldInTransaction } from "./release-stage-hold";
import {
  executeFounderReturningRestoration,
  type FounderReturningRestorationOutcome,
  type FounderReturningRestorationProvider,
} from "./returning-founder-restoration";

export type FounderProductContractLifecycleAction =
  | "release_stage_admission"
  | "initial_general_release_activation"
  | "external_beta_cohort_lifecycle"
  | "product_entitlement_lifecycle"
  | "subscription_lifecycle"
  | "recovery_archive_lifecycle"
  | "infrastructure_retirement"
  | "identity_recovery_lifecycle";

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

export type FounderLifecycleProviderBoundary = FounderRecoveryArchiveProvider &
  Partial<Omit<FounderReturningRestorationProvider, "calls">> & {
    authenticateIdentity(input: { userId: string }): Promise<{ subject: string }>;
    verifyCapabilityProviders(): Promise<{
      openAI: true;
      anthropic: true;
      calendarReading: true;
      gmailReading: true;
      gmailSending: true;
    }>;
    readSubscription(input: { subscriptionId: string }): Promise<{ status: FounderCommerceStatus }>;
    cancelSubscription?(input: { subscriptionId: string }): Promise<void>;
    createCustomerPortal(input: { subscriptionId: string; now: Date }): Promise<{
      url: string;
      expiresAt: Date;
      actions: {
        paymentMethods: true;
        billingHistory: true;
        cancellation: true;
        eligibleResumption: true;
        planSwitching: false;
        customerPause: false;
      };
    }>;
    deleteExternalBetaRecording(input: {
      artifactReferenceDigest: `sha256:${string}`;
    }): Promise<{ absent: true }>;
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
  externalBetaManifest?: {
    state: "ready";
    availableCapabilities: readonly string[];
    providerChoice: "Connect OpenAI, Anthropic, or both";
    capacityBoundary: "Uses only your connected provider accounts";
    safeWorkCheckpointsPreserved: true;
  };
  externalBetaCohort?: {
    invitationExpiresAt: string;
    accessExpiresAt: string;
    retirementDueAt: string;
    copiedAccountDenied: true;
    wrongWorkspaceDenied: true;
    payment: "Free, no card, no renewal, and no automatic paid conversion";
    exactCapabilities: readonly string[];
    promotionEligible: false;
    founderAcceptanceEligible: false;
    newCohortRequired: true;
    retirementCompleted: true;
  };
  initialGeneralRelease?: {
    missingDecisionAdmittedNobody: boolean;
    deniedDecisionAdmittedNobody: boolean;
    staleDecisionAdmittedNobody: boolean;
    unboundSetupDenied: boolean;
    holdBlockedAdmission: boolean;
    heldCapabilityPaused: boolean;
    unaffectedCapabilityAvailable: boolean;
    configurationRecoveryDidNotResume: boolean;
    explicitResumeRestoredCapability: boolean;
    resumeReconfirmationSurfaced: boolean;
    gmailPublicSetupSeamPassed: boolean;
    gmailHoldBlockedProviderEffects: boolean;
    gmailDisconnectPreservedDuringHold: boolean;
    gmailResumeRestoredPublicSetup: boolean;
    activationBoundToExactReleaseDecision: boolean;
    abandonedSetupCreatedNoDroplet: boolean;
    explicitCreateRequired: boolean;
    exactActivationWindow: boolean;
    prematureCheckoutBlocked: boolean;
    firstEvidenceBackedBriefActivated: boolean;
    acceptedPurchaseAvailable: boolean;
    declinedPurchaseRetirementDue: boolean;
    timedOutPurchaseRetirementDue: boolean;
    cleanupDelegatedToInfrastructureRetirement: boolean;
  };
  commerceLifecycle?: {
    portal: "signed_hosted";
    paymentRecoveryHours: 168;
    unpaidRetirementHours: 24;
    expiredRetirementHours: 1;
    refundRetirementHours: 24;
    reorderedActiveCanRestartTerminalClock: false;
  };
  returningFounderRestoration?: {
    success: FounderReturningRestorationOutcome;
    partialFailure: FounderReturningRestorationOutcome;
    lateEventAfterDeletion: FounderReturningRestorationOutcome;
    postExpiryRejoin: FounderReturningRestorationOutcome;
  };
  externalBetaPrivacy?: {
    allowlistedMeasurementAccepted: true;
    sensitiveContentRejected: true;
    participantIsolationEnforced: true;
    workspaceIsolationEnforced: true;
    separateRecordingConsent: true;
    recordingDeletionDueAt: string;
    recordingDeletionVerified: true;
    lateRecordingDeletionTerminal: true;
    separateFeedbackConsent: true;
    separateMarketingConsents: true;
    refusalPreservedAccess: true;
    exportAndDeletionVerified: true;
    evidenceClassification: "product_hardening";
    founderAcceptanceEligible: false;
  };
  identityRecovery?: {
    lostIdentityDenied: true;
    takeoverDenied: true;
    recoveredSameOwner: true;
    accountClosureCoordinated: true;
    commerceChangedByIdentityLoss: false;
    productEntitlementChangedByIdentityLoss: false;
    refundStartedByIdentityLoss: false;
    retirementStartedByIdentityLoss: false;
    archiveDeletionStartedByIdentityLoss: false;
    accountClosureStartedByIdentityLoss: false;
    receiptKinds: readonly [
      "identity_loss_recorded",
      "recovery_denied",
      "identity_rebound",
      "account_closure_requested",
    ];
  };
};

export type LifecycleInput = {
  action: FounderProductContractLifecycleAction;
  runId: string;
  userId: string;
  now: Date;
  commerceEvent?: FounderCommerceEvent;
  externalBetaContract?: {
    cohortOwnerUserId: string;
    participantUserId: string;
    invitedClerkSubject: string;
  };
  restorationContract?: {
    successUserId: string;
    successSourceEventId: string;
    partialFailureUserId: string;
    partialFailureSourceEventId: string;
    deletedArchiveUserId: string;
    deletedArchiveSourceEventId: string;
    expiredArchiveUserId: string;
    expiredArchiveSourceEventId: string;
  };
};

export type FounderLifecycleInput = LifecycleInput;

type LifecycleDependencies = {
  providers: FounderLifecycleProviderBoundary;
  commerceWebhookSecret: string;
  identityRecoverySigningSecret?: string;
  applicationRevision: string;
  providerRequestTimeoutMilliseconds?: number;
  createConnection?: () => DatabaseConnection;
  generalReleaseApplication?: (
    input:
      | {
          action: "confirm_eligibility";
          serviceBusinessConfirmed: true;
          geographyCode: "PH";
        }
      | { action: "create_operator" }
      | { action: "decline_offer" },
    now: Date,
  ) => Promise<{
    status: number;
    generalRelease?: FounderGeneralReleaseActivationDto;
    error?: { code?: string; message?: string };
  }>;
  generalReleaseGmailBoundary?: (
    phase: "approved" | "held" | "resumed",
    observedAt: Date,
  ) => Promise<{
    getAllowed: boolean;
    startAllowed: boolean;
    callbackAllowed: boolean;
    disconnectAllowed: boolean;
    providerEffectsStarted: number;
  }>;
  identityRecoveryPublicSeam?: (
    input: LifecycleInput,
    connection: DatabaseConnection,
  ) => Promise<FounderLifecycleOutcome>;
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
    if (input.action === "initial_general_release_activation") {
      return await executeInitialGeneralReleaseContractScenario(input, dependencies, connection);
    }
    if (input.action === "identity_recovery_lifecycle") {
      if (!dependencies.identityRecoveryPublicSeam) {
        throw new Error("Identity Recovery public seam is unavailable.");
      }
      return await dependencies.identityRecoveryPublicSeam(input, connection);
    }
    const lifecycleArchiveId =
      input.action === "release_stage_admission"
        ? await createDurableRecoveryArchive(
            { ...input, applicationRevision: dependencies.applicationRevision },
            dependencies.providers,
            connection,
            () => input.now,
          )
        : null;
    if (input.action === "external_beta_cohort_lifecycle") {
      if (!input.externalBetaContract) {
        throw new Error("External Beta contract fixture identity is required.");
      }
      return executeFounderExternalBetaContractLifecycle(
        input,
        input.externalBetaContract,
        dependencies,
      );
    }
    if (input.action === "recovery_archive_lifecycle") {
      return await executeFounderReturningRestorationContract(input, dependencies, connection);
    }
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
          if (
            !capabilities.openAI ||
            !capabilities.anthropic ||
            !capabilities.calendarReading ||
            !capabilities.gmailReading ||
            !capabilities.gmailSending
          ) {
            throw new Error("External Beta provider qualification was inconclusive.");
          }
          const externalBetaQualifications = contractExternalBetaQualifications({
            runId: input.runId,
            applicationRevision: dependencies.applicationRevision,
            runtimeRevision,
            observedAt: input.now,
          });
          await persistFounderExternalBetaQualificationsInTransaction(
            tx,
            externalBetaQualifications,
            input.now,
          );
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
        case "external_beta_cohort_lifecycle":
          throw new Error("External Beta must use its complete cohort lifecycle path.");
        case "initial_general_release_activation":
          throw new Error("Initial General Release must use its public contract path.");
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
        case "subscription_lifecycle": {
          await requireReleaseDecision(
            tx,
            input.userId,
            dependencies.applicationRevision,
            runtimeRevision,
          );
          const portal = await dependencies.providers.createCustomerPortal({
            subscriptionId: `${input.runId}:subscription`,
            now: input.now,
          });
          assertFounderCustomerPortalContract(portal, input.now);
          assertFounderSubscriptionLifecycleContract(input.now);
          break;
        }
        case "recovery_archive_lifecycle": {
          throw new Error("Returning Founder restoration must use its durable execution path.");
        }
        case "infrastructure_retirement":
          throw new Error("Infrastructure Retirement must use its durable execution path.");
        case "identity_recovery_lifecycle":
          throw new Error("Identity Recovery must use its complete recovery lifecycle path.");
      }

      return {
        action: input.action,
        status: "passed",
        observedAt: input.now.toISOString(),
        providerCalls: dependencies.providers.calls(),
        cleanup,
        ...(input.action === "release_stage_admission"
          ? {
              externalBetaManifest: {
                state: "ready" as const,
                availableCapabilities: FOUNDER_EXTERNAL_BETA_CAPABILITIES,
                providerChoice: "Connect OpenAI, Anthropic, or both" as const,
                capacityBoundary: "Uses only your connected provider accounts" as const,
                safeWorkCheckpointsPreserved: true as const,
              },
            }
          : {}),
        ...(input.action === "subscription_lifecycle"
          ? {
              commerceLifecycle: {
                portal: "signed_hosted" as const,
                paymentRecoveryHours: 168 as const,
                unpaidRetirementHours: 24 as const,
                expiredRetirementHours: 1 as const,
                refundRetirementHours: 24 as const,
                reorderedActiveCanRestartTerminalClock: false as const,
              },
            }
          : {}),
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

async function executeFounderReturningRestorationContract(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
  connection: DatabaseConnection,
): Promise<FounderLifecycleOutcome> {
  if (!input.restorationContract) {
    throw new Error("Returning Founder restoration contract identities are required.");
  }
  const execute = (userId: string, sourceEventId: string, now = input.now) =>
    executeFounderReturningRestoration(
      { userId, sourceEventId, now },
      {
        provider: requireReturningFounderProvider(dependencies.providers),
        createConnection: () => connection,
      },
    );
  for (const [branch, userId] of [
    ["success", input.restorationContract.successUserId],
    ["partial", input.restorationContract.partialFailureUserId],
    ["deleted", input.restorationContract.deletedArchiveUserId],
    ["expired", input.restorationContract.expiredArchiveUserId],
  ] as const) {
    await executeFounderInfrastructureRetirement(
      {
        action: "infrastructure_retirement",
        runId: `${input.runId}:restoration:${branch}`,
        userId,
        now: input.now,
      },
      {
        providers: dependencies.providers,
        applicationRevision: dependencies.applicationRevision,
      },
      connection,
    );
  }
  const success = await execute(
    input.restorationContract.successUserId,
    input.restorationContract.successSourceEventId,
  );
  const partialFailure = await execute(
    input.restorationContract.partialFailureUserId,
    input.restorationContract.partialFailureSourceEventId,
  );
  const afterRetention = new Date(input.now.valueOf() + 31 * 24 * 60 * 60 * 1_000);
  await expireFounderRecoveryArchivesForUser(
    input.restorationContract.deletedArchiveUserId,
    afterRetention,
    dependencies.providers,
    connection,
  );
  const lateEventAfterDeletion = await execute(
    input.restorationContract.deletedArchiveUserId,
    input.restorationContract.deletedArchiveSourceEventId,
    afterRetention,
  );
  const postExpiryRejoin = await execute(
    input.restorationContract.expiredArchiveUserId,
    input.restorationContract.expiredArchiveSourceEventId,
    afterRetention,
  );
  return {
    action: input.action,
    status: "passed",
    observedAt: input.now.toISOString(),
    providerCalls: dependencies.providers.calls(),
    cleanup: emptyCleanup(input.now),
    returningFounderRestoration: {
      success,
      partialFailure,
      lateEventAfterDeletion,
      postExpiryRejoin,
    },
  };
}

async function executeInitialGeneralReleaseContractScenario(
  input: LifecycleInput,
  dependencies: LifecycleDependencies,
  connection: DatabaseConnection,
): Promise<FounderLifecycleOutcome> {
  const identity = await dependencies.providers.authenticateIdentity({ userId: input.userId });
  if (!identity.subject) throw new Error("Clerk identity authentication was inconclusive.");
  const capabilities = await dependencies.providers.verifyCapabilityProviders();
  if (!capabilities.openAI || !capabilities.anthropic) {
    throw new Error("Independently released OpenAI and Anthropic are required.");
  }
  if (!capabilities.calendarReading || !capabilities.gmailReading) {
    throw new Error("Selected Current Company Connections are required.");
  }

  const availabilityEnvironment = {
    ...process.env,
    BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY: "open",
    BRUNO_INITIAL_GENERAL_RELEASE_GEOGRAPHIES: "PH",
    BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY_MESSAGE:
      "Public contract capacity is available in this geography.",
    BRUNO_INITIAL_GENERAL_RELEASE_PRICE_LABEL: "$30/month",
  };
  const runnersBefore = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, input.userId));
  const application = dependencies.generalReleaseApplication;
  if (!application) {
    throw new Error("The public General Release application boundary is unavailable.");
  }
  const gmailBoundary = dependencies.generalReleaseGmailBoundary;
  if (!gmailBoundary) {
    throw new Error("The public General Release Gmail boundary is unavailable.");
  }
  const [initialReleaseDecision] = await connection.db
    .select()
    .from(founderReleaseDecisions)
    .where(eq(founderReleaseDecisions.stage, "initial_general_release"))
    .orderBy(desc(founderReleaseDecisions.decidedAt))
    .limit(1);
  if (initialReleaseDecision?.outcome !== "enter") {
    throw new Error("The deterministic exact-candidate General Release Decision is unavailable.");
  }
  const confirmEligibility = (now: Date) =>
    application(
      {
        action: "confirm_eligibility",
        serviceBusinessConfirmed: true,
        geographyCode: "PH",
      },
      now,
    );
  const activationCount = async () =>
    (
      await connection.db
        .select({ id: founderGeneralReleaseActivations.id })
        .from(founderGeneralReleaseActivations)
        .where(eq(founderGeneralReleaseActivations.userId, input.userId))
    ).length;

  await connection.db
    .delete(founderReleaseDecisions)
    .where(eq(founderReleaseDecisions.id, initialReleaseDecision.id));
  const missingDecision = await confirmEligibility(input.now);
  const missingDecisionAdmittedNobody =
    missingDecision.status === 503 &&
    missingDecision.error?.code === "general_release_decision_required" &&
    (await activationCount()) === 0;
  await connection.db.insert(founderReleaseDecisions).values(initialReleaseDecision);

  await connection.db
    .update(founderReleaseDecisions)
    .set({ outcome: "deny" })
    .where(eq(founderReleaseDecisions.id, initialReleaseDecision.id));
  const deniedDecision = await confirmEligibility(input.now);
  const deniedDecisionAdmittedNobody =
    deniedDecision.status === 503 &&
    deniedDecision.error?.code === "general_release_decision_required" &&
    (await activationCount()) === 0;
  await connection.db
    .update(founderReleaseDecisions)
    .set({ outcome: "enter", authorityExpiresAt: input.now })
    .where(eq(founderReleaseDecisions.id, initialReleaseDecision.id));
  const staleDecision = await confirmEligibility(input.now);
  const staleDecisionAdmittedNobody =
    staleDecision.status === 503 &&
    staleDecision.error?.code === "general_release_decision_required" &&
    (await activationCount()) === 0;
  await connection.db
    .update(founderReleaseDecisions)
    .set({ authorityExpiresAt: initialReleaseDecision.authorityExpiresAt })
    .where(eq(founderReleaseDecisions.id, initialReleaseDecision.id));

  const eligibility = await application(
    {
      action: "confirm_eligibility",
      serviceBusinessConfirmed: true,
      geographyCode: "PH",
    },
    input.now,
  );
  requireGeneralReleaseApplicationStatus(eligibility, 200, "Eligibility confirmation");
  const [boundSetup] = await connection.db
    .select()
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, input.userId))
    .limit(1);
  if (!boundSetup?.releaseDecisionId) {
    throw new Error("The deterministic General Release setup was not bound.");
  }
  const approvedGmailBoundary = await gmailBoundary("approved", input.now);
  await connection.db
    .update(founderGeneralReleaseActivations)
    .set({ releaseDecisionId: null })
    .where(eq(founderGeneralReleaseActivations.id, boundSetup.id));
  const unboundCreate = await application({ action: "create_operator" }, input.now);
  const [stillUnbound] = await connection.db
    .select({ releaseDecisionId: founderGeneralReleaseActivations.releaseDecisionId })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.id, boundSetup.id));
  const unboundSetupDenied =
    unboundCreate.status === 409 &&
    unboundCreate.error?.code === "general_release_decision_required" &&
    stillUnbound?.releaseDecisionId === null;
  await connection.db
    .update(founderGeneralReleaseActivations)
    .set({ releaseDecisionId: boundSetup.releaseDecisionId })
    .where(eq(founderGeneralReleaseActivations.id, boundSetup.id));

  const holdAt =
    input.now <= initialReleaseDecision.decidedAt
      ? new Date(initialReleaseDecision.decidedAt.valueOf() + 1)
      : input.now;
  const holdDigest = founderProductContractDigest(
    JSON.stringify({
      kind: "initial_general_release_contract_hold",
      capability: "gmail_sending",
      observedAt: holdAt.toISOString(),
    }),
  );
  await connection.db.insert(founderReleaseDecisions).values({
    stage: "initial_general_release",
    outcome: "hold",
    applicationRevision: initialReleaseDecision.applicationRevision,
    runtimeRevision: initialReleaseDecision.runtimeRevision,
    capabilityManifest: initialReleaseDecision.capabilityManifest,
    affectedCapabilities: ["gmail_sending"],
    evidenceDigests: [holdDigest, ...initialReleaseDecision.evidenceDigests],
    authorityExpiresAt: initialReleaseDecision.authorityExpiresAt,
    decidedAt: holdAt,
  });
  const holdAdmission = await confirmEligibility(holdAt);
  const holdBlockedAdmission =
    holdAdmission.status === 503 && holdAdmission.error?.code === "general_release_hold";
  const [unaffectedCapabilityAvailable, heldCapabilityPaused, stillHeldAfterRecovery] =
    await connection.db.transaction(async (tx) => [
      await founderGeneralReleaseSetupAuthorizesInTransaction(
        tx,
        input.userId,
        holdAt,
        ["openai"],
        availabilityEnvironment,
      ),
      !(await founderGeneralReleaseSetupAuthorizesInTransaction(
        tx,
        input.userId,
        holdAt,
        ["gmail_sending"],
        availabilityEnvironment,
      )),
      !(await founderGeneralReleaseSetupAuthorizesInTransaction(
        tx,
        input.userId,
        holdAt,
        ["gmail_sending"],
        availabilityEnvironment,
      )),
    ]);
  const heldGmailBoundary = await gmailBoundary("held", holdAt);
  const resumeAt = new Date(holdAt.valueOf() + 1);
  const [resumeDecision] = await connection.db
    .insert(founderReleaseDecisions)
    .values({
      stage: "initial_general_release",
      outcome: "resume",
      applicationRevision: initialReleaseDecision.applicationRevision,
      runtimeRevision: initialReleaseDecision.runtimeRevision,
      capabilityManifest: initialReleaseDecision.capabilityManifest,
      evidenceDigests: Array.from(
        { length: 12 },
        (_, index) => `sha256:${(index + 32).toString(16).padStart(64, "0")}`,
      ),
      authorityExpiresAt: initialReleaseDecision.authorityExpiresAt,
      decidedAt: resumeAt,
    })
    .returning({ id: founderReleaseDecisions.id });
  if (!resumeDecision) throw new Error("The deterministic General Release Resume was not saved.");
  const explicitResumeRestoredCapability = await connection.db.transaction((tx) =>
    founderGeneralReleaseSetupAuthorizesInTransaction(
      tx,
      input.userId,
      resumeAt,
      ["gmail_sending"],
      availabilityEnvironment,
    ),
  );
  const resumeProjection = await getFounderGeneralReleaseActivationForUser(input.userId, {
    createConnection: () => connection,
    env: availabilityEnvironment,
    now: () => resumeAt,
  });
  requireGeneralReleaseApplicationStatus(
    await confirmEligibility(resumeAt),
    200,
    "Explicit General Release Resume",
  );
  const resumedGmailBoundary = await gmailBoundary("resumed", resumeAt);
  const runnersAfterAbandonedSetup = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, input.userId));
  const prematureCreate = await application({ action: "create_operator" }, resumeAt);
  const runnersAfterPrematureCreate = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, input.userId));
  await confirmFounderCoreProcessingConsentForUser(input.userId, {
    createConnection: () => connection,
    now: () => resumeAt,
    applicationRevision: dependencies.applicationRevision,
    routingPolicy: getActiveFounderAiCompatibilityPolicy(true, true),
  });
  const createResponse = await application({ action: "create_operator" }, resumeAt);
  const created = requireGeneralReleaseApplicationStatus(
    createResponse,
    201,
    "Explicit Operator creation",
  );
  let prematureCheckoutBlocked = false;
  try {
    await connection.db.transaction((tx) =>
      requireFounderGeneralReleasePurchaseDecisionInTransaction(tx, input.userId, resumeAt),
    );
  } catch (error) {
    if (
      !(error instanceof FounderGeneralReleaseError) ||
      error.code !== "purchase_decision_unavailable"
    ) {
      throw error;
    }
    prematureCheckoutBlocked = true;
  }
  const activationAt = new Date(resumeAt.valueOf() + 1);
  await openFounderCoreBriefForUser(input.userId, {
    createConnection: () => connection,
    now: () => activationAt,
    applicationRevision: dependencies.applicationRevision,
    routingPolicy: getActiveFounderAiCompatibilityPolicy(true, true),
  });
  await connection.db.transaction((tx) =>
    requireFounderGeneralReleasePurchaseDecisionInTransaction(tx, input.userId, activationAt),
  );
  const activated = await getFounderGeneralReleaseActivationForUser(input.userId, {
    createConnection: () => connection,
    env: availabilityEnvironment,
    now: () => activationAt,
  });
  const persistedActivated = (
    await connection.db
      .select()
      .from(founderGeneralReleaseActivations)
      .where(eq(founderGeneralReleaseActivations.userId, input.userId))
      .limit(1)
  )[0];
  if (!persistedActivated?.entitlementDueAt) {
    throw new Error("The deterministic General Release activation was not persisted.");
  }
  const [boundReleaseDecision] = persistedActivated.releaseDecisionId
    ? await connection.db
        .select()
        .from(founderReleaseDecisions)
        .where(eq(founderReleaseDecisions.id, persistedActivated.releaseDecisionId))
        .limit(1)
    : [];

  const declineAt = new Date(activationAt.valueOf() + 1);
  const declineResponse = await application({ action: "decline_offer" }, declineAt);
  const declined = requireGeneralReleaseApplicationStatus(
    declineResponse,
    200,
    "Published offer decline",
  );
  await restoreContractActivation(connection, persistedActivated, declineAt);

  await reconcileFounderGeneralReleaseDeadlineForUser(
    input.userId,
    persistedActivated.entitlementDueAt,
    { createConnection: () => connection },
  );
  const timedOut = await getFounderGeneralReleaseActivationForUser(input.userId, {
    createConnection: () => connection,
    env: availabilityEnvironment,
    now: () => persistedActivated.entitlementDueAt as Date,
  });
  await restoreContractActivation(connection, persistedActivated, activationAt);

  const providerCreatedAt = created.activation.dropletCreatedAt
    ? new Date(created.activation.dropletCreatedAt)
    : null;
  const activationDueAt = created.activation.dueAt ? new Date(created.activation.dueAt) : null;
  const proof = {
    missingDecisionAdmittedNobody,
    deniedDecisionAdmittedNobody,
    staleDecisionAdmittedNobody,
    unboundSetupDenied,
    holdBlockedAdmission,
    heldCapabilityPaused,
    unaffectedCapabilityAvailable,
    configurationRecoveryDidNotResume: stillHeldAfterRecovery,
    explicitResumeRestoredCapability,
    resumeReconfirmationSurfaced:
      resumeProjection.setup.requiresReleaseReconfirmation && !resumeProjection.setup.canCreate,
    gmailPublicSetupSeamPassed:
      approvedGmailBoundary.getAllowed &&
      approvedGmailBoundary.startAllowed &&
      approvedGmailBoundary.callbackAllowed &&
      approvedGmailBoundary.disconnectAllowed &&
      approvedGmailBoundary.providerEffectsStarted === 2,
    gmailHoldBlockedProviderEffects:
      !heldGmailBoundary.getAllowed &&
      !heldGmailBoundary.startAllowed &&
      !heldGmailBoundary.callbackAllowed &&
      heldGmailBoundary.providerEffectsStarted === 0,
    gmailDisconnectPreservedDuringHold: heldGmailBoundary.disconnectAllowed,
    gmailResumeRestoredPublicSetup:
      resumedGmailBoundary.getAllowed &&
      resumedGmailBoundary.startAllowed &&
      resumedGmailBoundary.callbackAllowed &&
      resumedGmailBoundary.disconnectAllowed &&
      resumedGmailBoundary.providerEffectsStarted === 2,
    activationBoundToExactReleaseDecision:
      persistedActivated.releaseDecisionId === resumeDecision.id &&
      boundReleaseDecision?.id === resumeDecision.id &&
      boundReleaseDecision?.stage === "initial_general_release" &&
      ["enter", "resume"].includes(boundReleaseDecision.outcome) &&
      boundReleaseDecision.applicationRevision === dependencies.applicationRevision &&
      boundReleaseDecision.runtimeRevision === process.env.BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION,
    abandonedSetupCreatedNoDroplet: runnersAfterAbandonedSetup.length === runnersBefore.length,
    explicitCreateRequired:
      prematureCreate.status === 409 &&
      runnersAfterPrematureCreate.length === runnersBefore.length &&
      created.setup.explicitCreateConfirmed,
    exactActivationWindow:
      providerCreatedAt !== null &&
      activationDueAt?.valueOf() ===
        providerCreatedAt.valueOf() + FOUNDER_GENERAL_RELEASE_ACTIVATION_WINDOW_MS,
    prematureCheckoutBlocked,
    firstEvidenceBackedBriefActivated:
      activated.state === "activated" &&
      activated.activation.activatedAt === activationAt.toISOString(),
    acceptedPurchaseAvailable: activated.offer.available,
    declinedPurchaseRetirementDue: declined.state === "retirement_due",
    timedOutPurchaseRetirementDue: timedOut.state === "retirement_due",
    cleanupDelegatedToInfrastructureRetirement: true,
  };
  if (Object.values(proof).some((value) => value !== true)) {
    throw new Error("The Initial General Release contract proof was incomplete.");
  }
  return {
    action: input.action,
    status: "passed",
    observedAt: input.now.toISOString(),
    providerCalls: dependencies.providers.calls(),
    cleanup: {
      resourcesBefore: 0,
      resourcesAfter: Math.max(0, runnersAfterAbandonedSetup.length - runnersBefore.length),
      verified: true,
      observedAt: activationAt.toISOString(),
    },
    initialGeneralRelease: proof,
  };
}

function requireGeneralReleaseApplicationStatus(
  response: {
    status: number;
    generalRelease?: FounderGeneralReleaseActivationDto;
    error?: { code?: string; message?: string };
  },
  expectedStatus: number,
  operation: string,
): FounderGeneralReleaseActivationDto {
  if (response.status !== expectedStatus || !response.generalRelease) {
    const detail = response.error?.message ?? response.error?.code ?? `HTTP ${response.status}`;
    throw new Error(`${operation} failed through the public General Release route: ${detail}`);
  }
  return response.generalRelease;
}

async function restoreContractActivation(
  connection: DatabaseConnection,
  activation: typeof founderGeneralReleaseActivations.$inferSelect,
  updatedAt: Date,
): Promise<void> {
  await connection.db
    .update(founderGeneralReleaseActivations)
    .set({
      status: "activated",
      retirementDueAt: null,
      workStoppedAt: activation.workStoppedAt,
      updatedAt,
    })
    .where(eq(founderGeneralReleaseActivations.id, activation.id));
}

function requireReturningFounderProvider(
  provider: FounderLifecycleProviderBoundary,
): FounderReturningRestorationProvider {
  if (
    !provider.verifyRecoveryArchive ||
    !provider.provisionNewInfrastructure ||
    !provider.observeNewInfrastructure ||
    !provider.reauthorizeAiProviders ||
    !provider.reauthorizeCompanyProviders ||
    !provider.retireRestorationInfrastructure ||
    !provider.refundRestorationPayment
  ) {
    throw new Error("Returning Founder restoration provider boundary is unavailable.");
  }
  return provider as FounderReturningRestorationProvider;
}

export async function readFounderIdentitySeparationSnapshot(
  connection: DatabaseConnection,
  userId: string,
): Promise<{
  commerceEvents: number;
  refundReceipts: number;
  entitlement: unknown;
  retirements: number;
  archiveDeletions: number;
  accountClosureRequests: number;
  deletionRequests: number;
}> {
  const [
    commerceEvents,
    refundReceipts,
    entitlements,
    retirements,
    archiveDeletions,
    deletionRequests,
    accountClosures,
  ] = await Promise.all([
    connection.db
      .select({ id: founderCommerceEvents.id })
      .from(founderCommerceEvents)
      .where(eq(founderCommerceEvents.userId, userId)),
    connection.db
      .select({ id: founderCommerceLifecycleReceipts.id })
      .from(founderCommerceLifecycleReceipts)
      .where(
        and(
          eq(founderCommerceLifecycleReceipts.userId, userId),
          eq(founderCommerceLifecycleReceipts.kind, "refund"),
        ),
      ),
    connection.db
      .select({
        id: founderProductEntitlements.id,
        status: founderProductEntitlements.status,
        providerSubscriptionId: founderProductEntitlements.providerSubscriptionId,
        retirementDueAt: founderProductEntitlements.retirementDueAt,
        updatedAt: founderProductEntitlements.updatedAt,
      })
      .from(founderProductEntitlements)
      .where(eq(founderProductEntitlements.userId, userId)),
    connection.db
      .select({ id: founderInfrastructureRetirements.id })
      .from(founderInfrastructureRetirements)
      .where(eq(founderInfrastructureRetirements.userId, userId)),
    connection.db
      .select({ id: founderRecoveryArchiveDeletionReceipts.id })
      .from(founderRecoveryArchiveDeletionReceipts)
      .where(eq(founderRecoveryArchiveDeletionReceipts.userId, userId)),
    connection.db
      .select({ id: operatorDeletionRequests.id })
      .from(operatorDeletionRequests)
      .innerJoin(operators, eq(operators.id, operatorDeletionRequests.operatorId))
      .where(eq(operators.userId, userId)),
    connection.db
      .select({ id: operatorDeletionRequests.id })
      .from(operatorDeletionRequests)
      .innerJoin(operators, eq(operators.id, operatorDeletionRequests.operatorId))
      .where(
        and(eq(operators.userId, userId), eq(operatorDeletionRequests.kind, "account_closure")),
      ),
  ]);
  return {
    commerceEvents: commerceEvents.length,
    refundReceipts: refundReceipts.length,
    entitlement: entitlements,
    retirements: retirements.length,
    archiveDeletions: archiveDeletions.length,
    accountClosureRequests: accountClosures.length,
    deletionRequests: deletionRequests.length,
  };
}

async function executeFounderExternalBetaContractLifecycle(
  input: LifecycleInput,
  contract: NonNullable<LifecycleInput["externalBetaContract"]>,
  dependencies: LifecycleDependencies,
): Promise<FounderLifecycleOutcome> {
  const cohort = `external-beta-contract:${input.runId}`;
  const workspaceReference = `workspace:${input.runId}`;
  const invitationToken = "B".repeat(43);
  const environment = {
    BRUNO_AUTH_MODE: "clerk",
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_founder_contract_external_beta",
    CLERK_SECRET_KEY: "sk_test_founder_contract_external_beta",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    VERCEL_GIT_COMMIT_SHA: dependencies.applicationRevision,
  };
  const invitation = await issueFounderExternalBetaInvitation(
    {
      cohortOwnerUserId: contract.cohortOwnerUserId,
      invitedClerkSubject: contract.invitedClerkSubject,
      namedFounder: "Founder Product Contract participant",
      workspaceReference,
      independenceEvidenceDigest: founderProductContractDigest(
        `external-beta-independent:${input.runId}`,
      ),
    },
    {
      applicationRevision: dependencies.applicationRevision,
      env: environment,
      now: () => input.now,
      createInvitationToken: () => invitationToken,
    },
  );
  if (
    invitation.expiresAt !==
    new Date(input.now.valueOf() + FOUNDER_EXTERNAL_BETA_INVITATION_MS).toISOString()
  ) {
    throw new Error("External Beta invitation did not retain the exact seven-day boundary.");
  }

  const compact = {
    version: FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
    instabilityAccepted: true,
    capabilityBoundaryAccepted: true,
    reactiveSupportAccepted: true,
    companyDataHandlingAccepted: true,
    feedbackBoundaryAccepted: true,
    withdrawalExportDeletionAccepted: true,
    freeNonconvertingBoundaryAccepted: true,
  } as const;
  let copiedAccountDenied = false;
  try {
    await admitFounderToExternalBeta(
      input.userId,
      { invitationToken, workspaceReference, compact },
      {
        applicationRevision: dependencies.applicationRevision,
        createProvider: () => dependencies.providers,
        env: environment,
        now: () => input.now,
      },
    );
  } catch {
    copiedAccountDenied = true;
  }
  let wrongWorkspaceDenied = false;
  try {
    await admitFounderToExternalBeta(
      contract.participantUserId,
      { invitationToken, workspaceReference: `${workspaceReference}:copied`, compact },
      {
        applicationRevision: dependencies.applicationRevision,
        createProvider: () => dependencies.providers,
        env: environment,
        now: () => input.now,
      },
    );
  } catch {
    wrongWorkspaceDenied = true;
  }
  if (!copiedAccountDenied || !wrongWorkspaceDenied) {
    throw new Error("External Beta invitation isolation was not enforced.");
  }

  const admitted = await admitFounderToExternalBeta(
    contract.participantUserId,
    { invitationToken, workspaceReference, compact },
    {
      applicationRevision: dependencies.applicationRevision,
      createProvider: () => dependencies.providers,
      env: environment,
      now: () => input.now,
    },
  );
  const accessExpiresAt = new Date(input.now.valueOf() + FOUNDER_EXTERNAL_BETA_ACCESS_MS);
  const retirementDueAt = new Date(accessExpiresAt.valueOf() + FOUNDER_EXTERNAL_BETA_RETIREMENT_MS);
  if (
    admitted.accessExpiresAt !== accessExpiresAt.toISOString() ||
    admitted.retirementDueAt !== retirementDueAt.toISOString()
  ) {
    throw new Error("External Beta admission did not retain its exact nonextendable boundaries.");
  }
  const active = await getFounderExternalBetaStatusForUser(contract.participantUserId, input.now, {
    applicationRevision: dependencies.applicationRevision,
  });
  if (
    active.state !== "active" ||
    active.payment !== "Free, no card, no renewal, and no automatic paid conversion" ||
    active.availableCapabilities.length !== FOUNDER_EXTERNAL_BETA_CAPABILITIES.length ||
    !active.withdrawalAvailable ||
    !active.exportAvailable ||
    !active.deletionAvailable
  ) {
    throw new Error("External Beta visible Compact boundaries were incomplete.");
  }

  const privacy = await exerciseExternalBetaPrivacyContract({
    participantUserId: contract.participantUserId,
    otherUserId: input.userId,
    workspaceDigest: founderProductContractDigest(`external-beta-workspace:${workspaceReference}`),
    now: input.now,
    providers: dependencies.providers,
  });
  const afterRefusal = await getFounderExternalBetaStatusForUser(
    contract.participantUserId,
    input.now,
    { applicationRevision: dependencies.applicationRevision },
  );
  if (afterRefusal.state !== "active" || !afterRefusal.withdrawalAvailable) {
    throw new Error("External Beta privacy refusal changed product access.");
  }

  const retirement = await reconcileFounderExternalBetaRetirements({
    applicationRevision: dependencies.applicationRevision,
    now: accessExpiresAt,
    providers: dependencies.providers,
  });
  if (retirement.expired !== 1 || retirement.retired !== 1 || retirement.failed !== 0) {
    throw new Error("External Beta exact-expiry Infrastructure Retirement was not verified.");
  }
  const expired = await getFounderExternalBetaStatusForUser(
    contract.participantUserId,
    accessExpiresAt,
    {
      applicationRevision: dependencies.applicationRevision,
    },
  );
  if (
    expired.state !== "expired" ||
    expired.workStoppedAt !== accessExpiresAt.toISOString() ||
    expired.remainingSeconds !== 0 ||
    expired.withdrawalAvailable
  ) {
    throw new Error("External Beta did not stop work at the exact access boundary.");
  }
  const promotion = await assessFounderExternalBetaPromotionEvidenceForCohort({
    value: null,
    cohort,
    applicationRevision: dependencies.applicationRevision,
    observedAt: accessExpiresAt,
  });
  if (
    promotion.promotionEligible ||
    promotion.founderAcceptanceEligible ||
    !promotion.newCohortRequired ||
    promotion.classification !== "product_hardening"
  ) {
    throw new Error("External Beta denied promotion did not require a new invited cohort.");
  }

  return {
    action: input.action,
    status: "passed",
    observedAt: input.now.toISOString(),
    providerCalls: dependencies.providers.calls(),
    cleanup: {
      resourcesBefore: 1,
      resourcesAfter: 0,
      verified: true,
      observedAt: input.now.toISOString(),
    },
    externalBetaCohort: {
      invitationExpiresAt: invitation.expiresAt,
      accessExpiresAt: admitted.accessExpiresAt,
      retirementDueAt: admitted.retirementDueAt,
      copiedAccountDenied: true,
      wrongWorkspaceDenied: true,
      payment: active.payment,
      exactCapabilities: active.availableCapabilities,
      promotionEligible: false,
      founderAcceptanceEligible: false,
      newCohortRequired: true,
      retirementCompleted: true,
    },
    externalBetaPrivacy: privacy,
  };
}

async function exerciseExternalBetaPrivacyContract(input: {
  participantUserId: string;
  otherUserId: string;
  workspaceDigest: `sha256:${string}`;
  now: Date;
  providers: FounderLifecycleProviderBoundary;
}): Promise<NonNullable<FounderLifecycleOutcome["externalBetaPrivacy"]>> {
  const initial = await getFounderExternalBetaPrivacyStatusForUser(input.participantUserId);
  if (
    initial.state !== "available" ||
    Object.values(initial.consent).some((state) => state !== "not_granted") ||
    initial.collection.autocapture ||
    initial.collection.sessionReplay ||
    initial.collection.personProfiles
  ) {
    throw new Error("External Beta privacy did not start private by default.");
  }
  let measurementWithoutConsentRejected = false;
  try {
    await captureFounderExternalBetaMeasurement(
      input.participantUserId,
      { event: "activation_completed" },
      input.now,
    );
  } catch {
    measurementWithoutConsentRejected = true;
  }
  if (!measurementWithoutConsentRejected) {
    throw new Error("External Beta measurement did not require explicit consent.");
  }
  await decideFounderExternalBetaConsent(input.participantUserId, {
    purpose: "measurement",
    decision: "grant",
    decidedAt: input.now,
    expectedWorkspaceDigest: input.workspaceDigest,
  });
  await captureFounderExternalBetaMeasurement(
    input.participantUserId,
    { event: "activation_completed" },
    input.now,
    { expectedWorkspaceDigest: input.workspaceDigest },
  );

  let sensitiveContentRejected = false;
  try {
    await captureFounderExternalBetaMeasurement(
      input.participantUserId,
      { event: "activation_completed", messageBody: "private company content" },
      input.now,
    );
  } catch {
    sensitiveContentRejected = true;
  }
  let participantIsolationEnforced = false;
  try {
    await captureFounderExternalBetaMeasurement(
      input.otherUserId,
      { event: "activation_completed" },
      input.now,
    );
  } catch {
    participantIsolationEnforced = true;
  }
  let workspaceIsolationEnforced = false;
  try {
    await captureFounderExternalBetaMeasurement(
      input.participantUserId,
      { event: "activation_completed" },
      input.now,
      { expectedWorkspaceDigest: founderProductContractDigest("wrong-workspace") },
    );
  } catch {
    workspaceIsolationEnforced = true;
  }
  if (!sensitiveContentRejected || !participantIsolationEnforced || !workspaceIsolationEnforced) {
    throw new Error("External Beta privacy isolation or sensitive-content rejection failed.");
  }

  await decideFounderExternalBetaConsent(input.participantUserId, {
    purpose: "recording",
    decision: "refuse",
    decidedAt: input.now,
  });
  const artifactReferenceDigest = founderProductContractDigest(
    `external-beta-recording:${input.participantUserId}`,
  );
  let recordingWithoutConsentRejected = false;
  try {
    await registerFounderExternalBetaRecording(input.participantUserId, {
      artifactReferenceDigest,
      recordedAt: input.now,
    });
  } catch {
    recordingWithoutConsentRejected = true;
  }
  if (!recordingWithoutConsentRejected) {
    throw new Error("External Beta recording did not require separate consent.");
  }
  await decideFounderExternalBetaConsent(input.participantUserId, {
    purpose: "recording",
    decision: "grant",
    decidedAt: new Date(input.now.valueOf() + 1),
  });
  const recording = await registerFounderExternalBetaRecording(input.participantUserId, {
    artifactReferenceDigest,
    recordedAt: new Date(input.now.valueOf() + 1),
  });
  const lateArtifactReferenceDigest = founderProductContractDigest(
    `external-beta-recording-late:${input.participantUserId}`,
  );
  const lateRecording = await registerFounderExternalBetaRecording(input.participantUserId, {
    artifactReferenceDigest: lateArtifactReferenceDigest,
    recordedAt: new Date(input.now.valueOf() + 120_000),
  });
  await decideFounderExternalBetaConsent(input.participantUserId, {
    purpose: "feedback",
    decision: "refuse",
    decidedAt: new Date(input.now.valueOf() + 2),
  });
  const marketingPurposes = [
    "testimonial",
    "identity",
    "name",
    "logo",
    "quotation",
    "case_study",
  ] as const;
  for (const purpose of marketingPurposes) {
    await decideFounderExternalBetaConsent(input.participantUserId, {
      purpose,
      decision: "refuse",
      decidedAt: new Date(input.now.valueOf() + 2),
    });
  }
  const current = await getFounderExternalBetaPrivacyStatusForUser(input.participantUserId);
  if (
    current.state !== "available" ||
    current.consent.feedback !== "refused" ||
    marketingPurposes.some((purpose) => current.consent[purpose] !== "refused")
  ) {
    throw new Error("External Beta marketing consent was not separate and specific.");
  }

  const exported = await exportFounderExternalBetaPrivacyData(input.participantUserId);
  if (
    exported.evidenceClassification !== "product_hardening" ||
    exported.measurements.length !== 1 ||
    JSON.stringify(exported).includes("private company content")
  ) {
    throw new Error("External Beta privacy export crossed its evidence boundary.");
  }
  const deletedMeasurements = await deleteFounderExternalBetaMeasurements(input.participantUserId);
  if (deletedMeasurements.deleted !== 1) {
    throw new Error("External Beta measurement deletion was not verified.");
  }
  const afterDeletion = await exportFounderExternalBetaPrivacyData(input.participantUserId);
  if (afterDeletion.measurements.length !== 0) {
    throw new Error("External Beta measurement deletion remained visible in export.");
  }

  const deletionAt = new Date(
    input.now.valueOf() + 1 + FOUNDER_EXTERNAL_BETA_RECORDING_RETENTION_MS,
  );
  const recordingDeletion = await reconcileFounderExternalBetaRecordingRetention(deletionAt, {
    deleteAndVerifyAbsent: (deletion) => input.providers.deleteExternalBetaRecording(deletion),
  });
  if (
    recordingDeletion.deleted !== 1 ||
    recordingDeletion.late !== 0 ||
    recordingDeletion.failed !== 0
  ) {
    throw new Error("External Beta recording deletion was not verified within 30 days.");
  }
  const lateDeletionAt = new Date(new Date(lateRecording.deletionDueAt).valueOf() + 1);
  const lateRecordingDeletion = await reconcileFounderExternalBetaRecordingRetention(
    lateDeletionAt,
    {
      deleteAndVerifyAbsent: (deletion) => input.providers.deleteExternalBetaRecording(deletion),
    },
  );
  const afterRecordingDeletion = await exportFounderExternalBetaPrivacyData(
    input.participantUserId,
  );
  const persistedLateRecording = afterRecordingDeletion.recordings.find(
    (candidate) => candidate.status === "deleted_late",
  );
  if (
    lateRecordingDeletion.deleted !== 1 ||
    lateRecordingDeletion.late !== 1 ||
    lateRecordingDeletion.failed !== 0 ||
    !persistedLateRecording ||
    !persistedLateRecording.providerDeletionVerified ||
    !persistedLateRecording.deletionReceiptDigest ||
    !persistedLateRecording.deletedAt ||
    new Date(persistedLateRecording.deletedAt) <= new Date(persistedLateRecording.deletionDueAt)
  ) {
    throw new Error(
      "External Beta late recording deletion did not persist a terminal breach receipt.",
    );
  }

  return {
    allowlistedMeasurementAccepted: true,
    sensitiveContentRejected: true,
    participantIsolationEnforced: true,
    workspaceIsolationEnforced: true,
    separateRecordingConsent: true,
    recordingDeletionDueAt: recording.deletionDueAt,
    recordingDeletionVerified: true,
    lateRecordingDeletionTerminal: true,
    separateFeedbackConsent: true,
    separateMarketingConsents: true,
    refusalPreservedAccess: true,
    exportAndDeletionVerified: true,
    evidenceClassification: "product_hardening",
    founderAcceptanceEligible: false,
  };
}

function assertFounderCustomerPortalContract(
  portal: Awaited<ReturnType<FounderLifecycleProviderBoundary["createCustomerPortal"]>>,
  now: Date,
): void {
  const url = new URL(portal.url);
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/billing" ||
    !url.searchParams.get("user") ||
    !url.searchParams.get("expires") ||
    !/^[a-f0-9]{64}$/.test(url.searchParams.get("signature") ?? "") ||
    portal.expiresAt <= now ||
    portal.expiresAt.valueOf() - now.valueOf() > 25 * 60 * 60 * 1_000 ||
    portal.actions.paymentMethods !== true ||
    portal.actions.billingHistory !== true ||
    portal.actions.cancellation !== true ||
    portal.actions.eligibleResumption !== true ||
    portal.actions.planSwitching !== false ||
    portal.actions.customerPause !== false
  ) {
    throw new Error("The signed hosted Customer Portal contract is incomplete.");
  }
}

function contractExternalBetaQualifications(input: {
  runId: string;
  applicationRevision: string;
  runtimeRevision: string;
  observedAt: Date;
}): readonly FounderExternalBetaQualification[] {
  return FOUNDER_EXTERNAL_BETA_CAPABILITIES.map((capability) => ({
    schemaVersion: FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA,
    outcome: "passed",
    stage: "external_beta",
    cohort: `external-beta-contract:${input.runId}`,
    capability,
    applicationRevision: input.applicationRevision,
    runtimeRevision: input.runtimeRevision,
    evidenceDigest: founderProductContractDigest(
      JSON.stringify({ kind: "external_beta_qualification", capability, runId: input.runId }),
    ),
    observedAt: input.observedAt.toISOString(),
    expiresAt: new Date(
      input.observedAt.valueOf() + FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS,
    ).toISOString(),
  }));
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
