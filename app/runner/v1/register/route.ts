import {
  exchangeRunnerRegistrationTokenForCredential,
  RunnerRegistrationPersistenceError,
  validateRegisterRunnerPayload,
} from "@/src/server/runners/runner-registration";
import {
  logRunnerIngress,
  safeHostname,
  validationIssueSummary,
} from "@/src/server/runners/runner-ingress-logging";
import { scheduleRunnerReconciliationsAfterResponse } from "@/src/server/agents/agent-runtime-triggers";

export const dynamic = "force-dynamic";

type RegisterRouteDependencies = {
  scheduleReconciliations?: typeof scheduleRunnerReconciliationsAfterResponse;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RegisterRouteDependencies = {},
) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    logRunnerIngress("register", "json_parse_failed");
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  const validation = validateRegisterRunnerPayload(payload);

  if (!validation.ok) {
    logRunnerIngress("register", "validation_failed", {
      ...validationIssueSummary(validation.issues),
    });
    return validationResponse(validation.issues);
  }

  logRunnerIngress("register", "request_validated", {
    endpointHostname: safeHostname(validation.value.endpointUrl),
    hasName: Boolean(validation.value.name),
  });

  try {
    const result = await exchangeRunnerRegistrationTokenForCredential(validation.value);

    if (result.ok) {
      logRunnerIngress("register", "runner_registered", {
        runnerId: result.runner.id,
        endpointHostname: safeHostname(validation.value.endpointUrl),
      });

      (dependencies.scheduleReconciliations ?? scheduleRunnerReconciliationsAfterResponse)(
        result.runner.id,
      );

      return Response.json(result, {
        status: 201,
      });
    }

    logRunnerIngress("register", "registration_rejected", {
      reason: result.reason,
      endpointHostname: safeHostname(validation.value.endpointUrl),
    });

    return invalidRegistrationTokenResponse();
  } catch (error) {
    if (error instanceof RunnerRegistrationPersistenceError) {
      logRunnerIngress(
        "register",
        "persistence_failed",
        {
          endpointHostname: safeHostname(validation.value.endpointUrl),
        },
        error,
      );

      return runnerRegistrationPersistenceErrorResponse(error);
    }

    throw error;
  }
}

function validationResponse(issues: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      ok: false,
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues,
      },
    },
    {
      status: 400,
    },
  );
}

function invalidRegistrationTokenResponse() {
  return Response.json(
    {
      ok: false,
      error: {
        code: "invalid_registration_token",
        message: "Registration token is invalid or no longer usable.",
      },
    },
    {
      status: 401,
    },
  );
}

function runnerRegistrationPersistenceErrorResponse(error: RunnerRegistrationPersistenceError) {
  if (hasErrorCode(error.cause, ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "database_unavailable",
          message:
            "Database is unavailable. Start Postgres and run migrations before registering runners.",
        },
      },
      {
        status: 503,
      },
    );
  }

  if (hasErrorCode(error.cause, ["42P01", "42704"])) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "database_schema_missing",
          message: "Database schema is missing. Run migrations before registering runners.",
        },
      },
      {
        status: 503,
      },
    );
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: "runner_registration_failed",
        message: "Runner could not be registered.",
      },
    },
    {
      status: 500,
    },
  );
}

function hasErrorCode(value: unknown, codes: string[], depth = 0): boolean {
  if (depth > 4 || typeof value !== "object" || value === null) {
    return false;
  }

  const code = "code" in value ? value.code : undefined;

  if (typeof code === "string" && codes.includes(code)) {
    return true;
  }

  const cause = "cause" in value ? value.cause : undefined;

  return hasErrorCode(cause, codes, depth + 1);
}
