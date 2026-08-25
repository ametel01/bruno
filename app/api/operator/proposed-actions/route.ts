import {
  founderOperatorAccessErrorResponse,
  requireFounderOperatorWorkspaceAccess,
} from "@/app/api/operator/_shared/owner-preview-access";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  createFounderProposedActionForUser,
  type FounderActionFamily,
  type FounderProposedActionDraft,
  FounderProposedActionError,
  getFounderProposedActionsForUser,
  reviseFounderProposedActionForUser,
} from "@/src/server/operators/founder-proposed-actions";
import type { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { requireConfiguredApplicationUser as defaultRequireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getActions?: typeof getFounderProposedActionsForUser;
  createAction?: typeof createFounderProposedActionForUser;
  reviseAction?: typeof reviseFounderProposedActionForUser;
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
  const actions = await (dependencies.getActions ?? getFounderProposedActionsForUser)(
    applicationUser.userId,
  );
  return Response.json({ actions }, { headers: noStoreHeaders() });
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
  if (!isRecord(payload) || (payload.action !== "create" && payload.action !== "revise")) {
    return validationResponse("Choose create or revise for a Proposed Action.");
  }
  const draft = readDraft(payload);
  if (!draft)
    return validationResponse("Action Family, outcome, content, and validity are required.");
  try {
    if (payload.action === "revise") {
      const actionId = typeof payload.id === "string" ? payload.id : "";
      const expectedVersion = payload.expectedVersion;
      if (!actionId || typeof expectedVersion !== "number" || !Number.isInteger(expectedVersion)) {
        return validationResponse(
          "A Proposed Action ID and exact version are required to revise it.",
        );
      }
      const action = await (dependencies.reviseAction ?? reviseFounderProposedActionForUser)(
        applicationUser.userId,
        actionId,
        expectedVersion,
        draft,
      );
      return Response.json({ action }, { headers: noStoreHeaders() });
    }
    const action = await (dependencies.createAction ?? createFounderProposedActionForUser)(
      applicationUser.userId,
      draft,
    );
    return Response.json({ action }, { status: 201, headers: noStoreHeaders() });
  } catch (error) {
    const accessResponse = founderOperatorAccessErrorResponse(error);
    if (accessResponse) return accessResponse;
    if (error instanceof FounderProposedActionError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

export function readDraft(value: Record<string, unknown>): FounderProposedActionDraft | null {
  const actionFamily = value.actionFamily;
  if (
    actionFamily !== "observe_evidence" &&
    actionFamily !== "relationship_maintenance" &&
    actionFamily !== "prepare_work" &&
    actionFamily !== "external_communication" &&
    actionFamily !== "meeting_management" &&
    actionFamily !== "commercial_commitment" &&
    actionFamily !== "data_control"
  ) {
    return null;
  }
  const destination = isRecord(value.destination) ? value.destination : null;
  const materialContent = isRecord(value.materialContent) ? value.materialContent : null;
  const validUntil = typeof value.validUntil === "string" ? value.validUntil : null;
  const preconditions = Array.isArray(value.preconditions)
    ? value.preconditions.flatMap((condition) => {
        if (!isRecord(condition)) return [];
        if (typeof condition.key !== "string" || typeof condition.description !== "string")
          return [];
        return [{ key: condition.key, description: condition.description }];
      })
    : [];
  if (!destination || !materialContent || !validUntil) return null;
  return {
    actionFamily: actionFamily as FounderActionFamily,
    actionSubtype: typeof value.actionSubtype === "string" ? value.actionSubtype : null,
    businessOutcome: typeof value.businessOutcome === "string" ? value.businessOutcome : "",
    companyConnectionId: readOptionalString(value.companyConnectionId),
    connectionResourceId: readOptionalString(value.connectionResourceId),
    connectionAccessVersion:
      typeof value.connectionAccessVersion === "number" ? value.connectionAccessVersion : null,
    processingConsentId: readOptionalString(value.processingConsentId),
    destination,
    materialContent,
    sideEffects: Array.isArray(value.sideEffects)
      ? value.sideEffects.filter((item): item is string => typeof item === "string")
      : [],
    preconditions,
    validUntil,
    executionWindowStart: readOptionalString(value.executionWindowStart),
    executionWindowEnd: readOptionalString(value.executionWindowEnd),
    idempotencyKey: readOptionalString(value.idempotencyKey),
  };
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
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
