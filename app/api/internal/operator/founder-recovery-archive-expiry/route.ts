import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import { processFounderRecoveryArchiveExpiry } from "@/src/server/founder-product-contract/archive-expiry";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  process?: typeof processFounderRecoveryArchiveExpiry;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "archive_expiry_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "archive_expiry_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "archive_expiry_request_invalid");
  }
  try {
    const result = await (dependencies.process ?? processFounderRecoveryArchiveExpiry)();
    return Response.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
  } catch {
    return errorResponse(500, "archive_expiry_failed");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Recovery Archive expiry failed safely." } },
    { status, headers: { "cache-control": "no-store" } },
  );
}
