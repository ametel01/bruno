import { reconcileNextAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type CronRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  reconcile?: typeof reconcileNextAgentDeployment;
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

  try {
    const result = await (dependencies.reconcile ?? reconcileNextAgentDeployment)();

    return Response.json(
      {
        ok: true,
        processed: result.processed,
        outcome: result.outcome,
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
