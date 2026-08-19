import { auth } from "@clerk/nextjs/server";
import { evaluateOperatorAccess } from "@/src/auth/operator-access";
import { resolveAuthMode } from "@/src/auth/auth-mode";
import {
  disconnectFounderAnthropicForUser,
  disconnectFounderOpenAiForUser,
} from "@/src/server/operators/founder-ai-connection";
import { disconnectFounderGoogleCalendarForUser } from "@/src/server/operators/founder-calendar-connection";
import { disconnectFounderGoogleMailForUser } from "@/src/server/operators/founder-mail-connection";
import { disconnectFounderGoogleMailSendingForUser } from "@/src/server/operators/founder-mail-sending-connection";
import {
  deleteFounderRetainedDataForUser,
  getFounderPrivacyCenterForUser,
} from "@/src/server/operators/founder-privacy-center";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type PrivacyRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getPrivacyCenter?: typeof getFounderPrivacyCenterForUser;
  deleteRetainedData?: typeof deleteFounderRetainedDataForUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: PrivacyRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const privacy = await (dependencies.getPrivacyCenter ?? getFounderPrivacyCenterForUser)(
    user.userId,
  );
  if (!privacy) return Response.json({ privacy: null }, { headers: noStoreHeaders() });
  return Response.json({ privacy }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: PrivacyRouteDependencies = {},
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
    return validationResponse("Choose a privacy control.");
  }

  const recentAuth = await (dependencies.requireRecentAuth ?? requireRecentAuthentication)(request);
  if (!recentAuth) {
    return Response.json(
      {
        error: {
          code: "recent_authentication_required",
          message: "Sign in again before deleting retained Bruno data.",
        },
      },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  if (payload.action === "delete_retained_data") {
    const result = await (dependencies.deleteRetainedData ?? deleteFounderRetainedDataForUser)(
      user.userId,
    );
    return Response.json({ result }, { headers: noStoreHeaders() });
  }

  if (payload.action === "disconnect") {
    const kind = payload.kind;
    if (kind === "ai") {
      const provider = payload.provider === "anthropic" ? "anthropic" : "openai";
      const connection =
        provider === "anthropic"
          ? await disconnectFounderAnthropicForUser(user.userId)
          : await disconnectFounderOpenAiForUser(user.userId);
      return Response.json({ connection }, { headers: noStoreHeaders() });
    }
    if (kind === "calendar") {
      return Response.json(
        { connection: await disconnectFounderGoogleCalendarForUser(user.userId) },
        { headers: noStoreHeaders() },
      );
    }
    if (kind === "mail") {
      return Response.json(
        { connection: await disconnectFounderGoogleMailForUser(user.userId) },
        { headers: noStoreHeaders() },
      );
    }
    if (kind === "mail_sending") {
      return Response.json(
        { connection: await disconnectFounderGoogleMailSendingForUser(user.userId) },
        { headers: noStoreHeaders() },
      );
    }
  }

  return validationResponse("Choose a supported privacy control.");
}

async function requireRecentAuthentication(request: Request): Promise<boolean> {
  const env = process.env;
  const mode = resolveAuthMode(env);
  if (mode.mode === "development") return true;
  if (mode.mode === "operator") {
    return evaluateOperatorAccess({
      pathname: "/api/operator/privacy",
      authorizationHeader: request.headers.get("authorization"),
      env,
    }).ok;
  }
  if (mode.mode !== "clerk") return false;

  const { sessionClaims } = await auth();
  const issuedAt = (sessionClaims as unknown as { iat?: unknown } | null)?.iat;
  if (typeof issuedAt !== "number") return false;
  return Date.now() - issuedAt * 1000 <= 15 * 60 * 1000;
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
  return Response.json({ error: { code: "validation_failed", message } }, { status: 400 });
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
