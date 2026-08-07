import {
  claimDeploymentWakeupDelivery,
  deploymentWakeupCallbackUrl,
  deploymentWakeupSafeCodes,
  parseDeploymentWakeupPayload,
  readBoundedDeploymentWakeupBody,
  verifyDeploymentWakeupSignature,
} from "@/src/server/agents/agent-deployment-dispatch";
import { reconcileTargetAgentDeployment } from "@/src/server/agents/agent-deployment-reconciler";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { type DeploymentDispatchConfig, readDeploymentDispatchConfig } from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type WakeupRouteDependencies = {
  readConfig?: typeof readDeploymentDispatchConfig;
  createConnection?: () => DatabaseConnection;
  reconcile?: typeof reconcileTargetAgentDeployment;
  now?: () => Date;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: WakeupRouteDependencies = {},
) {
  const config = (dependencies.readConfig ?? readDeploymentDispatchConfig)();

  if (!config.ok || config.mode !== "qstash") {
    return safeError(503, "deployment_dispatch_configuration_invalid");
  }

  if (new URL(request.url).search.length > 0) {
    return safeError(400, "deployment_wakeup_request_invalid");
  }

  const raw = await readBoundedDeploymentWakeupBody(request);
  if (!raw.ok) {
    return safeError(400, "deployment_wakeup_request_invalid");
  }

  if (!(await isSigned(config, request, raw.body))) {
    return safeError(401, "deployment_wakeup_unauthorized");
  }

  const parsed = parseDeploymentWakeupPayload(raw.body);
  if (!parsed.ok) {
    return safeError(400, "deployment_wakeup_payload_invalid");
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now?.() ?? new Date();

  try {
    const claim = await connection.db.transaction((tx) =>
      claimDeploymentWakeupDelivery(tx, {
        payload: parsed.payload,
        now,
      }),
    );

    if (!claim.ok) {
      return Response.json(
        { ok: true, processed: 0, outcome: claim.reason },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    const result = await (dependencies.reconcile ?? reconcileTargetAgentDeployment)(
      claim.deploymentId,
    );

    return Response.json(
      { ok: true, processed: result.processed, outcome: result.outcome },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return safeError(500, "deployment_wakeup_failed");
  } finally {
    if (ownsConnection) await connection.close();
  }
}

function isSigned(
  config: Extract<DeploymentDispatchConfig, { mode: "qstash" }>,
  request: Request,
  body: string,
): Promise<boolean> {
  return verifyDeploymentWakeupSignature({
    body,
    signatureHeader: request.headers.get(deploymentWakeupSafeCodes.signatureHeader),
    callbackUrl: deploymentWakeupCallbackUrl(config),
    upstashRegionHeader: request.headers.get(deploymentWakeupSafeCodes.regionHeader),
    currentSigningKey: config.currentSigningKey,
    nextSigningKey: config.nextSigningKey,
  });
}

function safeError(status: number, code: string) {
  return Response.json(
    {
      error: {
        code,
        message: "Deployment wakeup delivery failed safely.",
      },
    },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
