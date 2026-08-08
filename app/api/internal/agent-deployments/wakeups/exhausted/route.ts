import { listExhaustedDeploymentWakeups } from "@/src/server/agents/agent-deployment-dispatch";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import {
  authorizeWakeupOperatorRequest,
  wakeupNoStoreHeaders,
  wakeupOperatorErrorResponse,
} from "@/app/api/internal/agent-deployments/wakeups/exhausted/_shared";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type ExhaustedWakeupListRouteDependencies = {
  readConfig?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  createConnection?: () => DatabaseConnection;
  listWakeups?: typeof listExhaustedDeploymentWakeups;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: ExhaustedWakeupListRouteDependencies = {},
) {
  const authorization = authorizeWakeupOperatorRequest(request, dependencies);
  if (authorization) return authorization;

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return wakeupOperatorErrorResponse(
      400,
      "wakeup_operator_request_invalid",
      "Wakeup operator request is invalid.",
    );
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const wakeups = await (dependencies.listWakeups ?? listExhaustedDeploymentWakeups)(
      connection.db,
    );
    return Response.json({ wakeups }, { headers: wakeupNoStoreHeaders() });
  } catch {
    return wakeupOperatorErrorResponse(
      500,
      "wakeup_operator_inspection_failed",
      "Wakeup exhaustion evidence could not be inspected safely.",
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}
