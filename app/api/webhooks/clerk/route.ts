import { verifyWebhook } from "@clerk/nextjs/webhooks";
import type { NextRequest } from "next/server";
import { recordFounderIdentityLoss } from "@/src/server/users/founder-identity-recovery";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  verify?: typeof verifyWebhook;
  recordLoss?: typeof recordFounderIdentityLoss;
  now?: () => Date;
};

export async function POST(
  request: NextRequest,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  if (new URL(request.url).search.length > 0) {
    return errorResponse(400, "identity_webhook_request_invalid");
  }

  let event: Awaited<ReturnType<typeof verifyWebhook>>;
  try {
    event = await (dependencies.verify ?? verifyWebhook)(request);
  } catch {
    return errorResponse(401, "identity_webhook_signature_invalid");
  }

  if (event.type !== "user.deleted") {
    return acceptedResponse();
  }
  const clerkUserId = event.data.id;
  const providerEventId = request.headers.get("svix-id")?.trim();
  if (!clerkUserId || !providerEventId) {
    return errorResponse(400, "identity_webhook_event_invalid");
  }

  try {
    await (dependencies.recordLoss ?? recordFounderIdentityLoss)({
      clerkUserId,
      providerEventId,
      reason: "clerk_user_deleted",
      observedAt: dependencies.now?.() ?? new Date(),
    });
    return acceptedResponse();
  } catch {
    return errorResponse(409, "identity_webhook_delivery_rejected");
  }
}

function acceptedResponse(): Response {
  return Response.json(
    { ok: true, accepted: true },
    { status: 202, headers: { "Cache-Control": "no-store" } },
  );
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Identity provider delivery was rejected safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
