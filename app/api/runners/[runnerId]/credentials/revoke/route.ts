import {
  revokeRunnerCredentialForUser,
  RunnerCredentialLifecyclePersistenceError,
  type RunnerCredentialLifecycleFailureReason,
} from "@/src/server/runners/runner-credential-lifecycle";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type RunnerCredentialRouteContext = {
  params: Promise<{
    runnerId?: string;
  }>;
};

type RunnerCredentialRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: RunnerCredentialRouteContext,
  dependencies: RunnerCredentialRouteDependencies = {},
) {
  const decodedRunnerId = await decodeRunnerId(context);

  if (!decodedRunnerId.ok) {
    return lifecycleFailureResponse(decodedRunnerId.reason);
  }

  try {
    const applicationUser = await (
      dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
    )();

    if (!applicationUser.ok) {
      return authenticationResponse(applicationUser);
    }

    const result = await revokeRunnerCredentialForUser(applicationUser.userId, {
      runnerId: decodedRunnerId.runnerId,
    });

    if (result.ok) {
      return Response.json(result);
    }

    return lifecycleFailureResponse(result.reason);
  } catch (error) {
    if (error instanceof RunnerCredentialLifecyclePersistenceError) {
      return lifecyclePersistenceErrorResponse("runner_credential_revoke_failed");
    }

    throw error;
  }
}

function authenticationResponse(
  result: Exclude<ConfiguredApplicationUserResolution, { ok: true }>,
) {
  return Response.json(
    {
      error: {
        code: result.code,
        message:
          result.status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status: result.status },
  );
}

async function decodeRunnerId(context: RunnerCredentialRouteContext): Promise<
  | {
      ok: true;
      runnerId: string;
    }
  | {
      ok: false;
      reason: "missing_runner_id" | "malformed_runner_id";
    }
> {
  const params = await context.params;
  const runnerId = params.runnerId ?? "";

  try {
    const decodedRunnerId = decodeURIComponent(runnerId).trim();

    if (!decodedRunnerId) {
      return { ok: false, reason: "missing_runner_id" };
    }

    if (!isUuid(decodedRunnerId)) {
      return { ok: false, reason: "malformed_runner_id" };
    }

    return { ok: true, runnerId: decodedRunnerId };
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false, reason: "malformed_runner_id" };
    }

    throw error;
  }
}

function lifecycleFailureResponse(reason: RunnerCredentialLifecycleFailureReason) {
  if (reason === "runner_not_found") {
    return Response.json(
      {
        ok: false,
        error: {
          code: "runner_not_found",
          message: "Runner could not be found.",
        },
      },
      { status: 404 },
    );
  }

  if (reason === "runner_credential_already_revoked") {
    return Response.json(
      {
        ok: false,
        error: {
          code: "runner_credential_already_revoked",
          message: "Runner credential is already revoked.",
        },
      },
      { status: 409 },
    );
  }

  if (reason === "runner_credential_not_found") {
    return Response.json(
      {
        ok: false,
        error: {
          code: "runner_credential_not_found",
          message: "Runner credential could not be found.",
        },
      },
      { status: 404 },
    );
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Runner ID must be a valid UUID.",
      },
    },
    { status: 400 },
  );
}

function lifecyclePersistenceErrorResponse(code: "runner_credential_revoke_failed") {
  return Response.json(
    {
      ok: false,
      error: {
        code,
        message: "Runner credential could not be revoked.",
      },
    },
    { status: 500 },
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
