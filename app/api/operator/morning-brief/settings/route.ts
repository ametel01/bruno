import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import {
  getFounderMorningBriefPreferencesForUser,
  updateFounderMorningBriefPreferencesForUser,
} from "@/src/server/operators/founder-morning-brief";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getPreferences?: typeof getFounderMorningBriefPreferencesForUser;
  updatePreferences?: typeof updateFounderMorningBriefPreferencesForUser;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    "workspace",
    { allowGeneralReleaseSetup: true },
  );
  if (accessFailure) return accessFailure;
  const preferences = await (
    dependencies.getPreferences ?? getFounderMorningBriefPreferencesForUser
  )(applicationUser.userId);
  return Response.json({ preferences }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    "workspace",
    { allowGeneralReleaseSetup: true },
  );
  if (accessFailure) return accessFailure;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  const deliveryLocalTime =
    isRecord(payload) && typeof payload.deliveryLocalTime === "string"
      ? payload.deliveryLocalTime
      : null;
  if (!deliveryLocalTime) return validationResponse("Choose a delivery time.");
  try {
    const preferences = await (
      dependencies.updatePreferences ?? updateFounderMorningBriefPreferencesForUser
    )(applicationUser.userId, deliveryLocalTime);
    return Response.json({ preferences }, { headers: noStoreHeaders() });
  } catch (error) {
    const accessResponse = founderOperatorAccessErrorResponse(error);
    if (accessResponse) return accessResponse;
    return validationResponse(
      error instanceof Error ? error.message : "Could not save delivery time.",
    );
  }
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

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
