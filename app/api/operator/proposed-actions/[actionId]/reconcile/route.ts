import {
  FounderMailExecutionError,
  reconcileFounderGmailActionForUser,
} from "@/src/server/operators/founder-mail-execution";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ actionId?: string }> };

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  reconcileAction?: typeof reconcileFounderGmailActionForUser;
};

export async function POST(
  _request: Request,
  context: Context,
  dependencies: Dependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const { actionId } = await context.params;
  if (!actionId) return validationResponse("Proposed Action ID is required.");
  try {
    const result = await (dependencies.reconcileAction ?? reconcileFounderGmailActionForUser)(
      applicationUser.userId,
      actionId,
    );
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderMailExecutionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
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
