import {
  readProductionRolloutStatus,
  type ProductionRolloutStatus,
} from "@/src/server/agents/production-rollout-status";
import { createDatabaseConnection } from "@/src/server/db/client";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  readStatus?: () => Promise<ProductionRolloutStatus & Record<string, unknown>>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
) {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "production_rollout_configuration_invalid");
  const authorizationHeader =
    request.headers.get("x-bruno-rollout-authorization") ?? request.headers.get("authorization");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader,
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "production_rollout_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "production_rollout_request_invalid");
  }

  try {
    const status = await (dependencies.readStatus ?? readStatusWithConnection)();
    return Response.json(
      {
        ok: true,
        status: {
          schemaVersion: status.schemaVersion,
          current: status.current,
          activeDeployments: status.activeDeployments,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse(500, "production_rollout_status_failed");
  }
}

async function readStatusWithConnection(): Promise<ProductionRolloutStatus> {
  const connection = createDatabaseConnection();
  try {
    return await readProductionRolloutStatus(connection);
  } finally {
    await connection.close();
  }
}

function errorResponse(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Production rollout status failed safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
