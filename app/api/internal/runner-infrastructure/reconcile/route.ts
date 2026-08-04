import {
  isAuthorizedCronRequest,
  readCronSecretConfig,
  readRunnerRolloutBatchSize,
} from "@/src/server/env";
import { reconcileNextRunnerInfrastructure } from "@/src/server/runners/runner-infrastructure-reconciler";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type CronRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  reconcile?: typeof reconcileNextRunnerInfrastructure;
  readRolloutBatchSize?: typeof readRunnerRolloutBatchSize;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: CronRouteDependencies = {},
) {
  const url = new URL(request.url);
  const config = (dependencies.readConfig ?? readCronSecretConfig)();

  if (!config.ok) {
    return Response.json(
      {
        error: {
          code: "cron_configuration_invalid",
          message: "Cron is not configured safely.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: config.secret,
    })
  ) {
    return errorResponse(401, "cron_unauthorized", "Cron authorization is invalid.");
  }

  if (url.search.length > 0 || request.body !== null) {
    return errorResponse(400, "cron_request_invalid", "Cron request controls are not accepted.");
  }

  let rolloutBatchSize: 0 | 1;
  try {
    rolloutBatchSize = (dependencies.readRolloutBatchSize ?? readRunnerRolloutBatchSize)();
  } catch {
    return errorResponse(
      503,
      "runner_rollout_configuration_invalid",
      "Runner rollout is not configured safely.",
    );
  }

  if (rolloutBatchSize === 0) {
    return Response.json(
      { ok: true, processed: 0, outcome: "rollout_halted" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await (dependencies.reconcile ?? reconcileNextRunnerInfrastructure)();
    return Response.json(
      { ok: true, processed: result.processed, outcome: result.outcome },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse(500, "cron_reconcile_failed", "Cron reconciliation failed safely.");
  }
}

function errorResponse(status: number, code: string, message: string) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
