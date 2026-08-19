import { createDatabaseConnection } from "@/src/server/db/client";
import { isAuthorizedCronRequest, readCronSecretConfig } from "@/src/server/env";
import {
  processFounderRetentionForAllUsers,
  type FounderRetentionDependencies,
} from "@/src/server/operators/founder-retention";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  process?: (
    dependencies?: FounderRetentionDependencies,
  ) => Promise<Awaited<ReturnType<typeof processFounderRetentionForAllUsers>>>;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
) {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "retention_configuration_invalid");
  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "retention_unauthorized");
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "retention_request_invalid");
  }
  try {
    const result = await (dependencies.process ?? processWithConnection)();
    return Response.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return errorResponse(500, "retention_processing_failed");
  }
}

async function processWithConnection() {
  const connection = createDatabaseConnection();
  try {
    return await processFounderRetentionForAllUsers({ createConnection: () => connection });
  } finally {
    await connection.close();
  }
}

function errorResponse(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Founder retention processing failed safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
