import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import { hasFounderGeneralReleaseSetupAccessForUser } from "@/src/server/founder-product-contract/initial-general-release";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import type { getFounderAiConnectionForUser } from "@/src/server/operators/founder-ai-connection";
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
import { isFounderAnthropicReleased } from "@/src/server/operators/founder-anthropic-release";
import { isFounderOpenAiReleased } from "@/src/server/operators/founder-openai-release";
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
  isOpenAiReleased?: () => boolean;
  isAnthropicReleased?: () => boolean;
  hasGeneralReleaseSetupAccess?: typeof hasFounderGeneralReleaseSetupAccessForUser;
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

  const providerValue = new URL(request.url).searchParams.get("provider");
  const provider = providerValue === null ? "openai" : readProvider(providerValue);
  if (!provider) return validationResponse("Choose a supported AI provider.");
  const generalReleaseSetup = await (
    dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser
  )(applicationUser.userId);
  if (provider === "anthropic" && !generalReleaseSetup) {
    return ownerPreviewUnavailableResponse("Anthropic");
  }
  const accessError = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
    { allowGeneralReleaseSetup: true },
  );
  if (accessError) return accessError;
  if (provider === "openai" && !(dependencies.isOpenAiReleased ?? isFounderOpenAiReleased)()) {
    return providerNotReleasedResponse("openai");
  }
  if (
    provider === "anthropic" &&
    !(dependencies.isAnthropicReleased ?? isFounderAnthropicReleased)()
  ) {
    return providerNotReleasedResponse("anthropic");
  }
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
  const provider =
    payload && typeof payload === "object" && "provider" in payload
      ? readProvider(payload.provider)
      : "openai";
  if (!provider) return validationResponse("Choose a supported AI provider.");
  try {
    const generalReleaseSetup = await (
      dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser
    )(applicationUser.userId);
    if (provider === "anthropic" && action !== "disconnect" && !generalReleaseSetup) {
      return ownerPreviewUnavailableResponse("Anthropic");
    }
    if (action !== "disconnect") {
      const accessError = await requireFounderOperatorWorkspaceAccess(
        applicationUser.userId,
        FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
        { allowGeneralReleaseSetup: true },
      );
      if (accessError) return accessError;
    }
    if (
      provider === "openai" &&
      action !== "disconnect" &&
      !(dependencies.isOpenAiReleased ?? isFounderOpenAiReleased)()
    ) {
      return providerNotReleasedResponse("openai");
    }
    if (
      provider === "anthropic" &&
      action !== "disconnect" &&
      !(dependencies.isAnthropicReleased ?? isFounderAnthropicReleased)()
    ) {
      return providerNotReleasedResponse("anthropic");
    }
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

function readProvider(value: unknown): "openai" | "anthropic" | null {
  return value === "openai" || value === "anthropic" ? value : null;
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

function providerNotReleasedResponse(provider: "openai" | "anthropic"): Response {
  return Response.json(
    {
      error: {
        code: "provider_not_released",
        message: `${provider === "anthropic" ? "Anthropic" : "OpenAI"} is unavailable until current Connected Acceptance passes.`,
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}

function ownerPreviewUnavailableResponse(capability: string): Response {
  return Response.json(
    {
      error: {
        code: "owner_preview_capability_unavailable",
        message: `${capability} is unavailable during Owner Preview.`,
      },
    },
    { status: 409, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
