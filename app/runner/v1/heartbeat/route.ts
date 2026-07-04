import {
  recordRunnerHeartbeat,
  RunnerHeartbeatPersistenceError,
} from "@/src/server/runners/runner-heartbeat";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorizationHeader = request.headers.get("authorization");

  if (!hasBearerCredentialShape(authorizationHeader)) {
    return unauthorizedResponse();
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  try {
    const result = await recordRunnerHeartbeat({
      authorizationHeader,
      payload,
    });

    if (!result.ok) {
      if (result.reason === "invalid_payload") {
        return validationResponse(result.issues ?? []);
      }

      if (result.reason === "wrong_runner") {
        return Response.json(
          {
            error: {
              code: "runner_forbidden",
              message: "Runner credentials are not authorized for this runner.",
            },
          },
          { status: 403 },
        );
      }

      return unauthorizedResponse();
    }

    return Response.json({
      ok: true,
      runner: result.runner,
    });
  } catch (error) {
    if (error instanceof RunnerHeartbeatPersistenceError) {
      return Response.json(
        {
          error: {
            code: "runner_heartbeat_failed",
            message: "Runner heartbeat could not be recorded.",
          },
        },
        { status: 500 },
      );
    }

    throw error;
  }
}

function hasBearerCredentialShape(authorizationHeader: string | null) {
  if (!authorizationHeader) {
    return false;
  }

  const credential = /^Bearer\s+(.+)$/i.exec(authorizationHeader.trim())?.[1]?.trim();

  return Boolean(credential && !/\s/.test(credential));
}

function unauthorizedResponse() {
  return Response.json(
    {
      error: {
        code: "runner_unauthorized",
        message: "Runner credentials are invalid.",
      },
    },
    { status: 401 },
  );
}

function validationResponse(issues: Array<{ field: string; message: string }>) {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message: "Request validation failed.",
        issues,
      },
    },
    { status: 400 },
  );
}
