import { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-google-reading-release";
import {
  disconnectFounderGoogleMailForUser,
  FounderMailConnectionError,
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
  if (!(dependencies.isMailReadingReleased ?? isFounderGoogleMailReadingReleased)()) {
    return providerNotReleasedResponse();
  }

  const connection = await (dependencies.getConnection ?? getFounderGoogleMailConnectionForUser)(
    applicationUser.userId,
  );
  const offerDisposition = await (
    dependencies.getOfferDisposition ?? getFounderGoogleMailOfferDispositionForUser
  )(applicationUser.userId);
  return Response.json({ connection, offerDisposition }, { headers: noStoreHeaders() });
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
  try {
    if (
      action !== "disconnect" &&
      !(dependencies.isMailReadingReleased ?? isFounderGoogleMailReadingReleased)()
    ) {
      return providerNotReleasedResponse();
    }
    if (action === "start") {
      const result = await (
        dependencies.startAuthorization ?? startFounderGoogleMailAuthorizationForUser
      )(applicationUser.userId);
      return Response.json(result, { headers: noStoreHeaders() });
    }
    if (action === "offer") {
      const disposition = readOfferDisposition(payload);
      if (!disposition) return validationResponse("Choose whether to review Gmail reading now.");
      const offerDisposition = await (
        dependencies.setOfferDisposition ?? setFounderGoogleMailOfferDispositionForUser
      )(applicationUser.userId, disposition);
      return Response.json({ connection: null, offerDisposition }, { headers: noStoreHeaders() });
    }
    if (action === "select") {
      const resourceIds = readResourceIds(payload);
      if (!resourceIds) return validationResponse("Choose at least one Gmail label.");
      const connection = await (
        dependencies.selectResources ?? selectFounderGoogleMailResourcesForUser
      )(applicationUser.userId, resourceIds);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "verify") {
      const connection = await (dependencies.verifyConnection ?? verifyFounderGoogleMailForUser)(
        applicationUser.userId,
      );
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "disconnect") {
      const connection = await (
        dependencies.disconnectConnection ?? disconnectFounderGoogleMailForUser
      )(applicationUser.userId);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    if (error instanceof FounderMailConnectionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }

  return validationResponse("Choose a supported Gmail reading action.");
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

function readOfferDisposition(payload: unknown): "enabled" | "dismissed" | null {
  if (!isRecord(payload)) return null;
  return payload.disposition === "enabled" || payload.disposition === "dismissed"
    ? payload.disposition
    : null;
}

function readResourceIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.resourceIds)) return null;
  const ids = payload.resourceIds.filter((value): value is string => typeof value === "string");
  return ids.length > 0 ? ids : null;
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

function providerNotReleasedResponse(): Response {
  return Response.json(
    {
      error: {
        code: "mail_reading_not_released",
        message: "Gmail reading is not available in this Bruno release.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
