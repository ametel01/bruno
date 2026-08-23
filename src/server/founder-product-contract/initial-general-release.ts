import "server-only";

import { and, desc, eq, isNull, lte, notExists } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  founderGeneralReleaseActivations,
  founderProductEntitlements,
  operatorAiConnections,
  operatorCalendarConnections,
  operatorLimitedOperations,
  operatorMailConnections,
  operatorMorningBriefItems,
  operatorMorningBriefs,
  operatorProcessingConsents,
  operators,
} from "@/src/server/db/schema";
import { isFounderAnthropicReleased } from "@/src/server/operators/founder-anthropic-release";
import { isFounderOpenAiReleased } from "@/src/server/operators/founder-openai-release";
import {
  type CreateRunnerProvisioningResult,
  createDigitalOceanRunnerForUser,
  type RunnerProvisioningDto,
} from "@/src/server/runners/runner-provisioning";
import { founderProductContractDigest } from "./digest";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
  requireActiveFounderOperatorAuthorityInTransaction,
} from "./operator-authority";

export const FOUNDER_GENERAL_RELEASE_ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const FOUNDER_GENERAL_RELEASE_PURCHASE_WINDOW_MS = 24 * 60 * 60 * 1_000;
export const FOUNDER_GENERAL_RELEASE_ACTIVATION_RETIREMENT_WINDOW_MS = 60 * 60 * 1_000;
export const FOUNDER_GENERAL_RELEASE_WORK_PAUSE_REASON =
  "Product Entitlement does not authorize new work.";

const DEFAULT_RUNNER_NAME = "Bruno.Ai Operator";

type FounderGeneralReleaseAvailability = {
  admissionState: "eligible" | "waitlisted" | "unavailable";
  reason: string;
  geographyCode: string;
  priceLabel: string | null;
};

export type FounderGeneralReleaseActivationDto = {
  state:
    | "setup"
    | "waitlisted"
    | "provisioning"
    | "activation_pending"
    | "activated"
    | "entitled"
    | "retirement_due"
    | "retired";
  admission: {
    publicSelfServe: true;
    personalSelection: false;
    geographyCode: string | null;
    capacity: "available" | "waitlist" | "unavailable";
    reason: string;
  };
  setup: {
    authenticated: true;
    serviceBusinessConfirmed: boolean;
    readyAiConnection: boolean;
    selectedCompanyConnections: boolean;
    processingConsent: boolean;
    explicitCreateConfirmed: boolean;
    canCreate: boolean;
  };
  activation: {
    dropletCreatedAt: string | null;
    dueAt: string | null;
    activatedAt: string | null;
  };
  offer: {
    available: boolean;
    priceLabel: string | null;
    brunoPriceSeparateFromAiProviderCosts: true;
    aiProviderCosts: "Paid separately to OpenAI or Anthropic";
    freeTier: false;
    betaConversion: false;
    decisionDueAt: string | null;
  };
  retirement: {
    dueAt: string | null;
    workStoppedAt: string | null;
  };
};

export class FounderGeneralReleaseError extends Error {
  readonly status: 400 | 409 | 503;
  readonly code: string;

  constructor(code: string, message: string, status: 400 | 409 | 503 = 409) {
    super(message);
    this.name = "FounderGeneralReleaseError";
    this.code = code;
    this.status = status;
  }
}

type Dependencies = {
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  provisionRunner?: (
    userId: string,
    payload: { provider: "digitalocean"; name: string },
  ) => Promise<CreateRunnerProvisioningResult>;
};

export async function getFounderGeneralReleaseActivationForUser(
  userId: string,
  dependencies: Dependencies = {},
): Promise<FounderGeneralReleaseActivationDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();
  try {
    await reconcileFounderGeneralReleaseDeadlineForUser(userId, now, {
      createConnection: () => connection,
    });
    const availability = readFounderGeneralReleaseAvailability(
      dependencies.env ?? process.env,
      null,
    );
    return await connection.db.transaction((tx) => projectGeneralRelease(tx, userId, availability));
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function hasFounderGeneralReleaseSetupAccessForUser(
  userId: string,
  dependencies: Pick<Dependencies, "createConnection" | "now"> = {},
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await reconcileFounderGeneralReleaseDeadlineForUser(
      userId,
      dependencies.now?.() ?? new Date(),
      {
        createConnection: () => connection,
      },
    );
    const [activation] = await connection.db
      .select({
        status: founderGeneralReleaseActivations.status,
        admissionState: founderGeneralReleaseActivations.admissionState,
      })
      .from(founderGeneralReleaseActivations)
      .where(eq(founderGeneralReleaseActivations.userId, userId))
      .limit(1);
    if (!activation || activation.admissionState === "unavailable") return false;
    if (["setup", "waitlisted", "provisioning", "activation_pending"].includes(activation.status)) {
      return true;
    }
    if (activation.status !== "activated") return false;
    const [entitlement] = await connection.db
      .select({ status: founderProductEntitlements.status })
      .from(founderProductEntitlements)
      .where(eq(founderProductEntitlements.userId, userId))
      .limit(1);
    return entitlement?.status === "verified";
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function hasFounderGeneralReleaseBriefAccessForUser(
  userId: string,
  dependencies: Pick<Dependencies, "createConnection" | "now"> = {},
): Promise<boolean> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await reconcileFounderGeneralReleaseDeadlineForUser(
      userId,
      dependencies.now?.() ?? new Date(),
      {
        createConnection: () => connection,
      },
    );
    const [activation] = await connection.db
      .select({
        status: founderGeneralReleaseActivations.status,
        firstBriefId: founderGeneralReleaseActivations.firstBriefId,
      })
      .from(founderGeneralReleaseActivations)
      .where(eq(founderGeneralReleaseActivations.userId, userId))
      .limit(1);
    return activation?.status === "activated" && Boolean(activation.firstBriefId);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function founderGeneralReleaseSetupAuthorizesInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  await reconcileFounderGeneralReleaseDeadlineInTransaction(tx, userId, now);
  const [activation] = await tx
    .select({
      status: founderGeneralReleaseActivations.status,
      admissionState: founderGeneralReleaseActivations.admissionState,
    })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1);
  if (!activation || activation.admissionState === "unavailable") return false;
  if (["setup", "waitlisted", "provisioning", "activation_pending"].includes(activation.status)) {
    return true;
  }
  if (activation.status !== "activated") return false;
  const [entitlement] = await tx
    .select({ status: founderProductEntitlements.status })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  return entitlement?.status === "verified";
}

export async function confirmFounderGeneralReleaseEligibility(
  input: { userId: string; serviceBusinessConfirmed: boolean; geographyCode: string; now: Date },
  dependencies: Dependencies = {},
): Promise<FounderGeneralReleaseActivationDto> {
  if (!input.serviceBusinessConfirmed) {
    throw new FounderGeneralReleaseError(
      "service_business_required",
      "Initial General Release is for eligible Founder-led Service Businesses.",
      400,
    );
  }
  const geographyCode = input.geographyCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(geographyCode)) {
    throw new FounderGeneralReleaseError(
      "geography_required",
      "Choose the two-letter country where your business operates.",
      400,
    );
  }
  const availability = readFounderGeneralReleaseAvailability(
    dependencies.env ?? process.env,
    geographyCode,
  );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      const { operatorId } = await requireActiveFounderOperatorAuthorityInTransaction(
        tx,
        input.userId,
      );
      const [existing] = await tx
        .select()
        .from(founderGeneralReleaseActivations)
        .where(eq(founderGeneralReleaseActivations.userId, input.userId))
        .limit(1)
        .for("update");
      if (existing && !["setup", "waitlisted"].includes(existing.status)) return;
      const status = availability.admissionState === "eligible" ? "setup" : "waitlisted";
      await tx
        .insert(founderGeneralReleaseActivations)
        .values({
          userId: input.userId,
          operatorId,
          status,
          serviceBusinessConfirmedAt: existing?.serviceBusinessConfirmedAt ?? input.now,
          geographyCode,
          admissionState: availability.admissionState,
          admissionReason: availability.reason,
          publishedPriceLabel: availability.priceLabel,
          capacityObservedAt: input.now,
          createdAt: existing?.createdAt ?? input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: founderGeneralReleaseActivations.userId,
          set: {
            status,
            geographyCode,
            admissionState: availability.admissionState,
            admissionReason: availability.reason,
            publishedPriceLabel: availability.priceLabel,
            capacityObservedAt: input.now,
            updatedAt: input.now,
          },
        });
    });
    return await connection.db.transaction((tx) =>
      projectGeneralRelease(tx, input.userId, availability),
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function createFounderGeneralReleaseOperator(
  input: { userId: string; now: Date },
  dependencies: Dependencies = {},
): Promise<FounderGeneralReleaseActivationDto> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const env = dependencies.env ?? process.env;
  try {
    if (!areFounderGeneralReleaseAiProvidersReleased(env, input.now)) {
      throw new FounderGeneralReleaseError(
        "ai_providers_not_released",
        "Current independently released OpenAI and Anthropic connections are required before creating your Operator.",
      );
    }
    const availability = await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      const [activation] = await tx
        .select()
        .from(founderGeneralReleaseActivations)
        .where(eq(founderGeneralReleaseActivations.userId, input.userId))
        .limit(1)
        .for("update");
      if (!activation) {
        throw new FounderGeneralReleaseError(
          "eligibility_required",
          "Confirm public Initial General Release eligibility before creating your Operator.",
        );
      }
      const currentAvailability = readFounderGeneralReleaseAvailability(
        env,
        activation.geographyCode,
      );
      if (currentAvailability.admissionState !== "eligible") {
        await tx
          .update(founderGeneralReleaseActivations)
          .set({
            status: "waitlisted",
            admissionState: currentAvailability.admissionState,
            admissionReason: currentAvailability.reason,
            capacityObservedAt: input.now,
            updatedAt: input.now,
          })
          .where(eq(founderGeneralReleaseActivations.id, activation.id));
        throw new FounderGeneralReleaseError("capacity_unavailable", currentAvailability.reason);
      }
      if (
        ["activation_pending", "activated", "retirement_due", "retired"].includes(activation.status)
      ) {
        return currentAvailability;
      }
      if (activation.status === "provisioning") {
        throw new FounderGeneralReleaseError(
          "provisioning_in_progress",
          "Bruno.Ai is already creating your Operator.",
        );
      }
      const readiness = await readSetupReadiness(tx, activation.operatorId);
      if (!readiness.readyAiConnection || !readiness.selectedCompanyConnections) {
        throw new FounderGeneralReleaseError(
          "connections_not_ready",
          "Connect at least one Ready OpenAI or Anthropic account and select Current Calendar and Mail connections before creating your Operator.",
        );
      }
      if (!readiness.processingConsent) {
        throw new FounderGeneralReleaseError(
          "processing_consent_required",
          "Confirm Processing Consent and the safe Authority Policy before creating your Operator.",
        );
      }
      await tx
        .update(founderGeneralReleaseActivations)
        .set({
          status: "provisioning",
          admissionState: "eligible",
          admissionReason: currentAvailability.reason,
          capacityObservedAt: input.now,
          createConfirmedAt: input.now,
          setupEvidenceDigest: founderProductContractDigest(
            JSON.stringify({
              kind: "initial_general_release_setup",
              userId: input.userId,
              operatorId: activation.operatorId,
              geographyCode: activation.geographyCode,
              admissionState: currentAvailability.admissionState,
              publishedPriceLabel: currentAvailability.priceLabel,
              capacityObservedAt: input.now.toISOString(),
              createConfirmedAt: input.now.toISOString(),
              aiConnectionId: readiness.aiConnectionId,
              anthropicConnectionId: readiness.anthropicConnectionId,
              calendarConnectionId: readiness.calendarConnectionId,
              mailConnectionId: readiness.mailConnectionId,
              processingConsentId: readiness.processingConsentId,
              authorityPolicyId: readiness.authorityPolicyId,
            }),
          ),
          updatedAt: input.now,
        })
        .where(eq(founderGeneralReleaseActivations.id, activation.id));
      return currentAvailability;
    });

    const existing = await connection.db
      .select()
      .from(founderGeneralReleaseActivations)
      .where(eq(founderGeneralReleaseActivations.userId, input.userId))
      .limit(1);
    if (existing[0]?.runnerId) {
      return await connection.db.transaction((tx) =>
        projectGeneralRelease(tx, input.userId, availability),
      );
    }
    const provisionRunner =
      dependencies.provisionRunner ??
      ((userId, payload) =>
        createDigitalOceanRunnerForUser(userId, payload, { createConnection: () => connection }));
    const result = await provisionRunner(input.userId, {
      provider: "digitalocean",
      name: DEFAULT_RUNNER_NAME,
    });
    if (!result.ok) {
      await resetProvisioningAfterFailure(connection, input.userId, input.now);
      throw new FounderGeneralReleaseError(
        "provisioning_unavailable",
        "DigitalOcean provisioning is unavailable. No Operator Droplet was created.",
        503,
      );
    }
    const dropletCreatedAt = authoritativeDropletCreatedAt(result.runner);
    if (!result.runner.providerResourceId || !dropletCreatedAt) {
      await resetProvisioningAfterFailure(connection, input.userId, input.now);
      throw new FounderGeneralReleaseError(
        "droplet_creation_unconfirmed",
        "Bruno.Ai could not confirm authoritative Droplet creation.",
        503,
      );
    }
    await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      await tx
        .update(founderGeneralReleaseActivations)
        .set({
          runnerId: result.runner.id,
          status: "activation_pending",
          dropletCreatedAt,
          activationDueAt: new Date(
            dropletCreatedAt.valueOf() + FOUNDER_GENERAL_RELEASE_ACTIVATION_WINDOW_MS,
          ),
          updatedAt: input.now,
        })
        .where(
          and(
            eq(founderGeneralReleaseActivations.userId, input.userId),
            eq(founderGeneralReleaseActivations.status, "provisioning"),
          ),
        );
    });
    return await connection.db.transaction((tx) =>
      projectGeneralRelease(tx, input.userId, availability),
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function areFounderGeneralReleaseAiProvidersReleased(
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): boolean {
  return isFounderOpenAiReleased(env, now) && isFounderAnthropicReleased(env, now);
}

export async function recordFounderGeneralReleaseActivationInTransaction(
  tx: FounderProductContractTransaction,
  input: { userId: string; operatorId: string; firstBriefId: string; activatedAt: Date },
): Promise<void> {
  const [activation] = await tx
    .select()
    .from(founderGeneralReleaseActivations)
    .where(
      and(
        eq(founderGeneralReleaseActivations.userId, input.userId),
        eq(founderGeneralReleaseActivations.operatorId, input.operatorId),
      ),
    )
    .limit(1)
    .for("update");
  if (!activation) return;
  if (activation.activatedAt) return;
  if (
    activation.status !== "activation_pending" ||
    !activation.dropletCreatedAt ||
    !activation.activationDueAt
  ) {
    throw new FounderGeneralReleaseError(
      "activation_unavailable",
      "Founder Activation is unavailable until authoritative Droplet creation is recorded.",
    );
  }
  if (input.activatedAt > activation.activationDueAt) {
    throw new FounderGeneralReleaseError(
      "activation_window_expired",
      "The 24-hour Founder Activation window has ended.",
    );
  }
  const [brief] = await tx
    .select({
      evidenceState: operatorMorningBriefs.evidenceState,
      quiet: operatorMorningBriefs.quiet,
      attentionCount: operatorMorningBriefs.attentionCount,
      evidenceDigest: operatorMorningBriefs.evidenceDigest,
      generatedAt: operatorMorningBriefs.generatedAt,
    })
    .from(operatorMorningBriefs)
    .where(
      and(
        eq(operatorMorningBriefs.id, input.firstBriefId),
        eq(operatorMorningBriefs.operatorId, input.operatorId),
      ),
    )
    .limit(1);
  const [supportedItem] = await tx
    .select({ id: operatorMorningBriefItems.id })
    .from(operatorMorningBriefItems)
    .where(
      and(
        eq(operatorMorningBriefItems.briefId, input.firstBriefId),
        eq(operatorMorningBriefItems.operatorId, input.operatorId),
      ),
    )
    .limit(1);
  if (
    brief?.evidenceState !== "current" ||
    brief.generatedAt < activation.dropletCreatedAt ||
    input.activatedAt < activation.dropletCreatedAt ||
    !(
      (brief.quiet && brief.attentionCount === 0 && !supportedItem) ||
      (!brief.quiet && brief.attentionCount > 0 && Boolean(supportedItem))
    )
  ) {
    throw new FounderGeneralReleaseError(
      "brief_evidence_required",
      "Founder Activation requires a supported item or a Verified Quiet Brief.",
    );
  }
  await tx
    .update(founderGeneralReleaseActivations)
    .set({
      status: "activated",
      firstBriefId: input.firstBriefId,
      activationEvidenceDigest: brief.evidenceDigest,
      activatedAt: input.activatedAt,
      entitlementDueAt: new Date(
        input.activatedAt.valueOf() + FOUNDER_GENERAL_RELEASE_PURCHASE_WINDOW_MS,
      ),
      workStoppedAt: input.activatedAt,
      updatedAt: input.activatedAt,
    })
    .where(eq(founderGeneralReleaseActivations.id, activation.id));
  await tx
    .update(operators)
    .set({
      externalActionPause: true,
      externalActionPauseReason: FOUNDER_GENERAL_RELEASE_WORK_PAUSE_REASON,
      externalActionPausedAt: input.activatedAt,
      updatedAt: input.activatedAt,
    })
    .where(eq(operators.id, input.operatorId));
}

export async function requireFounderGeneralReleasePurchaseDecisionInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  now: Date,
  options: { allowExistingEntitlement?: boolean } = {},
): Promise<void> {
  if (options.allowExistingEntitlement) {
    const [entitlement] = await tx
      .select({ status: founderProductEntitlements.status })
      .from(founderProductEntitlements)
      .where(eq(founderProductEntitlements.userId, userId))
      .limit(1);
    if (entitlement?.status === "verified") return;
  }
  const [activation] = await tx
    .select({
      status: founderGeneralReleaseActivations.status,
      activatedAt: founderGeneralReleaseActivations.activatedAt,
      entitlementDueAt: founderGeneralReleaseActivations.entitlementDueAt,
      retirementDueAt: founderGeneralReleaseActivations.retirementDueAt,
    })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1)
    .for("update");
  // Existing closed-stage and attended canary users have no public General
  // Release application. Their separately qualified commerce lifecycle remains
  // valid; every public self-serve applicant has this row before checkout.
  if (!activation) return;
  if (
    activation.status !== "activated" ||
    !activation.activatedAt ||
    !activation.entitlementDueAt ||
    activation.entitlementDueAt <= now ||
    activation.retirementDueAt
  ) {
    throw new FounderGeneralReleaseError(
      "purchase_decision_unavailable",
      "The published paid offer is available only after Founder Activation and before the 24-hour decision deadline.",
    );
  }
}

export async function founderGeneralReleaseAuthorizesNewWorkInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  await reconcileFounderGeneralReleaseDeadlineInTransaction(tx, userId, now);
  const [activation] = await tx
    .select({ status: founderGeneralReleaseActivations.status })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1);
  if (
    !activation ||
    ["setup", "waitlisted", "provisioning", "activation_pending"].includes(activation.status)
  ) {
    return true;
  }
  const [entitlement] = await tx
    .select({ status: founderProductEntitlements.status })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  return entitlement?.status === "verified";
}

export async function founderGeneralReleaseAuthorizesWorkAuthorityInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<boolean> {
  const [activation] = await tx
    .select({ status: founderGeneralReleaseActivations.status })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1);
  if (!activation || !["activated"].includes(activation.status)) return false;
  const [entitlement] = await tx
    .select({ status: founderProductEntitlements.status })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  return entitlement?.status === "verified";
}

export async function founderGeneralReleaseUsesPublicAiRoutingInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
): Promise<boolean> {
  const [activation] = await tx
    .select({
      status: founderGeneralReleaseActivations.status,
      admissionState: founderGeneralReleaseActivations.admissionState,
    })
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1);
  return Boolean(
    activation &&
      activation.admissionState === "eligible" &&
      !["retirement_due", "retired"].includes(activation.status),
  );
}

export async function reconcileFounderGeneralReleaseDeadlineForUser(
  userId: string,
  now: Date,
  dependencies: Pick<Dependencies, "createConnection"> = {},
): Promise<void> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction((tx) =>
      reconcileFounderGeneralReleaseDeadlineInTransaction(tx, userId, now),
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function reconcileFounderGeneralReleaseDeadlineInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  now: Date,
): Promise<void> {
  await lockFounderProductContractLifecycleInTransaction(tx, userId);
  const [activation] = await tx
    .select()
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1)
    .for("update");
  if (!activation || activation.retirementDueAt || activation.status === "retired") return;
  const [entitlement] = await tx
    .select({ status: founderProductEntitlements.status })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  if (entitlement?.status === "verified") return;
  const activationExpired =
    activation.status === "activation_pending" &&
    activation.activationDueAt !== null &&
    activation.activationDueAt <= now;
  const purchaseExpired =
    activation.status === "activated" &&
    activation.entitlementDueAt !== null &&
    activation.entitlementDueAt <= now;
  if (!activationExpired && !purchaseExpired) return;
  const workStoppedAt = activationExpired
    ? (activation.workStoppedAt ?? activation.activationDueAt)
    : (activation.workStoppedAt ?? activation.activatedAt ?? activation.entitlementDueAt);
  if (!workStoppedAt) throw new Error("General Release stop-work deadline is unavailable.");
  const retirementDueAt = activationExpired
    ? new Date(workStoppedAt.valueOf() + FOUNDER_GENERAL_RELEASE_ACTIVATION_RETIREMENT_WINDOW_MS)
    : activation.entitlementDueAt;
  if (!retirementDueAt) throw new Error("General Release retirement deadline is unavailable.");
  await tx
    .update(founderGeneralReleaseActivations)
    .set({ status: "retirement_due", workStoppedAt, retirementDueAt, updatedAt: now })
    .where(eq(founderGeneralReleaseActivations.id, activation.id));
  await tx
    .update(operators)
    .set({
      externalActionPause: true,
      externalActionPauseReason: FOUNDER_GENERAL_RELEASE_WORK_PAUSE_REASON,
      externalActionPausedAt: workStoppedAt,
      updatedAt: now,
    })
    .where(eq(operators.id, activation.operatorId));
}

export async function declineFounderGeneralReleaseOffer(
  userId: string,
  now: Date,
  dependencies: Pick<Dependencies, "createConnection"> = {},
): Promise<void> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction(async (tx) => {
      await lockFounderProductContractLifecycleInTransaction(tx, userId);
      const [activation] = await tx
        .select()
        .from(founderGeneralReleaseActivations)
        .where(eq(founderGeneralReleaseActivations.userId, userId))
        .limit(1)
        .for("update");
      if (activation?.status !== "activated" || !activation.activatedAt) {
        throw new FounderGeneralReleaseError(
          "offer_decline_unavailable",
          "The published offer can be declined only after Founder Activation.",
        );
      }
      const [entitlement] = await tx
        .select({ status: founderProductEntitlements.status })
        .from(founderProductEntitlements)
        .where(eq(founderProductEntitlements.userId, userId))
        .limit(1);
      if (entitlement?.status === "verified") {
        throw new FounderGeneralReleaseError(
          "offer_already_accepted",
          "Paid Product Entitlement is already verified.",
        );
      }
      const retirementDueAt =
        activation.entitlementDueAt && activation.entitlementDueAt <= now
          ? activation.entitlementDueAt
          : now;
      await tx
        .update(founderGeneralReleaseActivations)
        .set({ status: "retirement_due", retirementDueAt, updatedAt: now })
        .where(eq(founderGeneralReleaseActivations.id, activation.id));
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function requireFounderGeneralReleaseRetirementDueInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  now: Date,
): Promise<Date | null> {
  const [activation] = await tx
    .select({ retirementDueAt: founderGeneralReleaseActivations.retirementDueAt })
    .from(founderGeneralReleaseActivations)
    .where(
      and(
        eq(founderGeneralReleaseActivations.userId, userId),
        eq(founderGeneralReleaseActivations.status, "retirement_due"),
        lte(founderGeneralReleaseActivations.retirementDueAt, now),
      ),
    )
    .limit(1);
  return activation?.retirementDueAt ?? null;
}

export async function markFounderGeneralReleaseRetiredInTransaction(
  tx: FounderProductContractTransaction,
  userId: string,
  retiredAt: Date,
): Promise<void> {
  await tx
    .update(founderGeneralReleaseActivations)
    .set({ status: "retired", retiredAt, updatedAt: retiredAt })
    .where(
      and(
        eq(founderGeneralReleaseActivations.userId, userId),
        eq(founderGeneralReleaseActivations.status, "retirement_due"),
      ),
    );
}

export async function findNextFounderGeneralReleaseDeadlineUser(
  now: Date,
  connection: DatabaseConnection,
): Promise<string | null> {
  const [candidate] = await connection.db
    .select({ userId: founderGeneralReleaseActivations.userId })
    .from(founderGeneralReleaseActivations)
    .where(
      and(
        eq(founderGeneralReleaseActivations.status, "activation_pending"),
        isNull(founderGeneralReleaseActivations.retirementDueAt),
        isNull(founderGeneralReleaseActivations.retiredAt),
        lte(founderGeneralReleaseActivations.activationDueAt, now),
      ),
    )
    .orderBy(founderGeneralReleaseActivations.activationDueAt)
    .limit(1);
  if (candidate) return candidate.userId;
  const [purchaseCandidate] = await connection.db
    .select({ userId: founderGeneralReleaseActivations.userId })
    .from(founderGeneralReleaseActivations)
    .where(
      and(
        eq(founderGeneralReleaseActivations.status, "activated"),
        isNull(founderGeneralReleaseActivations.retirementDueAt),
        lte(founderGeneralReleaseActivations.entitlementDueAt, now),
        notExists(
          connection.db
            .select({ id: founderProductEntitlements.id })
            .from(founderProductEntitlements)
            .where(
              and(
                eq(founderProductEntitlements.userId, founderGeneralReleaseActivations.userId),
                eq(founderProductEntitlements.status, "verified"),
              ),
            ),
        ),
      ),
    )
    .orderBy(founderGeneralReleaseActivations.entitlementDueAt)
    .limit(1);
  return purchaseCandidate?.userId ?? null;
}

export async function findNextFounderGeneralReleaseRetirementUser(
  now: Date,
  connection: DatabaseConnection,
): Promise<string | null> {
  const [candidate] = await connection.db
    .select({ userId: founderGeneralReleaseActivations.userId })
    .from(founderGeneralReleaseActivations)
    .where(
      and(
        eq(founderGeneralReleaseActivations.status, "retirement_due"),
        lte(founderGeneralReleaseActivations.retirementDueAt, now),
      ),
    )
    .orderBy(founderGeneralReleaseActivations.retirementDueAt)
    .limit(1);
  return candidate?.userId ?? null;
}

function readFounderGeneralReleaseAvailability(
  env: Record<string, string | undefined>,
  geographyCode: string | null,
): FounderGeneralReleaseAvailability {
  const mode = env.BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY?.trim() ?? "unavailable";
  if (!new Set(["open", "waitlist", "unavailable"]).has(mode)) {
    throw new FounderGeneralReleaseError(
      "general_release_configuration_invalid",
      "Initial General Release availability is configured unsafely.",
      503,
    );
  }
  const regions = new Set(
    (env.BRUNO_INITIAL_GENERAL_RELEASE_GEOGRAPHIES ?? "")
      .split(",")
      .map((value) => value.trim().toUpperCase())
      .filter((value) => /^[A-Z]{2}$/.test(value)),
  );
  const geographySupported = geographyCode === null || regions.has(geographyCode);
  const configuredReason = env.BRUNO_INITIAL_GENERAL_RELEASE_AVAILABILITY_MESSAGE?.trim();
  const priceLabel = readPublishedPriceLabel(env);
  if (mode === "open" && geographySupported && priceLabel) {
    return {
      admissionState: "eligible",
      geographyCode: geographyCode ?? "",
      priceLabel,
      reason:
        configuredReason ??
        "Capacity is available for self-serve Founder-led Service Businesses in this geography.",
    };
  }
  if (mode === "waitlist" || (mode === "open" && !geographySupported)) {
    return {
      admissionState: "waitlisted",
      geographyCode: geographyCode ?? "",
      priceLabel,
      reason:
        configuredReason ??
        (geographySupported
          ? "Capacity is full. Your place on the public waitlist does not require a personal invitation."
          : "Initial General Release is not yet available in this geography. You can join the public waitlist."),
    };
  }
  return {
    admissionState: "unavailable",
    geographyCode: geographyCode ?? "",
    priceLabel,
    reason:
      configuredReason ??
      (priceLabel
        ? "Initial General Release is not accepting new Operator creation right now."
        : "Initial General Release remains unavailable until one published Bruno.Ai price is configured."),
  };
}

function readPublishedPriceLabel(env: Record<string, string | undefined>): string | null {
  const value = env.BRUNO_INITIAL_GENERAL_RELEASE_PRICE_LABEL?.trim() ?? "";
  if (!value) return null;
  const impliesFreeAccess =
    /\b(free|beta|secret|negotiat|complimentary|no[- ]cost)\b/i.test(value) ||
    /[$€£¥]\s*0(?:[.,]0+)?(?:\s*\/|\s+per\b|\s*$)/i.test(value) ||
    /\b0(?:[.,]0+)?\s*(?:usd|eur|gbp|php|cad|aud|jpy)\b/i.test(value);
  if (value.length > 80 || impliesFreeAccess) {
    throw new FounderGeneralReleaseError(
      "general_release_price_invalid",
      "The published Bruno.Ai price is configured unsafely.",
      503,
    );
  }
  return value;
}

async function readSetupReadiness(tx: FounderProductContractTransaction, operatorId: string) {
  const [[openAi], [anthropic], [calendar], [mail], [operation]] = await Promise.all([
    tx
      .select({ id: operatorAiConnections.id })
      .from(operatorAiConnections)
      .where(
        and(
          eq(operatorAiConnections.operatorId, operatorId),
          eq(operatorAiConnections.provider, "openai"),
          eq(operatorAiConnections.status, "ready"),
        ),
      )
      .limit(1),
    tx
      .select({ id: operatorAiConnections.id })
      .from(operatorAiConnections)
      .where(
        and(
          eq(operatorAiConnections.operatorId, operatorId),
          eq(operatorAiConnections.provider, "anthropic"),
          eq(operatorAiConnections.status, "ready"),
        ),
      )
      .limit(1),
    tx
      .select({ id: operatorCalendarConnections.id })
      .from(operatorCalendarConnections)
      .where(
        and(
          eq(operatorCalendarConnections.operatorId, operatorId),
          eq(operatorCalendarConnections.status, "ready"),
          eq(operatorCalendarConnections.evidenceState, "current"),
        ),
      )
      .orderBy(desc(operatorCalendarConnections.updatedAt))
      .limit(1),
    tx
      .select({ id: operatorMailConnections.id })
      .from(operatorMailConnections)
      .where(
        and(
          eq(operatorMailConnections.operatorId, operatorId),
          eq(operatorMailConnections.status, "ready"),
          eq(operatorMailConnections.evidenceState, "current"),
        ),
      )
      .orderBy(desc(operatorMailConnections.updatedAt))
      .limit(1),
    tx
      .select({
        calendarConnectionId: operatorLimitedOperations.calendarConnectionId,
        mailConnectionId: operatorLimitedOperations.mailConnectionId,
        processingConsentId: operatorLimitedOperations.processingConsentId,
        authorityPolicyId: operatorLimitedOperations.authorityPolicyId,
      })
      .from(operatorLimitedOperations)
      .where(
        and(
          eq(operatorLimitedOperations.operatorId, operatorId),
          eq(operatorLimitedOperations.status, "core"),
        ),
      )
      .limit(1),
  ]);
  const [consent] = operation?.processingConsentId
    ? await tx
        .select({ id: operatorProcessingConsents.id })
        .from(operatorProcessingConsents)
        .where(
          and(
            eq(operatorProcessingConsents.id, operation.processingConsentId),
            eq(operatorProcessingConsents.status, "active"),
          ),
        )
        .limit(1)
    : [];
  return {
    readyAiConnection: Boolean(openAi || anthropic),
    selectedCompanyConnections: Boolean(
      calendar &&
        mail &&
        operation?.calendarConnectionId === calendar.id &&
        operation.mailConnectionId === mail.id,
    ),
    processingConsent: Boolean(consent && operation?.authorityPolicyId),
    aiConnectionId: openAi?.id ?? null,
    anthropicConnectionId: anthropic?.id ?? null,
    calendarConnectionId: calendar?.id ?? null,
    mailConnectionId: mail?.id ?? null,
    processingConsentId: consent?.id ?? null,
    authorityPolicyId: operation?.authorityPolicyId ?? null,
  };
}

async function projectGeneralRelease(
  tx: FounderProductContractTransaction,
  userId: string,
  availability: FounderGeneralReleaseAvailability,
): Promise<FounderGeneralReleaseActivationDto> {
  const [activation] = await tx
    .select()
    .from(founderGeneralReleaseActivations)
    .where(eq(founderGeneralReleaseActivations.userId, userId))
    .limit(1);
  const [operator] = await tx
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.userId, userId), eq(operators.status, "active")))
    .limit(1);
  const readiness = operator
    ? await readSetupReadiness(tx, operator.id)
    : {
        readyAiConnection: false,
        selectedCompanyConnections: false,
        processingConsent: false,
        aiConnectionId: null,
        anthropicConnectionId: null,
        calendarConnectionId: null,
        mailConnectionId: null,
        processingConsentId: null,
        authorityPolicyId: null,
      };
  const [entitlement] = await tx
    .select({ status: founderProductEntitlements.status })
    .from(founderProductEntitlements)
    .where(eq(founderProductEntitlements.userId, userId))
    .limit(1);
  const admissionState = activation?.admissionState ?? availability.admissionState;
  const state =
    entitlement?.status === "verified"
      ? "entitled"
      : ((activation?.status ??
          (admissionState === "eligible"
            ? "setup"
            : "waitlisted")) as FounderGeneralReleaseActivationDto["state"]);
  const priceLabel = activation?.publishedPriceLabel ?? availability.priceLabel;
  return {
    state,
    admission: {
      publicSelfServe: true,
      personalSelection: false,
      geographyCode: activation?.geographyCode ?? null,
      capacity:
        admissionState === "eligible"
          ? "available"
          : admissionState === "waitlisted"
            ? "waitlist"
            : "unavailable",
      reason: activation?.admissionReason ?? availability.reason,
    },
    setup: {
      authenticated: true,
      serviceBusinessConfirmed: Boolean(activation?.serviceBusinessConfirmedAt),
      readyAiConnection: readiness.readyAiConnection,
      selectedCompanyConnections: readiness.selectedCompanyConnections,
      processingConsent: readiness.processingConsent,
      explicitCreateConfirmed: Boolean(activation?.createConfirmedAt),
      canCreate:
        admissionState === "eligible" &&
        Boolean(activation?.serviceBusinessConfirmedAt) &&
        readiness.readyAiConnection &&
        readiness.selectedCompanyConnections &&
        readiness.processingConsent &&
        !activation?.createConfirmedAt,
    },
    activation: {
      dropletCreatedAt: activation?.dropletCreatedAt?.toISOString() ?? null,
      dueAt: activation?.activationDueAt?.toISOString() ?? null,
      activatedAt: activation?.activatedAt?.toISOString() ?? null,
    },
    offer: {
      available: state === "activated" && Boolean(priceLabel),
      priceLabel,
      brunoPriceSeparateFromAiProviderCosts: true,
      aiProviderCosts: "Paid separately to OpenAI or Anthropic",
      freeTier: false,
      betaConversion: false,
      decisionDueAt: activation?.entitlementDueAt?.toISOString() ?? null,
    },
    retirement: {
      dueAt: activation?.retirementDueAt?.toISOString() ?? null,
      workStoppedAt: activation?.workStoppedAt?.toISOString() ?? null,
    },
  };
}

function authoritativeDropletCreatedAt(runner: RunnerProvisioningDto): Date | null {
  const event = runner.provisioning.phases.find(
    (phase) => phase.phase === "creating" && phase.status === "completed",
  );
  if (!event) return null;
  const value = event.metadata.providerCreatedAt;
  if (typeof value !== "string") return null;
  const createdAt = new Date(value);
  return Number.isNaN(createdAt.valueOf()) ? null : createdAt;
}

async function resetProvisioningAfterFailure(
  connection: DatabaseConnection,
  userId: string,
  now: Date,
): Promise<void> {
  await connection.db
    .update(founderGeneralReleaseActivations)
    .set({ status: "setup", createConfirmedAt: null, setupEvidenceDigest: null, updatedAt: now })
    .where(
      and(
        eq(founderGeneralReleaseActivations.userId, userId),
        eq(founderGeneralReleaseActivations.status, "provisioning"),
        isNull(founderGeneralReleaseActivations.runnerId),
      ),
    );
}
