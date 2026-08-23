import { and, desc, eq, inArray } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderGeneralReleaseActivations,
  founderReleaseDecisions,
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
import { reconcileFounderCommerceEvent } from "./entitlement";
import { persistFounderExternalBetaQualificationsInTransaction } from "./external-beta-manifest";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS,
  FOUNDER_EXTERNAL_BETA_QUALIFICATION_SCHEMA,
  type FounderExternalBetaQualification,
} from "./external-beta-qualification";
import { executeFounderInfrastructureRetirement } from "./infrastructure-retirement";
import {
  FOUNDER_GENERAL_RELEASE_ACTIVATION_WINDOW_MS,
  type FounderGeneralReleaseActivationDto,
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

export type FounderProductContractLifecycleAction =
  | "release_stage_admission"
  | "initial_general_release_activation"
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
    calendarReading: true;
    gmailReading: true;
    gmailSending: true;
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
  externalBetaManifest?: {
    state: "ready";
    availableCapabilities: readonly string[];
    providerChoice: "Connect OpenAI, Anthropic, or both";
    capacityBoundary: "Uses only your connected provider accounts";
    safeWorkCheckpointsPreserved: true;
  };
  initialGeneralRelease?: {
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
        case "initial_general_release_activation":
          throw new Error("Initial General Release must use its public contract path.");
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
  const eligibility = await application(
    {
      action: "confirm_eligibility",
      serviceBusinessConfirmed: true,
      geographyCode: "PH",
    },
    input.now,
  );
  requireGeneralReleaseApplicationStatus(eligibility, 200, "Eligibility confirmation");
  const runnersAfterAbandonedSetup = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, input.userId));
  const prematureCreate = await application({ action: "create_operator" }, input.now);
  const runnersAfterPrematureCreate = await connection.db
    .select({ id: runners.id })
    .from(runners)
    .where(eq(runners.userId, input.userId));
  await confirmFounderCoreProcessingConsentForUser(input.userId, {
    createConnection: () => connection,
    now: () => input.now,
    applicationRevision: dependencies.applicationRevision,
    routingPolicy: getActiveFounderAiCompatibilityPolicy(true, true),
  });
  const createResponse = await application({ action: "create_operator" }, input.now);
  const created = requireGeneralReleaseApplicationStatus(
    createResponse,
    201,
    "Explicit Operator creation",
  );
  let prematureCheckoutBlocked = false;
  try {
    await connection.db.transaction((tx) =>
      requireFounderGeneralReleasePurchaseDecisionInTransaction(tx, input.userId, input.now),
    );
  } catch {
    prematureCheckoutBlocked = true;
  }
  const activationAt = new Date(input.now.valueOf() + 1);
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
      // The fixture runner predates this scenario. Only resources created by
      // abandoned General Release setup belong in the scenario leak ledger.
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
