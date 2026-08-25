import type { AuthModeDecision } from "@/src/auth/auth-mode";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { getFounderInfrastructureRetirementStatusForUser } from "@/src/server/founder-product-contract/infrastructure-retirement";
import { admitFounderOperatorToOwnerPreview } from "@/src/server/founder-product-contract/owner-preview-admission";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { projectFounderOwnerPreviewStatus } from "@/src/server/founder-product-contract/owner-preview-status";
import { getFounderRecoveryArchiveStatusForUser } from "@/src/server/founder-product-contract/recovery-archive";
import {
  admitFounderToTrustedPreview,
  enterFounderTrustedPreviewStage,
  issueFounderTrustedPreviewInvitation,
} from "@/src/server/founder-product-contract/trusted-preview-admission";
import {
  getFounderOwnerPreviewAccessForUser,
  hasFounderOwnerPreviewCapabilities,
  requiresFounderReleaseStageAuthority,
} from "@/src/server/founder-product-contract/release-stage-access";
import {
  confirmFounderTimezoneForUser,
  FounderOperatorTimezoneError,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import { prepareFounderOperatorRuntimeForUser } from "@/src/server/operators/founder-operator-runtime";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type OperatorRouteDependencies = {
  admitOwnerPreview?: typeof admitFounderOperatorToOwnerPreview;
  admitTrustedPreview?: typeof admitFounderToTrustedPreview;
  enterTrustedPreviewStage?: typeof enterFounderTrustedPreviewStage;
  issueTrustedPreviewInvitation?: typeof issueFounderTrustedPreviewInvitation;
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getOperator?: typeof getFounderOperatorForUser;
  confirmTimezone?: typeof confirmFounderTimezoneForUser;
  prepareRuntime?: typeof prepareFounderOperatorRuntimeForUser;
  getRecoveryArchiveStatus?: typeof getFounderRecoveryArchiveStatusForUser;
  getInfrastructureRetirementStatus?: typeof getFounderInfrastructureRetirementStatusForUser;
  getOwnerPreviewAccess?: typeof getFounderOwnerPreviewAccessForUser;
  readApplicationRevision?: () => string | null;
  authMode?: AuthModeDecision["mode"];
};

type OperatorRouteContext = {
  params: Promise<unknown>;
};

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  _context?: OperatorRouteContext,
  dependencies: OperatorRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser.status);
  }

  const operator = await (dependencies.getOperator ?? getFounderOperatorForUser)(
    applicationUser.userId,
  );
  const applicationRevision = (
    dependencies.readApplicationRevision ?? readFounderApplicationRevision
  )();
  if (!applicationRevision) {
    return Response.json(
      {
        error: {
          code: "operator_configuration_unavailable",
          message: "Founder workspace protection cannot be verified for this application release.",
        },
      },
      { status: 503, headers: noStoreHeaders() },
    );
  }
  const [recoveryArchive, infrastructureRetirement] = await Promise.all([
    (dependencies.getRecoveryArchiveStatus ?? getFounderRecoveryArchiveStatusForUser)(
      applicationUser.userId,
      new Date(),
      { applicationRevision },
    ),
    (
      dependencies.getInfrastructureRetirementStatus ??
      getFounderInfrastructureRetirementStatusForUser
    )(applicationUser.userId),
  ]);
  const authMode = dependencies.authMode ?? resolveAuthMode(process.env).mode;
  const ownerPreviewAccess = requiresFounderReleaseStageAuthority(authMode)
    ? await (dependencies.getOwnerPreviewAccess ?? getFounderOwnerPreviewAccessForUser)(
        applicationUser.userId,
        new Date(),
      )
    : {
        admitted: true,
        availableCapabilities: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
      };

  return Response.json(
    {
      operator,
      recoveryArchive,
      infrastructureRetirement,
      ownerPreviewAdmitted: ownerPreviewAccess.admitted,
      ownerPreviewWorkAllowed: hasFounderOwnerPreviewCapabilities(
        ownerPreviewAccess,
        FOUNDER_OWNER_PREVIEW_CAPABILITIES,
      ),
      ownerPreview: projectFounderOwnerPreviewStatus(ownerPreviewAccess),
    },
    { headers: noStoreHeaders() },
  );
}

export async function POST(
  request: Request,
  _context?: OperatorRouteContext,
  dependencies: OperatorRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();

  if (!applicationUser.ok) {
    return authenticationResponse(applicationUser.status);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }

  if (readAction(payload) === "prepare") {
    const result = await (dependencies.prepareRuntime ?? prepareFounderOperatorRuntimeForUser)(
      applicationUser.userId,
    );
    const authMode = dependencies.authMode ?? resolveAuthMode(process.env).mode;
    const ownerPreviewAccess = requiresFounderReleaseStageAuthority(authMode)
      ? await (dependencies.getOwnerPreviewAccess ?? getFounderOwnerPreviewAccessForUser)(
          applicationUser.userId,
          new Date(),
        )
      : { admitted: true, availableCapabilities: FOUNDER_OWNER_PREVIEW_CAPABILITIES };
    return Response.json(
      {
        operator: result.operator,
        runtime: result.runtime,
        ownerPreviewAdmitted: ownerPreviewAccess.admitted,
        ownerPreviewWorkAllowed: hasFounderOwnerPreviewCapabilities(
          ownerPreviewAccess,
          FOUNDER_OWNER_PREVIEW_CAPABILITIES,
        ),
        ownerPreview: projectFounderOwnerPreviewStatus(ownerPreviewAccess),
      },
      { headers: noStoreHeaders() },
    );
  }

  if (readAction(payload) === "enter_owner_preview") {
    try {
      await (dependencies.admitOwnerPreview ?? admitFounderOperatorToOwnerPreview)(
        applicationUser.userId,
      );
      const ownerPreviewAccess = await (
        dependencies.getOwnerPreviewAccess ?? getFounderOwnerPreviewAccessForUser
      )(applicationUser.userId, new Date());
      return Response.json(
        {
          ownerPreviewAdmitted: ownerPreviewAccess.admitted,
          ownerPreviewWorkAllowed: hasFounderOwnerPreviewCapabilities(
            ownerPreviewAccess,
            FOUNDER_OWNER_PREVIEW_CAPABILITIES,
          ),
          ownerPreview: projectFounderOwnerPreviewStatus(ownerPreviewAccess),
        },
        { headers: noStoreHeaders() },
      );
    } catch {
      return Response.json(
        {
          error: {
            code: "owner_preview_unavailable",
            message:
              "Owner Preview was denied because its exact-revision qualification and recovery protection are incomplete or unavailable.",
          },
        },
        { status: 503, headers: noStoreHeaders() },
      );
    }
  }

  if (readAction(payload) === "accept_trusted_preview_invitation") {
    const invitationToken = readInvitationToken(payload);
    if (!invitationToken) {
      return validationResponse(
        "A valid Trusted Preview invitation is required.",
        "trusted_preview_invitation_required",
      );
    }
    try {
      await (dependencies.admitTrustedPreview ?? admitFounderToTrustedPreview)(
        applicationUser.userId,
        invitationToken,
      );
      const previewAccess = await (
        dependencies.getOwnerPreviewAccess ?? getFounderOwnerPreviewAccessForUser
      )(applicationUser.userId, new Date());
      return Response.json(
        {
          ownerPreviewAdmitted: previewAccess.admitted,
          ownerPreviewWorkAllowed: hasFounderOwnerPreviewCapabilities(
            previewAccess,
            FOUNDER_OWNER_PREVIEW_CAPABILITIES,
          ),
          ownerPreview: projectFounderOwnerPreviewStatus(previewAccess),
        },
        { headers: noStoreHeaders() },
      );
    } catch {
      return Response.json(
        {
          error: {
            code: "trusted_preview_unavailable",
            message:
              "Trusted Preview was denied because Clerk identity, invitation authority, exact-revision qualification, or recovery protection could not be verified.",
          },
        },
        { status: 403, headers: noStoreHeaders() },
      );
    }
  }

  if (readAction(payload) === "enter_trusted_preview_stage") {
    try {
      const result = await (
        dependencies.enterTrustedPreviewStage ?? enterFounderTrustedPreviewStage
      )(applicationUser.userId);
      return Response.json(
        { trustedPreview: { state: "entered", decisionId: result.decisionId } },
        { headers: noStoreHeaders() },
      );
    } catch {
      return Response.json(
        {
          error: {
            code: "trusted_preview_stage_unavailable",
            message:
              "Trusted Preview was not entered because current Owner learning, exact-revision qualification, or release authority is incomplete.",
          },
        },
        { status: 503, headers: noStoreHeaders() },
      );
    }
  }

  if (readAction(payload) === "issue_trusted_preview_invitation") {
    const invitedClerkSubject = readString(payload, "invitedClerkSubject");
    const serviceBusinessEvidenceDigest = readString(payload, "serviceBusinessEvidenceDigest");
    if (
      !invitedClerkSubject ||
      !serviceBusinessEvidenceDigest ||
      !/^sha256:[a-f0-9]{64}$/.test(serviceBusinessEvidenceDigest)
    ) {
      return validationResponse(
        "Trusted contact and service-business evidence are required.",
        "trusted_preview_invitation_evidence_required",
      );
    }
    try {
      const invitation = await (
        dependencies.issueTrustedPreviewInvitation ?? issueFounderTrustedPreviewInvitation
      )({
        cohortOwnerUserId: applicationUser.userId,
        invitedClerkSubject,
        serviceBusinessEvidenceDigest: serviceBusinessEvidenceDigest as `sha256:${string}`,
      });
      return Response.json({ trustedPreviewInvitation: invitation }, { headers: noStoreHeaders() });
    } catch {
      return Response.json(
        {
          error: {
            code: "trusted_preview_invitation_unavailable",
            message:
              "The trusted contact could not be invited under the current cohort decision and three-person limit.",
          },
        },
        { status: 409, headers: noStoreHeaders() },
      );
    }
  }

  const timezone = readTimezone(payload);
  if (!timezone) {
    return validationResponse("Timezone is required.");
  }

  try {
    const operator = await (dependencies.confirmTimezone ?? confirmFounderTimezoneForUser)(
      applicationUser.userId,
      timezone,
    );
    return Response.json({ operator }, { headers: noStoreHeaders() });
  } catch (error) {
    if (error instanceof FounderOperatorTimezoneError) {
      return validationResponse(error.message, "invalid_timezone");
    }
    throw error;
  }
}

function readTimezone(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("timezone" in payload)) {
    return null;
  }

  const timezone = payload.timezone;
  return typeof timezone === "string" ? timezone : null;
}

function readAction(
  payload: unknown,
):
  | "prepare"
  | "enter_owner_preview"
  | "accept_trusted_preview_invitation"
  | "enter_trusted_preview_stage"
  | "issue_trusted_preview_invitation"
  | null {
  if (!payload || typeof payload !== "object" || !("action" in payload)) {
    return null;
  }

  return payload.action === "prepare" ||
    payload.action === "enter_owner_preview" ||
    payload.action === "accept_trusted_preview_invitation" ||
    payload.action === "enter_trusted_preview_stage" ||
    payload.action === "issue_trusted_preview_invitation"
    ? payload.action
    : null;
}

function readString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || !(key in payload)) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() === value && value.length > 0 ? value : null;
}

function readInvitationToken(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("invitationToken" in payload)) return null;
  return typeof payload.invitationToken === "string" ? payload.invitationToken : null;
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

function validationResponse(message: string, code = "validation_failed"): Response {
  return Response.json(
    {
      error: {
        code,
        message,
      },
    },
    { status: 400, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
