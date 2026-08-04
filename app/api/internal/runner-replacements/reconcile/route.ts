import { randomUUID } from "node:crypto";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import { reconcileNextRunnerReplacement } from "@/src/server/runners/runner-replacement-reconciler";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type CronRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  reconcile?: () => Promise<{ outcome: string; state?: string }>;
  randomUUID?: () => string;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: CronRouteDependencies = {},
) {
  const url = new URL(request.url);
  const config = (dependencies.readConfig ?? readCronSecretConfig)();
  if (!config.ok) {
    return errorResponse(503, "cron_configuration_invalid", "Cron is not configured safely.");
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

  try {
    const result = await (dependencies.reconcile
      ? dependencies.reconcile()
      : reconcileNextRunnerReplacement({
          leaseOwner: `runner-replacement:${(dependencies.randomUUID ?? randomUUID)()}`,
        }));
    const state = "state" in result ? result.state : undefined;
    return Response.json(
      {
        ok: true,
        processed: result.outcome === "idle" ? 0 : 1,
        outcome: result.outcome,
        ...(state ? { state } : {}),
      },
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
