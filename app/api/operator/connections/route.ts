import {
  disconnectFounderAnthropicForUser,
  disconnectFounderOpenAiForUser,
  FounderAiConnectionError,
  pollFounderAnthropicAuthorizationForUser,
  pollFounderOpenAiAuthorizationForUser,
  recheckFounderAnthropicConnectionForUser,
  recheckFounderOpenAiConnectionForUser,
  startFounderAnthropicAuthorizationForUser,
  startFounderOpenAiAuthorizationForUser,
} from "@/src/server/operators/founder-ai-connection";
import type { getFounderAiConnectionForUser } from "@/src/server/operators/founder-ai-connection";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type ConnectionRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getConnection?: typeof getFounderAiConnectionForUser;
  startAuthorization?: typeof startFounderOpenAiAuthorizationForUser;
  pollAuthorization?: typeof pollFounderOpenAiAuthorizationForUser;
  recheckConnection?: typeof recheckFounderOpenAiConnectionForUser;
  disconnectConnection?: typeof disconnectFounderOpenAiForUser;
  startAnthropicAuthorization?: typeof startFounderAnthropicAuthorizationForUser;
  pollAnthropicAuthorization?: typeof pollFounderAnthropicAuthorizationForUser;
  recheckAnthropicConnection?: typeof recheckFounderAnthropicConnectionForUser;
  disconnectAnthropicConnection?: typeof disconnectFounderAnthropicForUser;
};

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: ConnectionRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);

  const provider = readProvider(new URL(request.url).searchParams.get("provider"));
  const connection =
    provider === "anthropic"
      ? await (dependencies.recheckAnthropicConnection ?? recheckFounderAnthropicConnectionForUser)(
          applicationUser.userId,
        )
      : dependencies.getConnection
        ? await dependencies.getConnection(applicationUser.userId)
        : await recheckFounderOpenAiConnectionForUser(applicationUser.userId);
  return Response.json({ connection }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: ConnectionRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }

  const action = readAction(payload);
  const provider = readProvider(
    payload && typeof payload === "object" && "provider" in payload ? payload.provider : null,
  );
  try {
    if (action === "start") {
      const result =
        provider === "anthropic"
          ? await (
              dependencies.startAnthropicAuthorization ?? startFounderAnthropicAuthorizationForUser
            )(applicationUser.userId)
          : await (dependencies.startAuthorization ?? startFounderOpenAiAuthorizationForUser)(
              applicationUser.userId,
            );
      return Response.json(result, { headers: noStoreHeaders() });
    }
    if (action === "poll") {
      const sessionId = readSessionId(payload);
      if (!sessionId) return validationResponse("Authorization session is required.");
      const connection =
        provider === "anthropic"
          ? await (
              dependencies.pollAnthropicAuthorization ?? pollFounderAnthropicAuthorizationForUser
            )(applicationUser.userId, sessionId)
          : await (dependencies.pollAuthorization ?? pollFounderOpenAiAuthorizationForUser)(
              applicationUser.userId,
              sessionId,
            );
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "recheck") {
      const connection =
        provider === "anthropic"
          ? await (
              dependencies.recheckAnthropicConnection ?? recheckFounderAnthropicConnectionForUser
            )(applicationUser.userId)
          : await (dependencies.recheckConnection ?? recheckFounderOpenAiConnectionForUser)(
              applicationUser.userId,
            );
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (action === "disconnect") {
      const connection =
        provider === "anthropic"
          ? await (dependencies.disconnectAnthropicConnection ?? disconnectFounderAnthropicForUser)(
              applicationUser.userId,
            )
          : await (dependencies.disconnectConnection ?? disconnectFounderOpenAiForUser)(
              applicationUser.userId,
            );
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    if (error instanceof FounderAiConnectionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }

  return validationResponse("Choose a supported AI connection action.");
}

function readAction(payload: unknown): "start" | "poll" | "recheck" | "disconnect" | null {
  if (!payload || typeof payload !== "object" || !("action" in payload)) return null;
  const action = payload.action;
  return action === "start" || action === "poll" || action === "recheck" || action === "disconnect"
    ? action
    : null;
}

function readSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("sessionId" in payload)) return null;
  const sessionId = payload.sessionId;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

function readProvider(value: unknown): "openai" | "anthropic" {
  return value === "anthropic" ? "anthropic" : "openai";
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
