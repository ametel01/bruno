import type { AuthModeDecision } from "@/src/auth/auth-mode";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { admitFounderOperatorToOwnerPreview } from "@/src/server/founder-product-contract/owner-preview-admission";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { projectFounderOwnerPreviewStatus } from "@/src/server/founder-product-contract/owner-preview-status";
import { getFounderRecoveryArchiveStatusForUser } from "@/src/server/founder-product-contract/recovery-archive";
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
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getOperator?: typeof getFounderOperatorForUser;
  confirmTimezone?: typeof confirmFounderTimezoneForUser;
  prepareRuntime?: typeof prepareFounderOperatorRuntimeForUser;
  getRecoveryArchiveStatus?: typeof getFounderRecoveryArchiveStatusForUser;
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
  const recoveryArchive = await (
    dependencies.getRecoveryArchiveStatus ?? getFounderRecoveryArchiveStatusForUser
  )(applicationUser.userId, new Date(), { applicationRevision });
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

function readAction(payload: unknown): "prepare" | "enter_owner_preview" | null {
  if (!payload || typeof payload !== "object" || !("action" in payload)) {
    return null;
  }

  return payload.action === "prepare" || payload.action === "enter_owner_preview"
    ? payload.action
    : null;
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
