import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import {
  admitFounderToExternalBeta,
  enterFounderExternalBetaStage,
  FOUNDER_EXTERNAL_BETA_COMPACT_VERSION,
  getFounderExternalBetaStatusForUser,
  issueFounderExternalBetaInvitation,
  type FounderExternalBetaCompactAcceptance,
  withdrawFounderFromExternalBeta,
} from "@/src/server/founder-product-contract/external-beta-admission";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type RouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  readApplicationRevision?: () => string | null;
  getStatus?: typeof getFounderExternalBetaStatusForUser;
  enterStage?: typeof enterFounderExternalBetaStage;
  issueInvitation?: typeof issueFounderExternalBetaInvitation;
  admit?: typeof admitFounderToExternalBeta;
  withdraw?: typeof withdrawFounderFromExternalBeta;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const applicationRevision = (
    dependencies.readApplicationRevision ?? readFounderApplicationRevision
  )();
  if (!applicationRevision) return errorResponse(503, "external_beta_configuration_unavailable");
  const status = await (dependencies.getStatus ?? getFounderExternalBetaStatusForUser)(
    user.userId,
    dependencies.now?.() ?? new Date(),
    { applicationRevision },
  );
  return Response.json({ externalBeta: status }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const body = await readBody(request);
  if (!body) return errorResponse(400, "external_beta_request_invalid");

  try {
    if (body.action === "enter_stage") {
      const result = await (dependencies.enterStage ?? enterFounderExternalBetaStage)(user.userId);
      return Response.json(
        { externalBeta: { state: "entered", ...result } },
        { headers: noStoreHeaders() },
      );
    }
    if (body.action === "issue_invitation") {
      const invitation = await (dependencies.issueInvitation ?? issueFounderExternalBetaInvitation)(
        {
          cohortOwnerUserId: user.userId,
          invitedClerkSubject: body.invitedClerkSubject,
          namedFounder: body.namedFounder,
          workspaceReference: body.workspaceReference,
          independenceEvidenceDigest: body.independenceEvidenceDigest,
        },
      );
      return Response.json({ externalBetaInvitation: invitation }, { headers: noStoreHeaders() });
    }
    if (body.action === "accept_invitation") {
      const access = await (dependencies.admit ?? admitFounderToExternalBeta)(user.userId, {
        invitationToken: body.invitationToken,
        workspaceReference: body.workspaceReference,
        compact: body.compact,
      });
      return Response.json(
        { externalBeta: { state: "active", ...access } },
        { headers: noStoreHeaders() },
      );
    }
    const result = await (dependencies.withdraw ?? withdrawFounderFromExternalBeta)(
      user.userId,
      dependencies.now?.() ?? new Date(),
    );
    return Response.json(
      { externalBeta: { state: "withdrawn", ...result } },
      { headers: noStoreHeaders() },
    );
  } catch {
    return errorResponse(
      body.action === "accept_invitation" ? 403 : 409,
      body.action === "accept_invitation"
        ? "external_beta_admission_denied"
        : "external_beta_transition_unavailable",
    );
  }
}

type RequestBody =
  | { action: "enter_stage" }
  | {
      action: "issue_invitation";
      invitedClerkSubject: string;
      namedFounder: string;
      workspaceReference: string;
      independenceEvidenceDigest: `sha256:${string}`;
    }
  | {
      action: "accept_invitation";
      invitationToken: string;
      workspaceReference: string;
      compact: FounderExternalBetaCompactAcceptance;
    }
  | { action: "withdraw" };

async function readBody(request: Request): Promise<RequestBody | null> {
  try {
    const value = (await request.json()) as Record<string, unknown>;
    if (value.action === "enter_stage" || value.action === "withdraw") {
      return { action: value.action };
    }
    if (
      value.action === "issue_invitation" &&
      isBoundedString(value.invitedClerkSubject) &&
      isBoundedString(value.namedFounder) &&
      isBoundedString(value.workspaceReference) &&
      isEvidenceDigest(value.independenceEvidenceDigest)
    ) {
      return {
        action: value.action,
        invitedClerkSubject: value.invitedClerkSubject,
        namedFounder: value.namedFounder,
        workspaceReference: value.workspaceReference,
        independenceEvidenceDigest: value.independenceEvidenceDigest,
      };
    }
    if (
      value.action === "accept_invitation" &&
      isInvitationToken(value.invitationToken) &&
      isBoundedString(value.workspaceReference) &&
      isCompact(value.compact)
    ) {
      return {
        action: value.action,
        invitationToken: value.invitationToken,
        workspaceReference: value.workspaceReference,
        compact: value.compact,
      };
    }
    return null;
  } catch {
    return null;
  }
}

function isCompact(value: unknown): value is FounderExternalBetaCompactAcceptance {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const compact = value as Record<string, unknown>;
  return (
    compact.version === FOUNDER_EXTERNAL_BETA_COMPACT_VERSION &&
    [
      "instabilityAccepted",
      "capabilityBoundaryAccepted",
      "reactiveSupportAccepted",
      "companyDataHandlingAccepted",
      "feedbackBoundaryAccepted",
      "withdrawalExportDeletionAccepted",
      "freeNonconvertingBoundaryAccepted",
    ].every((key) => compact[key] === true)
  );
}

function isInvitationToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value);
}

function isBoundedString(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200
  );
}

function isEvidenceDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function authenticationResponse(status: 401 | 503): Response {
  return errorResponse(
    status,
    status === 401 ? "authentication_required" : "authentication_unavailable",
  );
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "External Beta access could not be changed." } },
    { status, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
