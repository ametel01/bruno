import {
  createFounderHermesSetupSessionForUser,
  type FounderHermesSetupDependencies,
  FounderHermesSetupError,
} from "@/src/server/operators/founder-hermes-setup";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { getFounderTroubleshootingForUser } from "@/src/server/operators/founder-troubleshooting";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type RouteDependencies = FounderHermesSetupDependencies & {
  getTroubleshooting?: typeof getFounderTroubleshootingForUser;
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
) {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);

  const recentlyAuthenticated = await (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(
        currentRequest,
        "/api/operator/troubleshooting/hermes-setup-session",
      ))
  )(request);
  if (!recentlyAuthenticated) return recentAuthenticationResponse();

  const viewportWidth = parseViewportWidth(request.headers.get("x-bruno-viewport-width"));
  const mobileHint = request.headers.get("sec-ch-ua-mobile")?.trim();
  if (viewportWidth === null || viewportWidth < 1024 || mobileHint === "?1") {
    return errorResponse(
      400,
      "desktop_viewport_required",
      "Full Hermes Setup is available only from a desktop-sized window.",
    );
  }

  try {
    const troubleshooting = await (
      dependencies.getTroubleshooting ?? getFounderTroubleshootingForUser
    )(user.userId);
    if (!troubleshooting.help.technicalEvidenceAvailable || !troubleshooting.help.incidentId) {
      return errorResponse(
        409,
        "troubleshooting_required",
        "Full Hermes Setup opens only from an exhausted Troubleshooting Incident.",
      );
    }
    const session = await createFounderHermesSetupSessionForUser(user.userId, dependencies);
    return Response.json({ ok: true, session }, { status: 201, headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderHermesSetupError) {
      return errorResponse(error.status, error.code, error.message);
    }
    throw error;
  }
}

function parseViewportWidth(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value.trim())) return null;
  const width = Number(value);
  return Number.isSafeInteger(width) ? width : null;
}

function authenticationResponse(status: 401 | 503): Response {
  return errorResponse(
    status,
    status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
    status === 401 ? "Authentication is required." : "Authentication is not configured safely.",
  );
}

function recentAuthenticationResponse(): Response {
  return errorResponse(
    401,
    "recent_authentication_required",
    "Sign in again before opening Full Hermes Setup.",
  );
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
