import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  confirmFounderProcessingConsentForUser,
  FounderLimitedOperationError,
  getFounderLimitedOperationForUser,
  openFounderMorningBriefForUser,
} from "@/src/server/operators/founder-limited-operation";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type LimitedOperationRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getOperation?: typeof getFounderLimitedOperationForUser;
  confirmConsent?: typeof confirmFounderProcessingConsentForUser;
  openBrief?: typeof openFounderMorningBriefForUser;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: LimitedOperationRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    "workspace",
  );
  if (accessFailure) return accessFailure;
  const operation = await (dependencies.getOperation ?? getFounderLimitedOperationForUser)(
    applicationUser.userId,
  );
  return Response.json({ operation }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: LimitedOperationRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarLimitedOperation,
  );
  if (accessFailure) return accessFailure;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  const action = isRecord(payload) && payload.action;
  try {
    if (action === "confirm_consent") {
      const operation = await (
        dependencies.confirmConsent ?? confirmFounderProcessingConsentForUser
      )(applicationUser.userId);
      return Response.json({ operation }, { headers: noStoreHeaders() });
    }
    if (action === "open_brief") {
      const operation = await (dependencies.openBrief ?? openFounderMorningBriefForUser)(
        applicationUser.userId,
      );
      return Response.json({ operation }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    if (error instanceof FounderLimitedOperationError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
  return validationResponse("Choose a supported Limited Operation action.");
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
