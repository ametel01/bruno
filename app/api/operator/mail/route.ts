import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import { hasFounderGeneralReleaseSetupAccessForUser } from "@/src/server/founder-product-contract/initial-general-release";
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
import { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-google-reading-release";
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
  hasGeneralReleaseSetupAccess?: typeof hasFounderGeneralReleaseSetupAccessForUser;
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
  if (
    !(await (
      dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser
    )(applicationUser.userId))
  ) {
    return ownerPreviewUnavailableResponse();
  }
  const accessError = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
    { allowGeneralReleaseSetup: true },
  );
  if (accessError) return accessError;
  if (!(dependencies.isMailReadingReleased ?? isFounderGoogleMailReadingReleased)()) {
    return providerNotReleasedResponse();
  }
  const [connection, disposition] = await Promise.all([
    (dependencies.getConnection ?? getFounderGoogleMailConnectionForUser)(applicationUser.userId),
    (dependencies.getOfferDisposition ?? getFounderGoogleMailOfferDispositionForUser)(
      applicationUser.userId,
    ),
  ]);
  return Response.json({ connection, disposition }, { headers: noStoreHeaders() });
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
    if (action !== "disconnect") {
      if (
        !(await (
          dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser
        )(applicationUser.userId))
      ) {
        return ownerPreviewUnavailableResponse();
      }
      const accessError = await requireFounderOperatorWorkspaceAccess(
        applicationUser.userId,
        FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden,
        { allowGeneralReleaseSetup: true },
      );
      if (accessError) return accessError;
      if (!(dependencies.isMailReadingReleased ?? isFounderGoogleMailReadingReleased)()) {
        return providerNotReleasedResponse();
      }
    }
    if (action === "offer") {
      const disposition = await (
        dependencies.setOfferDisposition ?? setFounderGoogleMailOfferDispositionForUser
      )(applicationUser.userId, readDisposition(payload));
      return Response.json({ disposition }, { headers: noStoreHeaders() });
    }
    if (action === "start") {
      const result = await (
        dependencies.startAuthorization ?? startFounderGoogleMailAuthorizationForUser
      )(applicationUser.userId);
      return Response.json(result, { headers: noStoreHeaders() });
    }
    if (action === "select") {
      const resourceIds = readResourceIds(payload);
      if (!resourceIds) return validationResponse("Choose at least one mailbox.");
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
    if (action !== "disconnect") return validationResponse("Choose a supported Mail action.");
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

function readDisposition(payload: unknown): "enabled" | "dismissed" {
  return isRecord(payload) && payload.disposition === "dismissed" ? "dismissed" : "enabled";
}

function readResourceIds(payload: unknown): string[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.resourceIds)) return null;
  const values = payload.resourceIds.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return values.length > 0 && values.length === payload.resourceIds.length ? values : null;
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
        code: "provider_not_released",
        message: "Gmail reading is unavailable until current Connected Acceptance passes.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
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
