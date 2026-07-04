import {
  createRunnerRegistrationTokenForDevelopmentUser,
  RunnerRegistrationPersistenceError,
} from "@/src/server/runners/runner-registration";

export const dynamic = "force-dynamic";

export async function POST(_request: Request) {
  try {
    const body = await createRunnerRegistrationTokenForDevelopmentUser();

    return Response.json(body, {
      status: 201,
    });
  } catch (error) {
    if (error instanceof RunnerRegistrationPersistenceError) {
      return runnerRegistrationPersistenceErrorResponse(error);
    }

    throw error;
  }
}

function runnerRegistrationPersistenceErrorResponse(error: RunnerRegistrationPersistenceError) {
  if (hasErrorCode(error.cause, ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"])) {
    return Response.json(
      {
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
      error: {
        code: "runner_registration_token_create_failed",
        message: "Runner registration token could not be created.",
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
