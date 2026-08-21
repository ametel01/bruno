import { createHmac, timingSafeEqual } from "node:crypto";
import {
  applyFounderProductContractLifecycleAction,
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

export async function POST(request: Request): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return Response.json({ error: { code: "authentication_required" } }, { status: 401 });
  }

  const body = await readBody(request);
  if (!body || !ACTIONS.has(body.action)) {
    return Response.json({ error: { code: "invalid_lifecycle_action" } }, { status: 400 });
  }
  if (!/^[a-f0-9]{40}$/.test(body.sourceRevision) || !/^[A-Za-z0-9._:-]{1,128}$/.test(body.runId)) {
    return Response.json({ error: { code: "invalid_lifecycle_identity" } }, { status: 400 });
  }

  if (body.action === "product_entitlement_lifecycle") {
    const secret =
      process.env.BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET ??
      (process.env.BRUNO_AUTH_MODE === "development" ? "founder-contract-development-secret" : "");
    if (!secret || !body.commerceEvent || !verifyCommerceEvent(body.commerceEvent, secret)) {
      return Response.json({ error: { code: "invalid_commerce_event" } }, { status: 400 });
    }
  }

  if (
    process.env.BRUNO_AUTH_MODE !== "development" &&
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE !== "deterministic"
  ) {
    return Response.json({ error: { code: "provider_boundary_unavailable" } }, { status: 503 });
  }

  const calls: string[] = [];
  const provider = async (name: string) => {
    calls.push(name);
  };
  try {
    const state = await applyFounderProductContractLifecycleAction({
      action: body.action,
      runId: body.runId,
      sourceRevision: body.sourceRevision,
      userId: applicationUser.userId,
      now: new Date(body.now),
      providers: {
        clerkAuthenticate: () => provider("clerk.authenticate"),
        reconcileEntitlement: () => provider("lemonSqueezy.receive_webhook"),
        verifyArchive: () => provider("application.verify_recovery_archive"),
        observeResources: () => provider("digitalOcean.observe_owned_resources"),
        disableCredentials: () => provider("digitalOcean.disable_runtime_credentials"),
        deleteFirewall: () => provider("digitalOcean.delete_firewall"),
        deleteDroplet: () => provider("digitalOcean.delete_droplet"),
        verifyResourcesAbsent: () => provider("digitalOcean.observe_owned_resources_absent"),
      },
    });
    return Response.json(
      { state, providerCalls: calls },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        error: {
          code: "lifecycle_transition_failed",
          message: error instanceof Error ? error.message : "Lifecycle transition failed.",
        },
      },
      { status: 409 },
    );
  }
}

async function readBody(request: Request): Promise<{
  action: FounderProductContractLifecycleAction;
  runId: string;
  sourceRevision: string;
  now: string;
  commerceEvent?: { eventId: string; status: "active"; signature: string };
} | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    if (
      typeof value.action !== "string" ||
      typeof value.runId !== "string" ||
      typeof value.sourceRevision !== "string" ||
      typeof value.now !== "string" ||
      Number.isNaN(new Date(value.now).valueOf())
    ) {
      return null;
    }
    return {
      action: value.action as FounderProductContractLifecycleAction,
      runId: value.runId,
      sourceRevision: value.sourceRevision,
      now: value.now,
      ...(isCommerceEvent(value.commerceEvent) ? { commerceEvent: value.commerceEvent } : {}),
    };
  } catch {
    return null;
  }
}

function isCommerceEvent(value: unknown): value is {
  eventId: string;
  status: "active";
  signature: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "eventId" in value &&
    typeof value.eventId === "string" &&
    "status" in value &&
    value.status === "active" &&
    "signature" in value &&
    typeof value.signature === "string"
  );
}

function verifyCommerceEvent(
  event: { eventId: string; status: "active"; signature: string },
  secret: string,
): boolean {
  const payload = JSON.stringify({ eventId: event.eventId, status: event.status });
  const expected = `hmac-sha256:${createHmac("sha256", secret).update(payload).digest("hex")}`;
  const left = Buffer.from(event.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
