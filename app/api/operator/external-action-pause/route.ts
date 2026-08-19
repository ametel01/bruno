import {
  FounderExternalActionPauseError,
  getFounderExternalActionPauseForUser,
  setFounderExternalActionPauseForUser,
} from "@/src/server/operators/founder-ai-work";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getPause?: typeof getFounderExternalActionPauseForUser;
  setPause?: typeof setFounderExternalActionPauseForUser;
};

export const dynamic = "force-dynamic";

export async function GET(_request: Request, _context?: unknown, dependencies: Dependencies = {}) {
  const user = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!user.ok) return authenticationResponse(user.status);
  const pause = await (dependencies.getPause ?? getFounderExternalActionPauseForUser)(user.userId);
  return Response.json({ pause }, { headers: noStoreHeaders() });
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
  if (!isRecord(payload) || typeof payload.paused !== "boolean")
    return validationResponse("Choose whether External Action Pause is enabled.");
  try {
    const pause = await (dependencies.setPause ?? setFounderExternalActionPauseForUser)(
      user.userId,
      payload.paused,
      typeof payload.reason === "string" ? { reason: payload.reason } : {},
    );
    return Response.json({ pause }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderExternalActionPauseError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    throw error;
  }
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
function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
