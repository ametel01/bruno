import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import {
  changeFounderAuthorityPolicyForUser,
  FounderProposedActionError,
  FOUNDER_ACTION_FAMILIES,
  type FounderActionFamily,
  type FounderAuthorityMode,
} from "@/src/server/operators/founder-proposed-actions";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  changePolicy?: typeof changeFounderAuthorityPolicyForUser;
};

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
  if (!isRecord(payload) || payload.action !== "change" || !isRecord(payload.actionFamilies)) {
    return validationResponse("A structured Authority Policy change is required.");
  }
  const actionFamilies = readActionFamilies(payload.actionFamilies);
  if (!actionFamilies) {
    return validationResponse("Provide an explicit mode for every Action Family.");
  }
  try {
    const policy = await (dependencies.changePolicy ?? changeFounderAuthorityPolicyForUser)(
      applicationUser.userId,
      actionFamilies,
    );
    return Response.json({ policy }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderProposedActionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function readActionFamilies(
  value: Record<string, unknown>,
): Record<FounderActionFamily, FounderAuthorityMode> | null {
  const result = {} as Record<FounderActionFamily, FounderAuthorityMode>;
  for (const family of FOUNDER_ACTION_FAMILIES) {
    const mode = value[family];
    if (mode !== "always" && mode !== "approval_required" && mode !== "never") return null;
    result[family] = mode;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
