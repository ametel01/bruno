import {
  createDigitalOceanRunnerForDevelopmentUser,
  RunnerProvisioningPersistenceError,
} from "@/src/server/runners/runner-provisioning";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  try {
    const result = await createDigitalOceanRunnerForDevelopmentUser(payload);

    if (result.ok) {
      return Response.json(result, {
        status: result.duplicate ? 200 : 201,
      });
    }

    if (result.reason === "provider_not_configured") {
      return Response.json(
        {
          ok: false,
          error: {
            code: "provider_not_configured",
            message: "DigitalOcean provisioning is not configured on this server.",
          },
        },
        { status: 503 },
      );
    }

    return validationResponse(result.issues);
  } catch (error) {
    if (error instanceof RunnerProvisioningPersistenceError) {
      return provisioningPersistenceErrorResponse(error);
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
    { status: 400 },
  );
}

function provisioningPersistenceErrorResponse(error: RunnerProvisioningPersistenceError) {
  if (hasErrorCode(error.cause, ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "database_unavailable",
          message:
            "Database is unavailable. Start Postgres and run migrations before creating runners.",
        },
      },
      { status: 503 },
    );
  }

  if (hasErrorCode(error.cause, ["42P01", "42704"])) {
    return Response.json(
      {
        ok: false,
        error: {
          code: "database_schema_missing",
          message: "Database schema is missing. Run migrations before creating runners.",
        },
      },
      { status: 503 },
    );
  }

  return Response.json(
    {
      ok: false,
      error: {
        code: "runner_create_failed",
        message: "Runner provisioning could not be started.",
      },
    },
    { status: 500 },
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
