import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import type {
  getFounderConversationForUser as getConversation,
  sendFounderConversationMessageForUser as sendMessage,
} from "@/src/server/operators/founder-conversation";
import {
  FounderConversationError,
  getFounderConversationForUser,
  resumeFounderConversationWorkForUser,
  sendFounderConversationMessageForUser,
} from "@/src/server/operators/founder-conversation";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type ConversationRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getConversation?: typeof getConversation;
  sendMessage?: typeof sendMessage;
  resumeWork?: typeof resumeFounderConversationWorkForUser;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: ConversationRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    "workspace",
  );
  if (accessFailure) return accessFailure;

  const conversation = await (dependencies.getConversation ?? getFounderConversationForUser)(
    applicationUser.userId,
  );
  return Response.json({ conversation }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: ConversationRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
  );
  if (accessFailure) return accessFailure;

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  const message = readString(payload, "message");
  const action = readString(payload, "action");
  if (action === "resume") {
    const workId = readString(payload, "workId");
    if (!workId) return validationResponse("workId is required to resume a checkpoint.");
    try {
      const conversation = await (dependencies.resumeWork ?? resumeFounderConversationWorkForUser)(
        applicationUser.userId,
        workId,
      );
      return Response.json({ conversation }, { headers: noStoreHeaders() });
    } catch (error) {
      const accessResponse = founderOperatorAccessErrorResponse(error);
      if (accessResponse) return accessResponse;
      if (error instanceof FounderConversationError) {
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status, headers: noStoreHeaders() },
        );
      }
      throw error;
    }
  }
  if (!message) return validationResponse("Message is required.");
  const requestId = readString(payload, "requestId");

  try {
    const conversation = await (dependencies.sendMessage ?? sendFounderConversationMessageForUser)(
      applicationUser.userId,
      message,
      { ...(requestId ? { requestId } : {}) },
    );
    return Response.json({ conversation }, { headers: noStoreHeaders() });
  } catch (error) {
    const accessResponse = founderOperatorAccessErrorResponse(error);
    if (accessResponse) return accessResponse;
    if (error instanceof FounderConversationError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
