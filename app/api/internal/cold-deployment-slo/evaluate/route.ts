import { createPrivateKey, createPublicKey } from "node:crypto";
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
  const signing = (dependencies.readSigning ?? readColdDeploymentSloSigningConfiguration)();
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
          objectiveSeconds: evaluation.objectiveSeconds,
          eligibleCount: evaluation.eligibleCount,
          readyWithinObjective: evaluation.readyWithinObjective,
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

export function readColdDeploymentSloSigningConfiguration(
  env: Record<string, string | undefined> = process.env,
): Signing | null {
  const keyId = env.BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_ID?.trim();
  const privateKeyPem = env.BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_PEM?.trim();
  const trustSetBytes = env.BRUNO_COLD_DEPLOYMENT_SLO_TRUST_SET?.trim();
  if (!keyId || !privateKeyPem || !trustSetBytes) return null;

  try {
    const parsed = JSON.parse(trustSetBytes) as unknown;
    if (!isRecord(parsed)) return null;
    const trustedPublicKeyPem = parsed[keyId];
    if (typeof trustedPublicKeyPem !== "string" || trustedPublicKeyPem.trim() === "") return null;

    const privateKey = createPrivateKey(privateKeyPem);
    const derivedPublicKeyObject = createPublicKey(privateKeyPem);
    const trustedPublicKey = createPublicKey(trustedPublicKeyPem);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      derivedPublicKeyObject.asymmetricKeyType !== "ed25519" ||
      trustedPublicKey.asymmetricKeyType !== "ed25519"
    ) {
      return null;
    }
    const derivedPublicKey = derivedPublicKeyObject
      .export({ format: "pem", type: "spki" })
      .toString();
    const canonicalTrustedPublicKey = trustedPublicKey
      .export({ format: "pem", type: "spki" })
      .toString();
    return derivedPublicKey === canonicalTrustedPublicKey ? { keyId, privateKeyPem } : null;
  } catch {
    return null;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
