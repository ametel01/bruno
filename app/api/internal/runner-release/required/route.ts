import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import {
  isAuthorizedCronRequest,
  readCronSecretConfig,
  readRunnerRolloutBatchSize,
} from "@/src/server/env";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RequiredReleaseRouteDependencies = {
  readCron?: typeof readCronSecretConfig;
  authorize?: typeof isAuthorizedCronRequest;
  readRolloutBatchSize?: typeof readRunnerRolloutBatchSize;
  runnerImage?: string;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RequiredReleaseRouteDependencies = {},
) {
  const cron = (dependencies.readCron ?? readCronSecretConfig)();
  if (!cron.ok) return errorResponse(503, "release_verification_unavailable");

  if (
    !(dependencies.authorize ?? isAuthorizedCronRequest)({
      authorizationHeader: request.headers.get("authorization"),
      secret: cron.secret,
    })
  ) {
    return errorResponse(401, "release_verification_unauthorized");
  }

  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return errorResponse(400, "release_verification_request_invalid");
  }

  const release = parseImmutableRunnerImageReference(
    dependencies.runnerImage ?? process.env.AGENTBAY_RUNNER_IMAGE ?? "",
  );
  let rolloutBatchSize: 0 | 1;
  try {
    rolloutBatchSize = (dependencies.readRolloutBatchSize ?? readRunnerRolloutBatchSize)();
  } catch {
    return errorResponse(503, "release_verification_unavailable");
  }

  if (!release) return errorResponse(503, "release_verification_unavailable");

  return Response.json(
    {
      ok: true,
      requiredRelease: {
        imageReference: release.imageReference,
        imageDigest: release.imageDigest,
        version: release.version,
        bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      },
      rollout: {
        batchSize: rolloutBatchSize,
        halted: rolloutBatchSize === 0,
      },
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function errorResponse(status: number, code: string) {
  return Response.json(
    { error: { code, message: "Runner release verification failed safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
