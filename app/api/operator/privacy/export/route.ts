import {
  createFounderDataExportForUser,
  FOUNDER_DATA_EXPORT_TTL_MS,
} from "@/src/server/operators/founder-data-export";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type ExportRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  createExport?: typeof createFounderDataExportForUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: ExportRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);

  const recentAuth = await (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(currentRequest, "/api/operator/privacy/export"))
  )(request);
  if (!recentAuth) {
    return Response.json(
      {
        error: {
          code: "recent_authentication_required",
          message: "Sign in again before creating a Founder Data Export.",
        },
      },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  const created = await (dependencies.createExport ?? createFounderDataExportForUser)(user.userId);
  if (!created) {
    return Response.json(
      {
        error: {
          code: "founder_operator_not_found",
          message:
            "Your Founder workspace is not ready for export or a deletion request has stopped access.",
        },
      },
      { status: 404, headers: noStoreHeaders() },
    );
  }

  const basePath = `/api/operator/privacy/export/${encodeURIComponent(created.token)}`;
  return Response.json(
    {
      export: {
        id: created.exportId,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        expiresAfterHours: FOUNDER_DATA_EXPORT_TTL_MS / (60 * 60 * 1000),
        downloads: {
          json: `${basePath}?format=json`,
          html: `${basePath}?format=html`,
        },
      },
    },
    { headers: noStoreHeaders() },
  );
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

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
