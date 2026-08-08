import { sweepDeploymentWakeupOutbox } from "@/src/server/agents/agent-deployment-dispatch";
import {
  type AgentDeploymentReconcileBudget,
  type AgentDeploymentReconcileResult,
  reconcileNextAgentDeployment,
} from "@/src/server/agents/agent-deployment-reconciler";
import {
  isAuthorizedCronRequest,
  readCronSecretConfig,
  readDeploymentDispatchConfig,
} from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const DEPLOYMENT_CRON_MAX_ITEMS = 25;
export const DEPLOYMENT_CRON_DEADLINE_MS = 40_000;

type CronReconcile = (
  budget: AgentDeploymentReconcileBudget,
) => Promise<AgentDeploymentReconcileResult>;

type CronRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  readDispatchConfig?: typeof readDeploymentDispatchConfig;
  authorize?: typeof isAuthorizedCronRequest;
  reconcile?: CronReconcile;
  sweepWakeups?: typeof sweepDeploymentWakeupOutbox;
  now?: () => Date;
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
    return unauthorizedResponse();
  }

  if (url.search.length > 0 || request.body !== null) {
    return invalidRequestResponse();
  }

  const now = dependencies.now ?? (() => new Date());
  const deadlineAt = new Date(now().getTime() + DEPLOYMENT_CRON_DEADLINE_MS);
  const controller = new AbortController();
  const timeout = setTimeout(
    () =>
      controller.abort(new DOMException("Cron reconciliation deadline exceeded.", "TimeoutError")),
    DEPLOYMENT_CRON_DEADLINE_MS,
  );

  try {
    const dispatch = (dependencies.readDispatchConfig ?? readDeploymentDispatchConfig)();
    const reconcileItemLimit =
      DEPLOYMENT_CRON_MAX_ITEMS - (dispatch.ok && dispatch.mode === "qstash" ? 1 : 0);
    const reconcile: CronReconcile =
      dependencies.reconcile ?? ((budget) => reconcileNextAgentDeployment({}, budget));
    let processed = 0;
    let outcome: AgentDeploymentReconcileResult["outcome"] = "idle";

    while (
      processed < reconcileItemLimit &&
      !controller.signal.aborted &&
      now().getTime() < deadlineAt.getTime()
    ) {
      const result = await reconcile({ deadlineAt, signal: controller.signal });
      if (result.processed === 0) break;

      processed += result.processed;
      outcome = result.outcome;
    }

    if (!controller.signal.aborted && now().getTime() < deadlineAt.getTime()) {
      await (dependencies.sweepWakeups ?? sweepDeploymentWakeupOutbox)({
        signal: controller.signal,
      });
    }

    return Response.json(
      {
        ok: true,
        processed,
        outcome,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "cron_reconcile_failed",
          message: "Cron reconciliation failed safely.",
        },
      },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function invalidRequestResponse() {
  return Response.json(
    {
      error: {
        code: "cron_request_invalid",
        message: "Cron request controls are not accepted.",
      },
    },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}

function unauthorizedResponse() {
  return Response.json(
    {
      error: {
        code: "cron_unauthorized",
        message: "Cron authorization is invalid.",
      },
    },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}
