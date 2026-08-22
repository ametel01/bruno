import { admitFounderOperatorToOwnerPreview } from "@/src/server/founder-product-contract/owner-preview-admission";
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

  return Response.json({ operator, recoveryArchive }, { headers: noStoreHeaders() });
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
    if (result.runtime.status === "ready") {
      try {
        await (dependencies.admitOwnerPreview ?? admitFounderOperatorToOwnerPreview)(
          applicationUser.userId,
        );
      } catch {
        return Response.json(
          {
            error: {
              code: "recovery_archive_unavailable",
              message:
                "Owner Preview is waiting for verified recovery protection. Try preparation again.",
            },
          },
          { status: 503, headers: noStoreHeaders() },
        );
      }
    }
    return Response.json(
      { operator: result.operator, runtime: result.runtime },
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
