import {
  disconnectFounderGoogleMailSendingForUser,
  FounderMailSendingConnectionError,
} from "@/src/server/operators/founder-mail-sending-connection";
import type {
  getFounderGoogleMailSendingConnectionForUser,
  getFounderGoogleMailSendingOfferForUser,
  startFounderGoogleMailSendingAuthorizationForUser,
  verifyFounderGoogleMailSendingForUser,
} from "@/src/server/operators/founder-mail-sending-connection";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getConnection?: typeof getFounderGoogleMailSendingConnectionForUser;
  getOffer?: typeof getFounderGoogleMailSendingOfferForUser;
  startAuthorization?: typeof startFounderGoogleMailSendingAuthorizationForUser;
  verifyConnection?: typeof verifyFounderGoogleMailSendingForUser;
  disconnectConnection?: typeof disconnectFounderGoogleMailSendingForUser;
  isMailSendingReleased?: () => boolean;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, _context?: unknown, dependencies: Dependencies = {}) {
  const user = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!user.ok) return authenticationResponse(user.status);
  return ownerPreviewUnavailableResponse();
}

export async function POST(request: Request, _context?: unknown, dependencies: Dependencies = {}) {
  const user = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!user.ok) return authenticationResponse(user.status);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  const action = isRecord(payload) && typeof payload.action === "string" ? payload.action : null;
  if (action !== "disconnect") return ownerPreviewUnavailableResponse();
  try {
    return Response.json(
      {
        connection: await (
          dependencies.disconnectConnection ?? disconnectFounderGoogleMailSendingForUser
        )(user.userId),
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    if (error instanceof FounderMailSendingConnectionError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function authenticationResponse(status: 401 | 503) {
  return Response.json(
    {
      error: {
        code: status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
        message:
          status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status, headers: noStoreHeaders() },
  );
}
function validationResponse(message: string) {
  return Response.json(
    { error: { code: "validation_failed", message } },
    { status: 400, headers: noStoreHeaders() },
  );
}
function ownerPreviewUnavailableResponse() {
  return Response.json(
    {
      error: {
        code: "owner_preview_capability_unavailable",
        message: "Gmail sending is unavailable during Owner Preview.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}
function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
