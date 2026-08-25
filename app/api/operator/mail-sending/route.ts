import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import { hasFounderGeneralReleaseSetupAccessForUser } from "@/src/server/founder-product-contract/initial-general-release";
import {
  disconnectFounderGoogleMailSendingForUser,
  FounderMailSendingConnectionError,
  getFounderGoogleMailSendingConnectionForUser,
  getFounderGoogleMailSendingOfferForUser,
  isFounderGoogleMailSendingReleased,
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
  hasGeneralReleaseSetupAccess?: typeof hasFounderGeneralReleaseSetupAccessForUser;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, _context?: unknown, dependencies: Dependencies = {}) {
  const user = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!user.ok) return authenticationResponse(user.status);
  const accessError = await requireMailSendingSetupAccess(user.userId, dependencies);
  if (accessError) return accessError;
  if (!(dependencies.isMailSendingReleased ?? isFounderGoogleMailSendingReleased)()) {
    return providerNotReleasedResponse();
  }
  const [connection, offerAvailable] = await Promise.all([
    (dependencies.getConnection ?? getFounderGoogleMailSendingConnectionForUser)(user.userId),
    (dependencies.getOffer ?? getFounderGoogleMailSendingOfferForUser)(user.userId),
  ]);
  return Response.json({ connection, offerAvailable }, { headers: noStoreHeaders() });
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
  try {
    if (action !== "disconnect") {
      const accessError = await requireMailSendingSetupAccess(user.userId, dependencies);
      if (accessError) return accessError;
      if (!(dependencies.isMailSendingReleased ?? isFounderGoogleMailSendingReleased)()) {
        return providerNotReleasedResponse();
      }
    }
    if (action === "start") {
      return Response.json(
        await (
          dependencies.startAuthorization ?? startFounderGoogleMailSendingAuthorizationForUser
        )(user.userId),
        { headers: noStoreHeaders() },
      );
    }
    if (action === "verify") {
      return Response.json(
        {
          connection: await (
            dependencies.verifyConnection ?? verifyFounderGoogleMailSendingForUser
          )(user.userId),
        },
        { headers: noStoreHeaders() },
      );
    }
    if (action !== "disconnect") {
      return validationResponse("Choose a supported Mail Sending action.");
    }
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

async function requireMailSendingSetupAccess(
  userId: string,
  dependencies: Dependencies,
): Promise<Response | null> {
  const hasSetupAccess =
    dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser;
  if (!(await hasSetupAccess(userId, {}, ["gmail_sending"]))) {
    return ownerPreviewUnavailableResponse();
  }
  return requireFounderOperatorWorkspaceAccess(userId, ["gmail_sending"], {
    allowGeneralReleaseSetup: true,
    ...(dependencies.hasGeneralReleaseSetupAccess
      ? { hasGeneralReleaseSetupAccess: dependencies.hasGeneralReleaseSetupAccess }
      : {}),
  });
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
function providerNotReleasedResponse() {
  return Response.json(
    {
      error: {
        code: "mail_sending_not_released",
        message: "Gmail sending is unavailable until current Connected Acceptance passes.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}
function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
