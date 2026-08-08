import {
  inspectExhaustedDeploymentWakeup,
  publishDeploymentWakeupAfterCommit,
  replayExhaustedDeploymentWakeupInTransaction,
} from "@/src/server/agents/agent-deployment-dispatch";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import {
  authorizeWakeupOperatorRequest,
  wakeupNoStoreHeaders,
  wakeupOperatorErrorResponse,
} from "@/app/api/internal/agent-deployments/wakeups/exhausted/_shared";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type ExhaustedWakeupRouteContext = {
  params: Promise<{ wakeupId?: string }>;
};

type ExhaustedWakeupRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  createConnection?: () => DatabaseConnection;
  inspectWakeup?: typeof inspectExhaustedDeploymentWakeup;
  replayWakeup?: typeof replayExhaustedDeploymentWakeupInTransaction;
  publishWakeup?: typeof publishDeploymentWakeupAfterCommit;
  now?: () => Date;
};

export async function GET(
  request: Request,
  context: ExhaustedWakeupRouteContext,
  dependencies: ExhaustedWakeupRouteDependencies = {},
) {
  const authorization = authorizeWakeupOperatorRequest(request, dependencies);
  if (authorization) return authorization;

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return invalidRequestResponse();
  }

  const wakeupId = await decodeWakeupId(context);
  if (!wakeupId) return invalidRequestResponse();

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const wakeup = await (dependencies.inspectWakeup ?? inspectExhaustedDeploymentWakeup)(
      connection.db,
      wakeupId,
    );
    if (!wakeup) {
      return wakeupOperatorErrorResponse(
        404,
        "exhausted_wakeup_not_found",
        "Exhausted wakeup evidence was not found.",
      );
    }

    return Response.json({ wakeup }, { headers: wakeupNoStoreHeaders() });
  } catch {
    return inspectionFailedResponse();
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function POST(
  request: Request,
  context: ExhaustedWakeupRouteContext,
  dependencies: ExhaustedWakeupRouteDependencies = {},
) {
  const authorization = authorizeWakeupOperatorRequest(request, dependencies);
  if (authorization) return authorization;

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return invalidRequestResponse();
  }

  const wakeupId = await decodeWakeupId(context);
  if (!wakeupId) return invalidRequestResponse();

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await connection.db.transaction((tx) =>
      (dependencies.replayWakeup ?? replayExhaustedDeploymentWakeupInTransaction)(tx, {
        wakeupId,
        now: dependencies.now?.() ?? new Date(),
      }),
    );

    if (!result.ok) return replayFailureResponse(result.reason);

    await (dependencies.publishWakeup ?? publishDeploymentWakeupAfterCommit)(result.wakeup);
    return Response.json(
      { ok: true, wakeup: result.wakeup },
      { status: 202, headers: wakeupNoStoreHeaders() },
    );
  } catch {
    return wakeupOperatorErrorResponse(
      500,
      "exhausted_wakeup_replay_failed",
      "Exhausted wakeup replay failed safely.",
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function decodeWakeupId(context: ExhaustedWakeupRouteContext): Promise<string | null> {
  try {
    const value = decodeURIComponent((await context.params).wakeupId ?? "");
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

function replayFailureResponse(
  reason: "not_found" | "not_exhausted" | "deployment_terminal" | "superseded",
) {
  if (reason === "not_found") {
    return wakeupOperatorErrorResponse(
      404,
      "exhausted_wakeup_not_found",
      "Exhausted wakeup evidence was not found.",
    );
  }

  const codes = {
    not_exhausted: "exhausted_wakeup_not_replayable",
    deployment_terminal: "exhausted_wakeup_deployment_terminal",
    superseded: "exhausted_wakeup_superseded",
  } as const;
  return wakeupOperatorErrorResponse(409, codes[reason], "Exhausted wakeup cannot be replayed.");
}

function invalidRequestResponse() {
  return wakeupOperatorErrorResponse(
    400,
    "wakeup_operator_request_invalid",
    "Wakeup operator request is invalid.",
  );
}

function inspectionFailedResponse() {
  return wakeupOperatorErrorResponse(
    500,
    "wakeup_operator_inspection_failed",
    "Wakeup exhaustion evidence could not be inspected safely.",
  );
}
