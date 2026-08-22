import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  disconnectFounderGoogleCalendarForUser,
  FounderCalendarConnectionError,
  getFounderGoogleCalendarConnectionForUser,
  selectFounderGoogleCalendarResourcesForUser,
  startFounderGoogleCalendarAuthorizationForUser,
  verifyFounderGoogleCalendarForUser,
} from "@/src/server/operators/founder-calendar-connection";
import { isFounderGoogleCalendarReleased } from "@/src/server/operators/founder-google-reading-release";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type CalendarRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getConnection?: typeof getFounderGoogleCalendarConnectionForUser;
  startAuthorization?: typeof startFounderGoogleCalendarAuthorizationForUser;
  selectResources?: typeof selectFounderGoogleCalendarResourcesForUser;
  verifyConnection?: typeof verifyFounderGoogleCalendarForUser;
  disconnectConnection?: typeof disconnectFounderGoogleCalendarForUser;
  isCalendarReleased?: () => boolean;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: CalendarRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessError = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarRelationshipEvidence,
  );
  if (accessError) return accessError;
  if (!(dependencies.isCalendarReleased ?? isFounderGoogleCalendarReleased)()) {
    return providerNotReleasedResponse();
  }

  const connection = await (
    dependencies.getConnection ?? getFounderGoogleCalendarConnectionForUser
  )(applicationUser.userId);
  return Response.json({ connection }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: CalendarRouteDependencies = {},
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
      const accessError = await requireFounderOperatorWorkspaceAccess(
        applicationUser.userId,
        FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarRelationshipEvidence,
      );
      if (accessError) return accessError;
    }
    if (
      action !== "disconnect" &&
      !(dependencies.isCalendarReleased ?? isFounderGoogleCalendarReleased)()
    ) {
      return providerNotReleasedResponse();
    }
    if (action === "start") {
      const result = await (
        dependencies.startAuthorization ?? startFounderGoogleCalendarAuthorizationForUser
      )(applicationUser.userId);
      return Response.json(result, { headers: noStoreHeaders() });
    }
    if (action === "select") {
      const resourceIds = readResourceIds(payload);
      if (!resourceIds) return validationResponse("Choose at least one calendar.");
      const connection = await (
        dependencies.selectResources ?? selectFounderGoogleCalendarResourcesForUser
      )(applicationUser.userId, resourceIds);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "verify") {
      const connection = await (
        dependencies.verifyConnection ?? verifyFounderGoogleCalendarForUser
      )(applicationUser.userId);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "disconnect") {
      const connection = await (
        dependencies.disconnectConnection ?? disconnectFounderGoogleCalendarForUser
      )(applicationUser.userId);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    if (error instanceof FounderCalendarConnectionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }

  return validationResponse("Choose a supported Google Calendar action.");
}

function readAction(payload: unknown): "start" | "select" | "verify" | "disconnect" | null {
  if (!isRecord(payload) || !("action" in payload)) return null;
  const action = payload.action;
  return action === "start" || action === "select" || action === "verify" || action === "disconnect"
    ? action
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
        code: "calendar_reading_not_released",
        message: "Google Calendar reading is not available in this Bruno release.",
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
