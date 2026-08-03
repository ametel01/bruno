import {
  isAuthorizedCronRequest,
  readCronSecretConfig,
  readHermesStagingAcceptanceConfig,
} from "@/src/server/env";
import { reconcileNextHermesStagingAcceptance } from "@/src/server/staging/hermes-staging-acceptance";
import { parseHermesStagingAcceptanceReconcileProjection } from "@/src/server/staging/hermes-staging-acceptance-transport";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type CronRouteDependencies = {
  readAcceptanceConfig?: typeof readHermesStagingAcceptanceConfig;
  readCronConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  reconcile?: (options: { allowForward: boolean }) => Promise<unknown>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: CronRouteDependencies = {},
) {
  const cronConfig = (dependencies.readCronConfig ?? readCronSecretConfig)();

  if (!cronConfig.ok) {
    return errorResponse(
      503,
      "acceptance_cron_configuration_invalid",
      "Hermes staging acceptance cron is not configured safely.",
    );
  }

  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cronConfig.secret,
    })
  ) {
    return errorResponse(
      401,
      "acceptance_cron_unauthorized",
      "Hermes staging acceptance cron authorization is invalid.",
    );
  }

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(
      400,
      "acceptance_cron_request_invalid",
      "Cron request controls are not accepted.",
    );
  }

  const acceptanceConfig = (
    dependencies.readAcceptanceConfig ?? readHermesStagingAcceptanceConfig
  )();
  const allowForward = acceptanceConfig.ok && acceptanceConfig.enabled;

  try {
    const result = await (dependencies.reconcile ?? reconcileNextHermesStagingAcceptance)({
      allowForward,
    });
    const projection = parseHermesStagingAcceptanceReconcileProjection(result);

    return projection
      ? Response.json({ ok: true, ...projection }, { headers: { "Cache-Control": "no-store" } })
      : errorResponse(
          500,
          "acceptance_contract_invalid",
          "Hermes staging acceptance returned an invalid safe projection.",
        );
  } catch {
    return errorResponse(
      500,
      "acceptance_cron_reconcile_failed",
      "Hermes staging acceptance reconciliation failed safely.",
    );
  }
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
