import {
  recordRunnerBootstrapEvent,
  RunnerBootstrapEventPersistenceError,
  validateRunnerBootstrapEventPayload,
} from "@/src/server/runners/runner-bootstrap-events";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  const validation = validateRunnerBootstrapEventPayload(payload);

  if (!validation.ok) {
    return validationResponse(validation.issues);
  }

  try {
    const result = await recordRunnerBootstrapEvent(validation.value);

    if (result.ok) {
      return Response.json({
        ok: true,
        runner: {
          id: result.runnerId,
        },
      });
    }

    if (result.reason === "unknown_registration_token") {
      return unauthorizedResponse();
    }

    return validationResponse(result.issues ?? []);
  } catch (error) {
    if (error instanceof RunnerBootstrapEventPersistenceError) {
      return Response.json(
        {
          ok: false,
          error: {
            code: "runner_bootstrap_event_failed",
            message: "Runner bootstrap event could not be recorded.",
          },
        },
        { status: 500 },
      );
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

function unauthorizedResponse() {
  return Response.json(
    {
      ok: false,
      error: {
        code: "invalid_registration_token",
        message: "Registration token is invalid or no longer usable.",
      },
    },
    { status: 401 },
  );
}
