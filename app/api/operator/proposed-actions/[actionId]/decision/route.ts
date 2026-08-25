import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import { readDraft } from "@/app/api/operator/proposed-actions/route";
import { FounderExternalActionPauseError } from "@/src/server/operators/founder-ai-work";
import {
  decideFounderProposedActionForUser,
  type FounderActionDecisionKind,
  FounderProposedActionError,
} from "@/src/server/operators/founder-proposed-actions";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ actionId?: string }> };

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  decideAction?: typeof decideFounderProposedActionForUser;
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
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    "workspace",
    { allowGeneralReleaseSetup: true },
  );
  if (accessFailure) return accessFailure;
  const { actionId } = await context.params;
  if (!actionId) return validationResponse("Proposed Action ID is required.");
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (!isRecord(payload)) return validationResponse("A Founder decision is required.");
  const kind = payload.kind;
  if (kind !== "approve" && kind !== "request_changes" && kind !== "decline") {
    return validationResponse("Choose Approve, Request changes, or Decline.");
  }
  const expectedVersion = payload.expectedVersion;
  if (typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
    return validationResponse("The exact Proposed Action version is required.");
  }
  const changes =
    kind === "request_changes" && isRecord(payload.changes) ? readDraft(payload.changes) : null;
  if (kind === "request_changes" && !changes) {
    return validationResponse("Request changes must include the revised action details.");
  }
  try {
    const result = await (dependencies.decideAction ?? decideFounderProposedActionForUser)(
      applicationUser.userId,
      actionId,
      kind as FounderActionDecisionKind,
      expectedVersion,
      changes,
    );
    return Response.json(result, { headers: noStoreHeaders() });
  } catch (error) {
    const accessResponse = founderOperatorAccessErrorResponse(error);
    if (accessResponse) return accessResponse;
    if (error instanceof FounderProposedActionError) {
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
