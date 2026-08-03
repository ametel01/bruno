import {
  confirmCloudRunnerReadiness,
  recordRunnerHeartbeat,
  RunnerHeartbeatPersistenceError,
} from "@/src/server/runners/runner-heartbeat";
import {
  logRunnerIngress,
  readPayloadRunnerId,
  validationIssueSummary,
} from "@/src/server/runners/runner-ingress-logging";
import { scheduleRunnerDeploymentReconcileAfterResponse } from "@/src/server/agents/agent-deployment-triggers";

export const dynamic = "force-dynamic";

type HeartbeatRouteDependencies = {
  scheduleDeploymentReconcile?: typeof scheduleRunnerDeploymentReconcileAfterResponse;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: HeartbeatRouteDependencies = {},
) {
  const authorizationHeader = request.headers.get("authorization");

  if (!hasBearerCredentialShape(authorizationHeader)) {
    logRunnerIngress("heartbeat", "authorization_shape_invalid", {
      hasAuthorizationHeader: Boolean(authorizationHeader),
    });
    return unauthorizedResponse();
  }

  let payload: unknown;

  try {
    payload = await request.json();
  } catch {
    logRunnerIngress("heartbeat", "json_parse_failed");
    return validationResponse([{ field: "body", message: "Request body must be valid JSON." }]);
  }

  logRunnerIngress("heartbeat", "request_received", {
    runnerId: readPayloadRunnerId(payload),
  });

  try {
    const result = await recordRunnerHeartbeat({
      authorizationHeader,
      payload,
    });

    if (!result.ok) {
      if (result.reason === "invalid_payload") {
        logRunnerIngress("heartbeat", "heartbeat_rejected", {
          reason: result.reason,
          runnerId: readPayloadRunnerId(payload),
          ...validationIssueSummary(result.issues ?? []),
        });
        return validationResponse(result.issues ?? []);
      }

      if (result.reason === "wrong_runner") {
        logRunnerIngress("heartbeat", "heartbeat_rejected", {
          reason: result.reason,
          runnerId: readPayloadRunnerId(payload),
        });

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

      logRunnerIngress("heartbeat", "heartbeat_rejected", {
        reason: result.reason,
        runnerId: readPayloadRunnerId(payload),
      });

      return unauthorizedResponse();
    }

    logRunnerIngress("heartbeat", "heartbeat_recorded", {
      runnerId: result.runner.id,
      runnerStatus: result.runner.status,
      observedAt: result.runner.observedAt,
    });

    const readiness = await confirmCloudRunnerReadiness(result.runner.id);

    logRunnerIngress("heartbeat", "readiness_probe_completed", {
      runnerId: result.runner.id,
      outcome: readiness.outcome,
      ...(readiness.outcome === "ready"
        ? { transitioned: readiness.transitioned }
        : { reason: readiness.reason }),
    });

    (dependencies.scheduleDeploymentReconcile ?? scheduleRunnerDeploymentReconcileAfterResponse)(
      result.runner.id,
    );

    return Response.json({
      ok: true,
      runner: result.runner,
    });
  } catch (error) {
    if (error instanceof RunnerHeartbeatPersistenceError) {
      logRunnerIngress("heartbeat", "persistence_failed", {
        runnerId: readPayloadRunnerId(payload),
      });

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
