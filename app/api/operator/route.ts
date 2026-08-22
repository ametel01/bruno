import type { AuthModeDecision } from "@/src/auth/auth-mode";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { admitFounderOperatorToOwnerPreview } from "@/src/server/founder-product-contract/owner-preview-admission";
import {
  getFounderOwnerPreviewAccessForUser,
  hasFounderOwnerPreviewCapabilities,
  requiresFounderReleaseStageAuthority,
} from "@/src/server/founder-product-contract/release-stage-access";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { getFounderRecoveryArchiveStatusForUser } from "@/src/server/founder-product-contract/recovery-archive";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
  FounderOperatorTimezoneError,
} from "@/src/server/operators/founder-operator";
import { prepareFounderOperatorRuntimeForUser } from "@/src/server/operators/founder-operator-runtime";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type OperatorRouteDependencies = {
  admitOwnerPreview?: typeof admitFounderOperatorToOwnerPreview;
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  ensureOperator?: typeof ensureFounderOperatorForUser;
  confirmTimezone?: typeof confirmFounderTimezoneForUser;
  prepareRuntime?: typeof prepareFounderOperatorRuntimeForUser;
  getRecoveryArchiveStatus?: typeof getFounderRecoveryArchiveStatusForUser;
  getOwnerPreviewAccess?: typeof getFounderOwnerPreviewAccessForUser;
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

  const operator = await (dependencies.ensureOperator ?? ensureFounderOperatorForUser)(
    applicationUser.userId,
  );
  const recoveryArchive = await (
    dependencies.getRecoveryArchiveStatus ?? getFounderRecoveryArchiveStatusForUser
  )(applicationUser.userId, new Date());
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
    const ownerPreviewAdmission =
      dependencies.admitOwnerPreview ??
      (requiresFounderReleaseStageAuthority(authMode) ? admitFounderOperatorToOwnerPreview : null);
    if (result.runtime.status === "ready" && ownerPreviewAdmission) {
      try {
        await ownerPreviewAdmission(applicationUser.userId);
      } catch {
        return Response.json(
          {
            error: {
              code: "owner_preview_unavailable",
              message:
                "Owner Preview is waiting for current qualification and verified Recovery Archive protection. Try preparation again.",
            },
          },
          { status: 503, headers: noStoreHeaders() },
        );
      }
    }
    return Response.json(
      {
        operator: result.operator,
        runtime: result.runtime,
        ownerPreviewAdmitted: result.runtime.status === "ready",
        ownerPreviewWorkAllowed: result.runtime.status === "ready",
      },
      { headers: noStoreHeaders() },
    );
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

function readAction(payload: unknown): "prepare" | null {
  if (!payload || typeof payload !== "object" || !("action" in payload)) {
    return null;
  }

  return payload.action === "prepare" ? "prepare" : null;
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
