import {
  disconnectFounderAnthropicForUser,
  disconnectFounderOpenAiForUser,
} from "@/src/server/operators/founder-ai-connection";
import { disconnectFounderGoogleCalendarForUser } from "@/src/server/operators/founder-calendar-connection";
import { disconnectFounderGoogleMailForUser } from "@/src/server/operators/founder-mail-connection";
import { disconnectFounderGoogleMailSendingForUser } from "@/src/server/operators/founder-mail-sending-connection";
import {
  getFounderDeletionReceiptForUser,
  requestFounderDeletionForUser,
  retryFounderDeletionRevocationsForUser,
  type FounderDeletionKind,
} from "@/src/server/operators/founder-deletion";
import { getFounderPrivacyCenterForUser } from "@/src/server/operators/founder-privacy-center";
import type { deleteFounderRetainedDataForUser } from "@/src/server/operators/founder-privacy-center";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type PrivacyRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getPrivacyCenter?: typeof getFounderPrivacyCenterForUser;
  getDeletionReceipt?: typeof getFounderDeletionReceiptForUser;
  deleteRetainedData?: typeof deleteFounderRetainedDataForUser;
  requestDeletion?: typeof requestFounderDeletionForUser;
  retryRevocations?: typeof retryFounderDeletionRevocationsForUser;
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
  const deletion = dependencies.getDeletionReceipt
    ? await dependencies.getDeletionReceipt(user.userId)
    : await getFounderDeletionReceiptForUser(user.userId);
  return Response.json({ privacy, deletion }, { headers: noStoreHeaders() });
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

  const requestDeletion = dependencies.requestDeletion ?? requestFounderDeletionForUser;
  if (payload.action === "request_deletion" || payload.action === "close_account") {
    const recentAuth = await requireRecentAuth(request, dependencies);
    if (!recentAuth) return recentAuthenticationResponse();
    const kind: FounderDeletionKind =
      payload.action === "close_account" ? "account_closure" : "retained_data";
    if (kind === "account_closure" && payload.confirmation !== "CLOSE_ACCOUNT") {
      return validationResponse("Type CLOSE_ACCOUNT to confirm account closure.");
    }
    const scope = normalizeDeletionScope(payload.scope);
    if (!scope)
      return validationResponse("Deletion scope contains unsupported or sensitive fields.");
    const deletion = await requestDeletion(user.userId, kind, scope);
    return Response.json({ deletion }, { headers: noStoreHeaders() });
  }

  if (payload.action === "retry_revocations") {
    const recentAuth = await requireRecentAuth(request, dependencies);
    if (!recentAuth) return recentAuthenticationResponse();
    const deletion = await (
      dependencies.retryRevocations ?? retryFounderDeletionRevocationsForUser
    )(user.userId);
    return Response.json({ deletion }, { headers: noStoreHeaders() });
  }

  if (payload.action === "delete_retained_data") {
    const recentAuth = await requireRecentAuth(request, dependencies);
    if (!recentAuth) return recentAuthenticationResponse();
    if (dependencies.deleteRetainedData && !dependencies.requestDeletion) {
      const result = await dependencies.deleteRetainedData(user.userId);
      return Response.json({ result }, { headers: noStoreHeaders() });
    }
    const deletion = await requestDeletion(user.userId, "retained_data", {});
    return Response.json({ deletion }, { headers: noStoreHeaders() });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeDeletionScope(value: unknown): Record<string, unknown> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const allowed = new Set(["reason", "legalException", "securityException", "categories"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;
  const scope: Record<string, unknown> = {};
  for (const key of ["reason", "legalException", "securityException"]) {
    const candidate = value[key];
    if (candidate !== undefined) {
      if (typeof candidate !== "string" || candidate.trim().length === 0 || candidate.length > 500)
        return null;
      scope[key] = candidate.trim();
    }
  }
  if (value.categories !== undefined) {
    if (
      !Array.isArray(value.categories) ||
      value.categories.length > 20 ||
      value.categories.some(
        (item) => typeof item !== "string" || item.trim().length === 0 || item.length > 120,
      )
    )
      return null;
    scope.categories = value.categories.map((item) => item.trim());
  }
  return scope;
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

async function requireRecentAuth(
  request: Request,
  dependencies: PrivacyRouteDependencies,
): Promise<boolean> {
  return (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(currentRequest, "/api/operator/privacy"))
  )(request);
}

function recentAuthenticationResponse(): Response {
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

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
