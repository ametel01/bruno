import { FounderExternalActionPauseError } from "@/src/server/operators/founder-ai-work";
import {
  executeFounderApprovedGmailActionForUser,
  FounderMailExecutionError,
} from "@/src/server/operators/founder-mail-execution";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ actionId?: string }> };

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  executeAction?: typeof executeFounderApprovedGmailActionForUser;
};

export async function POST(
  request: Request,
  context: Context,
  dependencies: Dependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const { actionId } = await context.params;
  if (!actionId) return validationResponse("Proposed Action ID is required.");
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (
    !isRecord(payload) ||
    typeof payload.expectedVersion !== "number" ||
    !Number.isInteger(payload.expectedVersion)
  )
    return validationResponse("The exact Proposed Action version is required.");
  try {
    const result = await (dependencies.executeAction ?? executeFounderApprovedGmailActionForUser)(
      applicationUser.userId,
      actionId,
      payload.expectedVersion,
    );
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderMailExecutionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    if (error instanceof FounderExternalActionPauseError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
