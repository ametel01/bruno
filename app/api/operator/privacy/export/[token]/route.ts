import {
  downloadFounderDataExport,
  type FounderDataExportFormat,
} from "@/src/server/operators/founder-data-export";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ token?: string }> };

type DownloadRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  downloadExport?: typeof downloadFounderDataExport;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
};

export async function GET(
  request: Request,
  context: Context,
  dependencies: DownloadRouteDependencies = {},
): Promise<Response> {
  const user = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
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
          message: "Sign in again before downloading your Founder Data Export.",
        },
      },
      { status: 401, headers: noStoreHeaders() },
    );
  }

  const { token } = await context.params;
  if (!token) return validationResponse("Export token is required.");
  const formatValue = new URL(request.url).searchParams.get("format");
  if (formatValue !== "json" && formatValue !== "html") {
    return validationResponse("Choose JSON or HTML for the export download.");
  }

  const result = await (dependencies.downloadExport ?? downloadFounderDataExport)(
    user.userId,
    token,
    formatValue as FounderDataExportFormat,
  );
  if (!result.ok) {
    return Response.json(
      {
        error: {
          code: result.code,
          message:
            result.code === "export_expired"
              ? "This Founder Data Export expired after 24 hours. Create a new export to continue."
              : "This Founder Data Export is not available.",
        },
      },
      { status: result.status, headers: noStoreHeaders() },
    );
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      ...noStoreHeaders(),
      "Content-Type": result.contentType,
      "Content-Disposition": `attachment; filename="${result.fileName}"`,
      "X-Content-Type-Options": "nosniff",
      "X-Bruno-Export-Expires-At": result.expiresAt,
    },
  });
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
