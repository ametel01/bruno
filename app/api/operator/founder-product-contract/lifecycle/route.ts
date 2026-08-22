import {
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
  executeFounderProductContractLifecycleAction,
  type FounderCommerceEvent,
  type FounderCommerceStatus,
  type FounderProductContractLifecycleAction,
} from "@/src/server/founder-product-contract/lifecycle";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

const ACTIONS = new Set<FounderProductContractLifecycleAction>([
  "release_stage_admission",
  "product_entitlement_lifecycle",
  "recovery_archive_lifecycle",
  "infrastructure_retirement",
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

  const now = new Date(body.now);
  const providers = deterministicFounderLifecycleProviders({
    runId: body.runId,
    userId: applicationUser.userId,
    now,
    failures: body.providerFailures,
    subscriptionStatus: body.providerSubscriptionStatus,
  });
  const evidenceIdentity = {
    runId: identity.runId,
    userId: applicationUser.userId,
    sourceRevision: identity.sourceRevision,
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
      },
      { providers, commerceWebhookSecret, applicationRevision: identity.sourceRevision },
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
          message: error instanceof Error ? error.message : "Lifecycle transition failed.",
        },
      },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}

function deterministicBoundaryAvailable(): boolean {
  return (
    process.env.BRUNO_AUTH_MODE === "development" &&
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE === "deterministic"
  );
}

function contractIdentity(): {
  sourceRevision: string;
  runId: string;
  observedAt: string;
} | null {
  const sourceRevision =
    process.env.BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "";
  const runId = process.env.BRUNO_FOUNDER_CONTRACT_RUN_ID ?? "";
  const observedAt = process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT ?? "";
  if (
    !/^[a-f0-9]{40}$/.test(sourceRevision) ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(runId) ||
    Number.isNaN(new Date(observedAt).valueOf()) ||
    new Date(observedAt).toISOString() !== observedAt
  ) {
    return null;
  }
  return { sourceRevision, runId, observedAt };
}

async function readBody(request: Request): Promise<{
  action: FounderProductContractLifecycleAction;
  runId: string;
  now: string;
  commerceEvent?: FounderCommerceEvent;
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
    if (value.action === "product_entitlement_lifecycle" && !commerceEvent) return null;
    if (value.action === "infrastructure_retirement" && !commerceEvent) return null;
    return {
      action: value.action as FounderProductContractLifecycleAction,
      runId: value.runId,
      now: value.now,
      ...(commerceEvent ? { commerceEvent } : {}),
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
