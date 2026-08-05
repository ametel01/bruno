import {
  recordRunnerBootstrapEvent,
  RunnerBootstrapEventPersistenceError,
  validateRunnerBootstrapEventPayload,
} from "@/src/server/runners/runner-bootstrap-events";
import {
  logRunnerIngress,
  validationIssueSummary,
} from "@/src/server/runners/runner-ingress-logging";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    logRunnerIngress("bootstrap_events", "json_parse_failed");
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  const validation = validateRunnerBootstrapEventPayload(payload);

  if (!validation.ok) {
    logRunnerIngress("bootstrap_events", "validation_failed", {
      ...validationIssueSummary(validation.issues),
    });
    return validationResponse(validation.issues);
  }

  logRunnerIngress("bootstrap_events", "request_validated", {
    phase: validation.value.phase,
    status: validation.value.status,
    metadataStep:
      typeof validation.value.metadata?.step === "string" ? validation.value.metadata.step : null,
  });

  try {
    const result = await recordRunnerBootstrapEvent(validation.value);

    if (result.ok) {
      logRunnerIngress("bootstrap_events", "event_recorded", {
        runnerId: result.runnerId,
        phase: validation.value.phase,
        status: validation.value.status,
      });

      return Response.json({
        ok: true,
        runner: {
          id: result.runnerId,
        },
      });
    }

    if (result.reason === "unknown_registration_token") {
      logRunnerIngress("bootstrap_events", "event_rejected", {
        reason: result.reason,
        phase: validation.value.phase,
        status: validation.value.status,
      });
      return unauthorizedResponse();
    }

    logRunnerIngress("bootstrap_events", "event_rejected", {
      reason: result.reason,
      phase: validation.value.phase,
      status: validation.value.status,
      ...validationIssueSummary(result.issues ?? []),
    });

    return validationResponse(result.issues ?? []);
  } catch (error) {
    if (error instanceof RunnerBootstrapEventPersistenceError) {
      logRunnerIngress(
        "bootstrap_events",
        "persistence_failed",
        {
          phase: validation.value.phase,
          status: validation.value.status,
        },
        error,
      );

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
