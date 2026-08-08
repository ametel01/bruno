import { checkDatabaseHealth } from "@/src/server/db/health";
import { readDeploymentDispatchConfig } from "@/src/server/env";

export const dynamic = "force-dynamic";

type HealthRouteDependencies = {
  checkHealth?: typeof checkDatabaseHealth;
  readDispatchConfig?: typeof readDeploymentDispatchConfig;
  now?: () => Date;
};

export async function GET(
  _request?: Request,
  _context?: unknown,
  dependencies: HealthRouteDependencies = {},
) {
  const health = await (dependencies.checkHealth ?? checkDatabaseHealth)();
  const dispatch = (dependencies.readDispatchConfig ?? readDeploymentDispatchConfig)();
  const ok = health.ok && dispatch.ok;
  const payload = {
    status: ok ? "ok" : "error",
    database: health.database,
    deploymentDispatch: dispatch.ok ? dispatch.mode : "invalid",
    timestamp: (dependencies.now?.() ?? new Date()).toISOString(),
    ...(health.message
      ? { message: health.message }
      : dispatch.ok
        ? {}
        : { message: "Deployment dispatch configuration is invalid." }),
  };

  return Response.json(payload, {
    status: ok ? 200 : 503,
  });
}
