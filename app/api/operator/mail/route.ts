import {
  disconnectFounderGoogleMailForUser,
  FounderMailConnectionError,
} from "@/src/server/operators/founder-mail-connection";
import type {
  getFounderGoogleMailConnectionForUser,
  getFounderGoogleMailOfferDispositionForUser,
  selectFounderGoogleMailResourcesForUser,
  setFounderGoogleMailOfferDispositionForUser,
  startFounderGoogleMailAuthorizationForUser,
  verifyFounderGoogleMailForUser,
} from "@/src/server/operators/founder-mail-connection";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type MailRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getConnection?: typeof getFounderGoogleMailConnectionForUser;
  getOfferDisposition?: typeof getFounderGoogleMailOfferDispositionForUser;
  setOfferDisposition?: typeof setFounderGoogleMailOfferDispositionForUser;
  startAuthorization?: typeof startFounderGoogleMailAuthorizationForUser;
  selectResources?: typeof selectFounderGoogleMailResourcesForUser;
  verifyConnection?: typeof verifyFounderGoogleMailForUser;
  disconnectConnection?: typeof disconnectFounderGoogleMailForUser;
  isMailReadingReleased?: () => boolean;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: MailRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  return ownerPreviewUnavailableResponse();
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: MailRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }

  const action = readAction(payload);
  if (action !== "disconnect") return ownerPreviewUnavailableResponse();
  try {
    const connection = await (
      dependencies.disconnectConnection ?? disconnectFounderGoogleMailForUser
    )(applicationUser.userId);
    return Response.json({ connection }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderMailConnectionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function readAction(
  payload: unknown,
): "start" | "offer" | "select" | "verify" | "disconnect" | null {
  if (!isRecord(payload) || !("action" in payload)) return null;
  const action = payload.action;
  return action === "start" ||
    action === "offer" ||
    action === "select" ||
    action === "verify" ||
    action === "disconnect"
    ? action
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function authenticationResponse(status: 401 | 503): Response {
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

function validationResponse(message: string): Response {
  return Response.json(
    { error: { code: "validation_failed", message } },
    { status: 400, headers: noStoreHeaders() },
  );
}

function ownerPreviewUnavailableResponse(): Response {
  return Response.json(
    {
      error: {
        code: "owner_preview_capability_unavailable",
        message: "Gmail reading is unavailable during Owner Preview.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
