import {
  evaluateColdDeploymentSloForDatabase,
  type ColdDeploymentSloEvaluation,
} from "@/src/server/agents/cold-deployment-slo-evaluation";
import { createDatabaseConnection } from "@/src/server/db/client";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type Signing = { keyId: string; privateKeyPem: string };
type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  readSigning?: () => Signing | null;
  authorize?: typeof isAuthorizedCronRequest;
  evaluate?: (signing: Signing) => Promise<ColdDeploymentSloEvaluation>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
) {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  const signing = (dependencies.readSigning ?? readSigningConfiguration)();
  if (!cron.ok || !signing) return errorResponse(503, "cold_slo_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "cold_slo_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "cold_slo_request_invalid");
  }

  try {
    const evaluation = await (dependencies.evaluate ?? evaluateWithConnection)(signing);
    return Response.json(
      {
        ok: true,
        evaluation: {
          reportDigest: evaluation.reportDigest,
          eligibleCount: evaluation.eligibleCount,
          readyWithin60: evaluation.readyWithin60,
          pendingCount: evaluation.pendingCount,
          proven: evaluation.proven,
          incidentOpened: evaluation.incidentOpened,
          apiAcceptance: evaluation.apiAcceptance,
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return errorResponse(500, "cold_slo_evaluation_failed");
  }
}

function readSigningConfiguration(): Signing | null {
  const keyId = process.env.BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_ID?.trim();
  const privateKeyPem = process.env.BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_PEM?.trim();
  return keyId && privateKeyPem ? { keyId, privateKeyPem } : null;
}

async function evaluateWithConnection(signing: Signing): Promise<ColdDeploymentSloEvaluation> {
  const connection = createDatabaseConnection();
  try {
    return await evaluateColdDeploymentSloForDatabase(connection, { signing });
  } finally {
    await connection.close();
  }
}

function errorResponse(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Cold-Deployment SLO evaluation failed safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
