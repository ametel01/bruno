import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  dismissFounderMailSendingOfferForUser,
  editFounderActionPreviewForUser,
  FounderActionPreviewError,
  getFounderActionPreviewForUser,
} from "@/src/server/operators/founder-action-previews";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getPreview?: typeof getFounderActionPreviewForUser;
  editPreview?: typeof editFounderActionPreviewForUser;
  dismissMailOffer?: typeof dismissFounderMailSendingOfferForUser;
};

export async function GET(
  _request: Request,
  _context?: unknown,
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
  const preview = await (dependencies.getPreview ?? getFounderActionPreviewForUser)(
    applicationUser.userId,
  );
  return Response.json({ preview }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? defaultRequireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(
    applicationUser.userId,
    FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
    { allowGeneralReleaseSetup: true },
  );
  if (accessFailure) return accessFailure;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (!isRecord(payload)) {
    return validationResponse("Only Action Preview draft edits are supported.");
  }
  if (payload.action === "dismiss_mail_offer") {
    try {
      const preview = await (
        dependencies.dismissMailOffer ?? dismissFounderMailSendingOfferForUser
      )(applicationUser.userId);
      return Response.json({ preview }, { headers: noStoreHeaders() });
    } catch (error) {
      const accessResponse = founderOperatorAccessErrorResponse(error);
      if (accessResponse) return accessResponse;
      if (error instanceof FounderActionPreviewError) {
        return Response.json(
          { error: { code: error.code, message: error.message } },
          { status: error.status, headers: noStoreHeaders() },
        );
      }
      throw error;
    }
  }
  if (payload.action !== "edit") {
    return validationResponse("Only Action Preview draft edits are supported.");
  }
  const draft = readDraft(payload);
  if (!draft) return validationResponse("Recipient, content, evidence, and effect are required.");
  try {
    const preview = await (dependencies.editPreview ?? editFounderActionPreviewForUser)(
      applicationUser.userId,
      draft,
    );
    return Response.json({ preview }, { headers: noStoreHeaders() });
  } catch (error) {
    const accessResponse = founderOperatorAccessErrorResponse(error);
    if (accessResponse) return accessResponse;
    if (error instanceof FounderActionPreviewError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function readDraft(value: Record<string, unknown>) {
  const recipient = isRecord(value.recipient) ? value.recipient : null;
  const evidence = Array.isArray(value.supportingEvidence) ? value.supportingEvidence : null;
  if (!recipient || typeof recipient.name !== "string" || typeof recipient.address !== "string") {
    return null;
  }
  if (!evidence) return null;
  const supportingEvidence = evidence.flatMap((item) => {
    if (!isRecord(item) || typeof item.label !== "string" || typeof item.detail !== "string") {
      return [];
    }
    return [{ label: item.label, detail: item.detail }];
  });
  if (supportingEvidence.length === 0) return null;
  return {
    recipientName: recipient.name,
    recipientAddress: recipient.address,
    content: typeof value.content === "string" ? value.content : "",
    supportingEvidence,
    expectedExternalEffect:
      typeof value.expectedExternalEffect === "string" ? value.expectedExternalEffect : "",
  };
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
  return Response.json(
    { error: { code: "validation_failed", message } },
    { status: 400, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
