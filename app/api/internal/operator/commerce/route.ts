import { createConfiguredFounderInfrastructureRetirementProvider } from "@/src/server/commerce/founder-commerce-retirement";
import { reconcileNextFounderCommerce } from "@/src/server/commerce/founder-commerce-reconciler";
import {
  LemonSqueezyApiProvider,
  readLemonSqueezyConfig,
} from "@/src/server/commerce/lemon-squeezy-provider";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  readApplicationRevision?: () => string | null;
  reconcile?: typeof reconcileNextFounderCommerce;
  createBoundaries?: () => {
    commerceProvider: LemonSqueezyApiProvider;
    retirementProvider: NonNullable<
      ReturnType<typeof createConfiguredFounderInfrastructureRetirementProvider>
    >;
  } | null;
  now?: () => Date;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "commerce_cron_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "commerce_cron_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "commerce_cron_request_invalid");
  }
  const applicationRevision = (
    dependencies.readApplicationRevision ?? readFounderApplicationRevision
  )();
  if (!applicationRevision) return errorResponse(503, "commerce_configuration_invalid");
  let boundaries: ReturnType<NonNullable<RouteDependencies["createBoundaries"]>>;
  try {
    boundaries =
      dependencies.createBoundaries?.() ??
      (() => {
        const commerceConfig = readLemonSqueezyConfig();
        const retirementProvider = createConfiguredFounderInfrastructureRetirementProvider();
        return commerceConfig && retirementProvider
          ? {
              commerceProvider: new LemonSqueezyApiProvider({ config: commerceConfig }),
              retirementProvider,
            }
          : null;
      })();
  } catch {
    return errorResponse(503, "commerce_configuration_invalid");
  }
  if (!boundaries) return errorResponse(503, "commerce_configuration_invalid");
  try {
    const result = await (dependencies.reconcile ?? reconcileNextFounderCommerce)({
      now: dependencies.now?.() ?? new Date(),
      applicationRevision,
      ...boundaries,
    });
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse(500, "commerce_reconciliation_failed");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Commerce reconciliation failed safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
