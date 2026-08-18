import {
  confirmFounderCoreProcessingConsentForUser,
  FounderCoreOperationError,
  type getFounderCoreOperationForUser,
  openFounderCoreBriefForUser,
  reconcileFounderCoreOperationForUser,
} from "@/src/server/operators/founder-core-operation";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getOperation?: typeof getFounderCoreOperationForUser;
  reconcileOperation?: typeof reconcileFounderCoreOperationForUser;
  confirmConsent?: typeof confirmFounderCoreProcessingConsentForUser;
  openBrief?: typeof openFounderCoreBriefForUser;
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
  const operation = await (
    dependencies.reconcileOperation ??
    dependencies.getOperation ??
    reconcileFounderCoreOperationForUser
  )(applicationUser.userId);
  return Response.json({ operation }, { headers: noStoreHeaders() });
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
        dependencies.confirmConsent ?? confirmFounderCoreProcessingConsentForUser
      )(applicationUser.userId);
      return Response.json({ operation }, { headers: noStoreHeaders() });
    }
    if (action === "open_brief") {
      const operation = await (dependencies.openBrief ?? openFounderCoreBriefForUser)(
        applicationUser.userId,
      );
      return Response.json({ operation }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    if (error instanceof FounderCoreOperationError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
  return validationResponse("Choose a supported Core Operation action.");
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
