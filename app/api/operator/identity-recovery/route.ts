import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import {
  getFounderIdentityRecoveryCredentialStatusForUser,
  issueFounderIdentityRecoveryCredentialForUser,
} from "@/src/server/users/founder-identity-recovery";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
  getStatus?: typeof getFounderIdentityRecoveryCredentialStatusForUser;
  issueCredential?: typeof issueFounderIdentityRecoveryCredentialForUser;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const owner = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!owner.ok) return authenticationResponse(owner.status);
  const credential = await (
    dependencies.getStatus ?? getFounderIdentityRecoveryCredentialStatusForUser
  )(owner.userId);
  return Response.json({ credential }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const owner = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!owner.ok) return authenticationResponse(owner.status);
  if (request.body !== null) return validationResponse();
  const recentlyAuthenticated = await (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(currentRequest, "/api/operator/identity-recovery"))
  )(request);
  if (!recentlyAuthenticated) {
    return Response.json(
      {
        error: {
          code: "recent_authentication_required",
          message: "Sign in again before replacing your Identity Recovery code.",
        },
      },
      { status: 401, headers: noStoreHeaders() },
    );
  }
  const credential = await (
    dependencies.issueCredential ?? issueFounderIdentityRecoveryCredentialForUser
  )({ userId: owner.userId, now: dependencies.now?.() ?? new Date() });
  return Response.json({ credential }, { headers: noStoreHeaders() });
}

function authenticationResponse(status: 401 | 503): Response {
  return Response.json(
    {
      error: {
        code: status === 401 ? "authentication_required" : "auth_configuration_unavailable",
        message:
          status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status, headers: noStoreHeaders() },
  );
}

function validationResponse(): Response {
  return Response.json(
    {
      error: {
        code: "identity_recovery_credential_request_invalid",
        message: "Identity Recovery code requests cannot contain browser-supplied evidence.",
      },
    },
    { status: 400, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
