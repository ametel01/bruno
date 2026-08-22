import {
  isAuthorizedCronRequest,
  readCronSecretConfig,
  readDigitalOceanProviderCredentials,
} from "@/src/server/env";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { createEncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { reconcileFounderExternalBetaRetirements } from "@/src/server/founder-product-contract/external-beta-retirement";
import {
  createFounderExternalBetaRecordingProvider,
  reconcileFounderExternalBetaRecordingRetention,
  type FounderExternalBetaRecordingProvider,
} from "@/src/server/founder-product-contract/external-beta-privacy";
import type { FounderInfrastructureRetirementProvider } from "@/src/server/founder-product-contract/infrastructure-retirement";
import { DigitalOceanApiProvider } from "@/src/server/runners/digitalocean-provider";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  readApplicationRevision?: () => string | null;
  createProviders?: () => FounderInfrastructureRetirementProvider | null;
  createRecordingProvider?: () => FounderExternalBetaRecordingProvider | null;
  reconcile?: typeof reconcileFounderExternalBetaRetirements;
  reconcileRecordings?: typeof reconcileFounderExternalBetaRecordingRetention;
  now?: () => Date;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "external_beta_retirement_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "external_beta_retirement_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "external_beta_retirement_request_invalid");
  }
  const applicationRevision = (
    dependencies.readApplicationRevision ?? readFounderApplicationRevision
  )();
  if (!applicationRevision) {
    return errorResponse(503, "external_beta_retirement_configuration_invalid");
  }
  let providers: FounderInfrastructureRetirementProvider | null;
  try {
    providers = (dependencies.createProviders ?? createConfiguredProviders)();
  } catch {
    return errorResponse(503, "external_beta_retirement_configuration_invalid");
  }
  if (!providers) return errorResponse(503, "external_beta_retirement_configuration_invalid");

  try {
    const now = dependencies.now?.() ?? new Date();
    const result = await (dependencies.reconcile ?? reconcileFounderExternalBetaRetirements)({
      applicationRevision,
      now,
      providers,
    });
    const recordingDeletion = await (
      dependencies.reconcileRecordings ?? reconcileFounderExternalBetaRecordingRetention
    )(now, (dependencies.createRecordingProvider ?? createFounderExternalBetaRecordingProvider)());
    return Response.json({ ok: true, ...result, recordingDeletion }, { headers: noStoreHeaders() });
  } catch {
    return errorResponse(500, "external_beta_retirement_processing_failed");
  }
}

function createConfiguredProviders(): FounderInfrastructureRetirementProvider | null {
  const archive = createEncryptedFounderRecoveryArchiveProvider();
  const credentials = readDigitalOceanProviderCredentials();
  if (!archive || !credentials) return null;
  const digitalOcean = new DigitalOceanApiProvider({ token: credentials.token });
  return {
    createRecoveryArchive: archive.createRecoveryArchive.bind(archive),
    deleteRecoveryArchive: archive.deleteRecoveryArchive.bind(archive),
    digitalOcean,
    calls: () => [],
  };
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "External Beta retirement processing failed safely." } },
    { status, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
