import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import type { DatabaseConnection } from "@/src/server/db/client";
import { users } from "@/src/server/db/schema";
import { createFounderContractIdentityHeaders } from "@/src/server/founder-product-contract/deterministic-identity";
import {
  deterministicFounderContractConnectionRevoked,
  deterministicFounderLifecycleProviders,
  type FounderLifecycleFailureOperation,
} from "@/src/server/founder-product-contract/deterministic-providers";
import {
  claimFounderProductContractScenarioExecution,
  completeFounderProductContractScenarioExecution,
  failFounderProductContractScenarioExecution,
  issueFounderProductContractScenarioLedger,
} from "@/src/server/founder-product-contract/evidence";
import {
  type FounderGeneralReleaseActivationDto,
  getFounderGeneralReleaseActivationForUser,
  hasFounderGeneralReleaseSetupAccessForUser,
} from "@/src/server/founder-product-contract/initial-general-release";
import {
  executeFounderProductContractLifecycleAction,
  type FounderCommerceEvent,
  type FounderCommerceStatus,
  type FounderLifecycleInput,
  type FounderLifecycleOutcome,
  type FounderProductContractLifecycleAction,
  readFounderIdentitySeparationSnapshot,
} from "@/src/server/founder-product-contract/lifecycle";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { POST as generalReleasePOST } from "../../general-release/route";
import { GET as mailSendingCallbackGET } from "../../mail-sending/oauth/callback/route";
import { GET as mailSendingGET, POST as mailSendingPOST } from "../../mail-sending/route";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<FounderProductContractLifecycleAction>([
  "release_stage_admission",
  "initial_general_release_activation",
  "external_beta_cohort_lifecycle",
  "product_entitlement_lifecycle",
  "subscription_lifecycle",
  "recovery_archive_lifecycle",
  "infrastructure_retirement",
  "identity_recovery_lifecycle",
]);
const FAILURE_OPERATIONS = new Set<FounderLifecycleFailureOperation>([
  "clerk.authenticate",
  "openAI.verify_connection",
  "anthropic.verify_connection",
  "google.verify_connection",
  "google.verify_calendar_reading",
  "google.verify_gmail_reading",
  "google.verify_gmail_sending",
  "lemonSqueezy.read_subscription",
  "archive.create",
  "archive.corrupt",
  "archive.delete",
  "archive.delete_credentials",
  "digitalOcean.observe_owned_resources",
  "digitalOcean.delete_firewall",
  "digitalOcean.delete_droplet",
  "digitalOcean.observe_owned_resources_absent",
  "digitalOcean.create_restoration_droplet",
  "digitalOcean.configure_restoration_firewall",
  "openAI.reauthorize",
  "anthropic.reauthorize",
  "google.reauthorize_company",
  "lemonSqueezy.refund_restoration",
]);
const COMMERCE_STATUSES = new Set<FounderCommerceStatus>([
  "active",
  "past_due",
  "unpaid",
  "cancelled",
  "expired",
  "refunded",
]);

export async function GET(request: Request): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
  }
  if (!deterministicBoundaryAvailable()) {
    return Response.json({ error: { code: "provider_boundary_unavailable" } }, { status: 503 });
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return Response.json({ error: { code: "invalid_ledger_request" } }, { status: 400 });
  }
  const identity = contractIdentity();
  const signingSecret = process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET ?? "";
  if (!identity || !signingSecret) {
    return Response.json({ error: { code: "ledger_authority_unavailable" } }, { status: 503 });
  }
  try {
    const ledger = await issueFounderProductContractScenarioLedger({
      ...identity,
      userId: applicationUser.userId,
      signingSecret,
    });
    return Response.json({ ledger }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "ledger_incomplete",
          message: error instanceof Error ? error.message : "Lifecycle ledger is incomplete.",
        },
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
  }
  if (!deterministicBoundaryAvailable()) {
    return Response.json({ error: { code: "provider_boundary_unavailable" } }, { status: 503 });
  }

  const body = await readBody(request);
  if (!body || !ACTIONS.has(body.action)) {
    return Response.json({ error: { code: "invalid_lifecycle_request" } }, { status: 400 });
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(body.runId)) {
    return Response.json({ error: { code: "invalid_lifecycle_identity" } }, { status: 400 });
  }
  const identity = contractIdentity();
  if (!identity) {
    return Response.json({ error: { code: "application_revision_unavailable" } }, { status: 503 });
  }
  if (body.runId !== identity.runId) {
    return Response.json({ error: { code: "lifecycle_identity_mismatch" } }, { status: 409 });
  }
  const commerceWebhookSecret =
    process.env.BRUNO_FOUNDER_CONTRACT_COMMERCE_WEBHOOK_SECRET ??
    (process.env.BRUNO_AUTH_MODE === "development" ? "founder-contract-lemon-test-secret-v1" : "");
  if (!commerceWebhookSecret) {
    return Response.json({ error: { code: "commerce_boundary_unavailable" } }, { status: 503 });
  }
  const identityRecoverySigningSecret =
    process.env.BRUNO_FOUNDER_CONTRACT_IDENTITY_RECOVERY_SIGNING_SECRET ??
    (process.env.BRUNO_AUTH_MODE === "development"
      ? "founder-contract-identity-recovery-signing-secret-v1"
      : "");
  if (!identityRecoverySigningSecret) {
    return Response.json({ error: { code: "identity_boundary_unavailable" } }, { status: 503 });
  }

  const now = new Date(body.now);
  const providers = deterministicFounderLifecycleProviders({
    runId: body.runId,
    userId: applicationUser.userId,
    now,
    failures: body.providerFailures,
    subscriptionStatus: body.providerSubscriptionStatus,
    ...(body.restorationContract
      ? { partialRestorationUserId: body.restorationContract.partialFailureUserId }
      : {}),
  });
  const evidenceIdentity = {
    runId: identity.runId,
    userId: applicationUser.userId,
    sourceRevision: identity.sourceRevision,
    runtimeRevision: identity.runtimeRevision,
    scenarioId: body.action,
    observedAt: now,
  };
  let claimed = false;
  try {
    claimed = true;
    await claimFounderProductContractScenarioExecution(evidenceIdentity);
    const outcome = await executeFounderProductContractLifecycleAction(
      {
        action: body.action,
        runId: body.runId,
        userId: applicationUser.userId,
        now,
        ...(body.commerceEvent ? { commerceEvent: body.commerceEvent } : {}),
        ...(body.externalBetaContract ? { externalBetaContract: body.externalBetaContract } : {}),
        ...(body.restorationContract ? { restorationContract: body.restorationContract } : {}),
      },
      {
        providers,
        commerceWebhookSecret,
        identityRecoverySigningSecret,
        applicationRevision: identity.sourceRevision,
        generalReleaseApplication: (payload, observedAt) =>
          callGeneralReleaseApplication(applicationUser.userId, payload, observedAt),
        generalReleaseGmailBoundary: (phase, observedAt) =>
          executeGeneralReleaseGmailThroughPublicSeams({
            phase,
            observedAt,
            userId: applicationUser.userId,
            baseUrl: localContractBaseUrl(request),
          }),
        identityRecoveryPublicSeam: (scenario, connection) =>
          executeIdentityRecoveryThroughPublicSeams({
            input: scenario,
            connection,
            providers,
            baseUrl: localContractBaseUrl(request),
          }),
      },
    );
    await completeFounderProductContractScenarioExecution({ identity: evidenceIdentity, outcome });
    return Response.json({ outcome }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (claimed) {
      try {
        await failFounderProductContractScenarioExecution(evidenceIdentity);
      } catch {
        // The original lifecycle failure remains authoritative; ledger issuance still fails closed.
      }
    }
    return Response.json(
      {
        error: {
          code: "lifecycle_transition_failed",
          message: lifecycleErrorMessage(error),
        },
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}

async function callGeneralReleaseApplication(
  userId: string,
  payload:
    | {
        action: "confirm_eligibility";
        serviceBusinessConfirmed: true;
        geographyCode: "PH";
      }
    | { action: "create_operator" }
    | { action: "decline_offer" },
  now: Date,
): Promise<{
  status: number;
  generalRelease?: FounderGeneralReleaseActivationDto;
  error?: { code?: string; message?: string };
}> {
  const response = await generalReleasePOST(
    new Request("http://localhost/api/operator/general-release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
    undefined,
    {
      requireUser: async () => ({ ok: true, userId }),
      now: () => now,
      getStatus: (requestedUserId) => getGeneralReleaseStatusAt(requestedUserId, now),
    },
  );
  const body = (await response.json()) as {
    generalRelease?: FounderGeneralReleaseActivationDto;
    error?: { code?: string; message?: string };
  };
  return { status: response.status, ...body };
}

async function getGeneralReleaseStatusAt(
  userId: string,
  now: Date,
): Promise<FounderGeneralReleaseActivationDto> {
  return getFounderGeneralReleaseActivationForUser(userId, { now: () => now });
}

async function executeGeneralReleaseGmailThroughPublicSeams(input: {
  phase: "approved" | "held" | "resumed";
  observedAt: Date;
  userId: string;
  baseUrl: string;
}): Promise<{
  getAllowed: boolean;
  startAllowed: boolean;
  callbackAllowed: boolean;
  disconnectAllowed: boolean;
  providerEffectsStarted: number;
}> {
  let providerEffectsStarted = 0;
  const hasAccess: typeof hasFounderGeneralReleaseSetupAccessForUser = (
    userId,
    _dependencies,
    capabilities,
  ) =>
    hasFounderGeneralReleaseSetupAccessForUser(
      userId,
      { now: () => input.observedAt },
      capabilities,
    );
  const routeDependencies = {
    requireApplicationUser: async () => ({ ok: true as const, userId: input.userId }),
    hasGeneralReleaseSetupAccess: hasAccess,
  };
  const getResponse = await mailSendingGET(
    new Request(new URL("/api/operator/mail-sending", input.baseUrl)),
    undefined,
    {
      ...routeDependencies,
      getConnection: async () => null,
      getOffer: async () => true,
    },
  );
  const startResponse = await mailSendingPOST(
    new Request(new URL("/api/operator/mail-sending", input.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "start" }),
    }),
    undefined,
    {
      ...routeDependencies,
      startAuthorization: async () => {
        providerEffectsStarted += 1;
        return { connection: null, authorization: null };
      },
    },
  );
  const callbackResponse = await mailSendingCallbackGET(
    new Request(
      new URL(
        "/api/operator/mail-sending/oauth/callback?state=contract&code=contract",
        input.baseUrl,
      ),
    ),
    undefined,
    {
      resolveAuthorizationUser: async () => input.userId,
      hasGeneralReleaseSetupAccess: hasAccess,
      completeAuthorization: async () => {
        providerEffectsStarted += 1;
        return { status: "ready" } as never;
      },
    },
  );
  let disconnected = false;
  const disconnectResponse = await mailSendingPOST(
    new Request(new URL("/api/operator/mail-sending", input.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "disconnect" }),
    }),
    undefined,
    {
      ...routeDependencies,
      disconnectConnection: async () => {
        disconnected = true;
        return null;
      },
    },
  );
  return {
    getAllowed: getResponse.status === 200,
    startAllowed: startResponse.status === 200,
    callbackAllowed:
      callbackResponse.status === 303 &&
      callbackResponse.headers.get("location")?.includes("mail_sending=connected") === true,
    disconnectAllowed: disconnectResponse.status === 200 && disconnected,
    providerEffectsStarted,
  };
}

async function executeIdentityRecoveryThroughPublicSeams(input: {
  input: FounderLifecycleInput;
  connection: DatabaseConnection;
  providers: ReturnType<typeof deterministicFounderLifecycleProviders>;
  baseUrl: string;
}): Promise<FounderLifecycleOutcome> {
  const { connection, providers } = input;
  const identity = await providers.authenticateIdentity({ userId: input.input.userId });
  const [owner] = await connection.db
    .select({ clerkUserId: users.clerkUserId })
    .from(users)
    .where(eq(users.id, input.input.userId))
    .limit(1);
  if (!owner?.clerkUserId || owner.clerkUserId !== identity.subject) {
    throw new Error("The public identity journey did not start from the current internal Owner.");
  }

  const currentIdentityHeaders = createFounderContractIdentityHeaders(owner.clerkUserId);
  const credentialResponse = await fetch(
    new URL("/api/operator/identity-recovery", input.baseUrl),
    { method: "POST", headers: currentIdentityHeaders },
  );
  if (credentialResponse.status !== 200) {
    throw new Error(
      `The recently reauthenticated recovery-code journey was unavailable (${credentialResponse.status}: ${await credentialResponse.text()}).`,
    );
  }
  const credentialBody = (await credentialResponse.json()) as {
    credential?: { recoveryCode?: string };
  };
  const recoveryCode = credentialBody.credential?.recoveryCode;
  if (!recoveryCode) throw new Error("The public recovery-code journey returned no one-time code.");

  const beforeLoss = await readFounderIdentitySeparationSnapshot(connection, input.input.userId);
  const webhookBody = JSON.stringify({
    type: "user.deleted",
    data: { id: owner.clerkUserId },
  });
  const webhookId = `founder-contract:${input.input.runId}:clerk-user-deleted`;
  const webhookTimestamp = Math.floor(Date.now() / 1_000).toString();
  const webhookSigningSecret = process.env.CLERK_WEBHOOK_SIGNING_SECRET?.trim() ?? "";
  if (!webhookSigningSecret.startsWith("whsec_")) {
    throw new Error("The deterministic Clerk webhook authority was unavailable.");
  }
  const webhookKey = Buffer.from(webhookSigningSecret.slice("whsec_".length), "base64");
  if (webhookKey.length < 32) {
    throw new Error("The deterministic Clerk webhook authority was invalid.");
  }
  const webhookSignature = `v1,${createHmac("sha256", webhookKey)
    .update(`${webhookId}.${webhookTimestamp}.${webhookBody}`)
    .digest("base64")}`;
  const webhookResponse = await fetch(new URL("/api/webhooks/clerk", input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "svix-id": webhookId,
      "svix-timestamp": webhookTimestamp,
      "svix-signature": webhookSignature,
    },
    body: webhookBody,
  });
  if (webhookResponse.status !== 202) {
    throw new Error("The signature-verified Clerk webhook did not record identity loss.");
  }

  const lostAccessResponse = await fetch(new URL("/api/operator/privacy", input.baseUrl), {
    headers: currentIdentityHeaders,
  });
  if (lostAccessResponse.status !== 401) {
    throw new Error("The public Operator API did not deny the lost identity.");
  }

  const attackerClerkUserId = `clerk:attacker:${input.input.userId}`;
  const wrongRecoveryCode = `${recoveryCode.slice(0, -1)}${recoveryCode.endsWith("x") ? "y" : "x"}`;
  const takeoverResponse = await fetch(new URL("/api/identity-recovery", input.baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createFounderContractIdentityHeaders(attackerClerkUserId),
    },
    body: JSON.stringify({ recoveryCode: wrongRecoveryCode }),
  });
  if (takeoverResponse.status !== 403) {
    throw new Error("The public Identity Recovery API did not deny the attempted takeover.");
  }

  const replacementClerkUserId = `clerk:recovered:${input.input.userId}`;
  const recoveredIdentityHeaders = createFounderContractIdentityHeaders(replacementClerkUserId);
  const recoveredResponse = await fetch(new URL("/api/identity-recovery", input.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...recoveredIdentityHeaders },
    body: JSON.stringify({ recoveryCode }),
  });
  if (recoveredResponse.status !== 200) {
    throw new Error("The public Identity Recovery API did not restore the verified Owner.");
  }
  const recoveredBody = (await recoveredResponse.json()) as {
    recovery?: {
      state?: string;
      receipts?: Array<{ kind?: string }>;
    };
  };
  const receiptKinds = recoveredBody.recovery?.receipts?.map((receipt) => receipt.kind) ?? [];
  if (
    recoveredBody.recovery?.state !== "recovered" ||
    receiptKinds.join(",") !== "identity_loss_recorded,recovery_denied,identity_rebound"
  ) {
    throw new Error("The public Identity Recovery receipt view was incomplete.");
  }
  const recoveredStatusResponse = await fetch(new URL("/api/identity-recovery", input.baseUrl), {
    headers: recoveredIdentityHeaders,
  });
  if (recoveredStatusResponse.status !== 200) {
    throw new Error("The recovered identity was not visible through the public status API.");
  }

  const restoredAccessResponse = await fetch(new URL("/api/operator/privacy", input.baseUrl), {
    headers: recoveredIdentityHeaders,
  });
  if (restoredAccessResponse.status !== 200) {
    throw new Error("The public Operator API did not restore the same Owner.");
  }

  const afterRecovery = await readFounderIdentitySeparationSnapshot(connection, input.input.userId);
  if (JSON.stringify(beforeLoss) !== JSON.stringify(afterRecovery)) {
    throw new Error(
      "Identity Recovery changed commerce, entitlement, retirement, deletion, or archive authority.",
    );
  }

  const closureAt = new Date(input.input.now.valueOf() + 3);
  const closureCommerce = await providers.readSubscription({
    subscriptionId: `${input.input.runId}:subscription`,
  });
  if (closureCommerce.status !== "active") {
    throw new Error("Account Closure could not observe the active provider subscription state.");
  }
  const closureResponse = await fetch(new URL("/api/operator/privacy", input.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", ...recoveredIdentityHeaders },
    body: JSON.stringify({ action: "close_account", confirmation: "CLOSE_ACCOUNT" }),
  });
  const closureBody = (await closureResponse.json()) as {
    deletion?: {
      request?: { kind?: string; status?: string };
      stages?: Array<{ stage?: string }>;
      revocations?: Array<{ connectionKind?: string; status?: string }>;
      commerceCancellation?: { status?: string; refundStarted?: boolean };
    };
  };
  const expectedRevocations = ["ai:openai", "calendar", "mail"] as const;
  if (
    closureResponse.status !== 200 ||
    closureBody.deletion?.request?.kind !== "account_closure" ||
    closureBody.deletion.request.status !== "access_stopped" ||
    !closureBody.deletion.stages?.some((stage) => stage.stage === "requested") ||
    closureBody.deletion.revocations?.length !== expectedRevocations.length ||
    expectedRevocations.some(
      (connectionKind) =>
        !closureBody.deletion?.revocations?.some(
          (revocation) =>
            revocation.connectionKind === connectionKind && revocation.status === "succeeded",
        ),
    ) ||
    closureBody.deletion.commerceCancellation?.status !== "succeeded" ||
    closureBody.deletion.commerceCancellation.refundStarted !== false
  ) {
    throw new Error("Recently reauthenticated Account Closure did not coordinate destruction.");
  }
  const closureProviderObservation = await providers.readSubscription({
    subscriptionId: `${input.input.runId}:subscription`,
  });
  if (closureProviderObservation.status !== "cancelled") {
    throw new Error("Account Closure cancellation was not visible at the provider seam.");
  }
  for (const connectionKind of expectedRevocations) {
    if (
      !deterministicFounderContractConnectionRevoked({
        runId: input.input.runId,
        userId: input.input.userId,
        connectionKind,
      })
    ) {
      throw new Error(
        `Account Closure ${connectionKind} revocation was not visible at the provider seam.`,
      );
    }
  }
  const afterClosure = await readFounderIdentitySeparationSnapshot(connection, input.input.userId);
  if (
    afterClosure.accountClosureRequests !== beforeLoss.accountClosureRequests + 1 ||
    afterClosure.deletionRequests !== beforeLoss.deletionRequests + 1
  ) {
    throw new Error("Account Closure did not create its distinct deletion authority.");
  }

  return {
    action: input.input.action,
    status: "passed",
    observedAt: input.input.now.toISOString(),
    providerCalls: providers.calls(),
    cleanup: {
      resourcesBefore: 0,
      resourcesAfter: 0,
      verified: true,
      observedAt: closureAt.toISOString(),
    },
    identityRecovery: {
      lostIdentityDenied: true,
      takeoverDenied: true,
      recoveredSameOwner: true,
      accountClosureCoordinated: true,
      commerceChangedByIdentityLoss: false,
      productEntitlementChangedByIdentityLoss: false,
      refundStartedByIdentityLoss: false,
      retirementStartedByIdentityLoss: false,
      archiveDeletionStartedByIdentityLoss: false,
      accountClosureStartedByIdentityLoss: false,
      receiptKinds: [
        "identity_loss_recorded",
        "recovery_denied",
        "identity_rebound",
        "account_closure_requested",
      ],
    },
  };
}

function lifecycleErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Lifecycle transition failed.";
  const cause = error.cause;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
}

function deterministicBoundaryAvailable(): boolean {
  return (
    process.env.BRUNO_AUTH_MODE === "development" &&
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE === "deterministic"
  );
}

function localContractBaseUrl(request: Request): string {
  const requestUrl = new URL(request.url);
  const configuredUrl = new URL(process.env.NEXT_PUBLIC_APP_URL ?? "invalid:");
  if (!isLoopbackHostname(requestUrl.hostname) || !isLoopbackHostname(configuredUrl.hostname)) {
    throw new Error("Founder Product Contract public HTTP boundary must remain on loopback.");
  }
  return requestUrl.origin;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function contractIdentity(): {
  sourceRevision: string;
  runtimeRevision: string;
  runId: string;
  observedAt: string;
} | null {
  const sourceRevision =
    process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const runtimeRevision = process.env.BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION ?? "";
  const runId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "";
  const observedAt = process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT ?? "";
  if (
    !/^[a-f0-9]{40}$/.test(sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(runtimeRevision) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(runId) ||
    Number.isNaN(new Date(observedAt).valueOf()) ||
    new Date(observedAt).toISOString() !== observedAt
  ) {
    return null;
  }
  return { sourceRevision, runtimeRevision, runId, observedAt };
}

async function readBody(request: Request): Promise<{
  action: FounderProductContractLifecycleAction;
  runId: string;
  now: string;
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
  providerSubscriptionStatus: FounderCommerceStatus;
  providerFailures: readonly FounderLifecycleFailureOperation[];
} | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    if (
      typeof value.action !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.now !== "string" ||
      Number.isNaN(new Date(value.now).valueOf()) ||
      (value.providerSubscriptionStatus !== undefined &&
        (typeof value.providerSubscriptionStatus !== "string" ||
          !COMMERCE_STATUSES.has(value.providerSubscriptionStatus as FounderCommerceStatus))) ||
      (value.providerFailure !== undefined &&
        (typeof value.providerFailure !== "string" ||
          !FAILURE_OPERATIONS.has(value.providerFailure as FounderLifecycleFailureOperation))) ||
      (value.providerFailures !== undefined &&
        (!Array.isArray(value.providerFailures) ||
          !value.providerFailures.every(
            (operation) =>
              typeof operation === "string" &&
              FAILURE_OPERATIONS.has(operation as FounderLifecycleFailureOperation),
          )))
    ) {
      return null;
    }
    const commerceEvent = isCommerceEvent(value.commerceEvent) ? value.commerceEvent : undefined;
    const externalBetaContract = readExternalBetaContract(value.externalBetaContract);
    const restorationContract = readRestorationContract(value.restorationContract);
    if (value.action === "product_entitlement_lifecycle" && !commerceEvent) return null;
    if (value.action === "infrastructure_retirement" && !commerceEvent) return null;
    if (value.action === "external_beta_cohort_lifecycle" && !externalBetaContract) return null;
    if (value.action === "recovery_archive_lifecycle" && !restorationContract) return null;
    return {
      action: value.action as FounderProductContractLifecycleAction,
      runId: value.runId,
      now: value.now,
      ...(commerceEvent ? { commerceEvent } : {}),
      ...(externalBetaContract ? { externalBetaContract } : {}),
      ...(restorationContract ? { restorationContract } : {}),
      providerSubscriptionStatus:
        (value.providerSubscriptionStatus as FounderCommerceStatus | undefined) ?? "active",
      providerFailures: [
        ...((value.providerFailures as FounderLifecycleFailureOperation[] | undefined) ?? []),
        ...((value.providerFailure as FounderLifecycleFailureOperation | undefined)
          ? [value.providerFailure as FounderLifecycleFailureOperation]
          : []),
      ],
    };
  } catch {
    return null;
  }
}

function readRestorationContract(value: unknown): {
  successUserId: string;
  successSourceEventId: string;
  partialFailureUserId: string;
  partialFailureSourceEventId: string;
  deletedArchiveUserId: string;
  deletedArchiveSourceEventId: string;
  expiredArchiveUserId: string;
  expiredArchiveSourceEventId: string;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const fields = [
    "successUserId",
    "successSourceEventId",
    "partialFailureUserId",
    "partialFailureSourceEventId",
    "deletedArchiveUserId",
    "deletedArchiveSourceEventId",
    "expiredArchiveUserId",
    "expiredArchiveSourceEventId",
  ] as const;
  if (
    fields.some(
      (field) =>
        typeof record[field] !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          record[field] as string,
        ),
    )
  ) {
    return null;
  }
  return Object.fromEntries(fields.map((field) => [field, record[field]])) as {
    successUserId: string;
    successSourceEventId: string;
    partialFailureUserId: string;
    partialFailureSourceEventId: string;
    deletedArchiveUserId: string;
    deletedArchiveSourceEventId: string;
    expiredArchiveUserId: string;
    expiredArchiveSourceEventId: string;
  };
}

function readExternalBetaContract(value: unknown): {
  cohortOwnerUserId: string;
  participantUserId: string;
  invitedClerkSubject: string;
} | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("cohortOwnerUserId" in value) ||
    typeof value.cohortOwnerUserId !== "string" ||
    !("participantUserId" in value) ||
    typeof value.participantUserId !== "string" ||
    !("invitedClerkSubject" in value) ||
    typeof value.invitedClerkSubject !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.cohortOwnerUserId,
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.participantUserId,
    ) ||
    !/^clerk:[0-9a-f-]{36}$/i.test(value.invitedClerkSubject)
  ) {
    return null;
  }
  return {
    cohortOwnerUserId: value.cohortOwnerUserId,
    participantUserId: value.participantUserId,
    invitedClerkSubject: value.invitedClerkSubject,
  };
}

function isCommerceEvent(value: unknown): value is FounderCommerceEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "eventId" in value &&
    typeof value.eventId === "string" &&
    "checkoutCorrelation" in value &&
    typeof value.checkoutCorrelation === "string" &&
    "subscriptionId" in value &&
    typeof value.subscriptionId === "string" &&
    "status" in value &&
    typeof value.status === "string" &&
    COMMERCE_STATUSES.has(value.status as FounderCommerceStatus) &&
    "endsAt" in value &&
    (value.endsAt === null ||
      (typeof value.endsAt === "string" && !Number.isNaN(new Date(value.endsAt).valueOf()))) &&
    "occurredAt" in value &&
    typeof value.occurredAt === "string" &&
    !Number.isNaN(new Date(value.occurredAt).valueOf()) &&
    "signature" in value &&
    typeof value.signature === "string"
  );
}
