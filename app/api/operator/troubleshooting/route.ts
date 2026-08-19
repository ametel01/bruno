import {
  approveFounderTroubleshootingCaseForUser,
  closeFounderTroubleshootingCaseForUser,
  getFounderTroubleshootingForUser,
  FounderTroubleshootingError,
} from "@/src/server/operators/founder-troubleshooting";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { isFounderRecoveryCapability } from "@/src/server/operators/founder-recovery";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type TroubleshootingRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getTroubleshooting?: typeof getFounderTroubleshootingForUser;
  approveCase?: typeof approveFounderTroubleshootingCaseForUser;
  closeCase?: typeof closeFounderTroubleshootingCaseForUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: TroubleshootingRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const requested = new URL(request.url).searchParams.get("capability");
  const capability = isFounderRecoveryCapability(requested) ? requested : null;
  const troubleshooting = await (
    dependencies.getTroubleshooting ?? getFounderTroubleshootingForUser
  )(user.userId, capability);
  return Response.json({ troubleshooting }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: TroubleshootingRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return validationResponse("Choose a Troubleshooting action.");
  }
  if (payload.action !== "approve_case" && payload.action !== "close_case") {
    return validationResponse("Choose a supported Troubleshooting action.");
  }
  if (typeof payload.incidentId !== "string" || !payload.incidentId.trim()) {
    return validationResponse("A Troubleshooting Incident is required.");
  }
  const recentAuth = await (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(currentRequest, "/api/operator/troubleshooting"))
  )(request);
  if (!recentAuth) return recentAuthenticationResponse();

  try {
    const incident =
      payload.action === "approve_case"
        ? await (dependencies.approveCase ?? approveFounderTroubleshootingCaseForUser)(
            user.userId,
            payload.incidentId.trim(),
          )
        : await (dependencies.closeCase ?? closeFounderTroubleshootingCaseForUser)(
            user.userId,
            payload.incidentId.trim(),
          );
    return Response.json({ incident }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderTroubleshootingError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
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

function recentAuthenticationResponse(): Response {
  return Response.json(
    {
      error: {
        code: "recent_authentication_required",
        message: "Sign in again before attaching or closing a Troubleshooting Incident.",
      },
    },
    { status: 401, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
