import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import { readExecutingFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { createEncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import { reconcileFounderRecoveryArchives } from "@/src/server/founder-product-contract/recovery-archive";
import type { FounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/recovery-archive-provider";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type ReconciliationResult = Awaited<ReturnType<typeof reconcileFounderRecoveryArchives>>;

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  createProvider?: () => FounderRecoveryArchiveProvider | null;
  readApplicationRevision?: () => string | null;
  reconcile?: (input: {
    applicationRevision: string;
    now: Date;
    provider: FounderRecoveryArchiveProvider;
  }) => Promise<ReconciliationResult>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "recovery_archive_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "recovery_archive_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "recovery_archive_request_invalid");
  }
  const applicationRevision = (
    dependencies.readApplicationRevision ?? readExecutingFounderApplicationRevision
  )();
  if (!applicationRevision) {
    return errorResponse(503, "recovery_archive_configuration_invalid");
  }

  let provider: FounderRecoveryArchiveProvider | null;
  try {
    provider = (dependencies.createProvider ?? createEncryptedFounderRecoveryArchiveProvider)();
  } catch {
    return errorResponse(503, "recovery_archive_configuration_invalid");
  }
  if (!provider) return errorResponse(503, "recovery_archive_configuration_invalid");

  try {
    const result = await (dependencies.reconcile ?? reconcileFounderRecoveryArchives)({
      applicationRevision,
      now: new Date(),
      provider,
    });
    return Response.json({ ok: true, ...result }, { headers: noStoreHeaders() });
  } catch {
    return errorResponse(500, "recovery_archive_processing_failed");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Recovery Archive processing failed safely." } },
    { status, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
