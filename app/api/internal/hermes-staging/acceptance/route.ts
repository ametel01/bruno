import {
  isAuthorizedHermesStagingAcceptanceRequest,
  readHermesStagingAcceptanceConfig,
} from "@/src/server/env";
import {
  commandHermesStagingAcceptance,
  readHermesStagingAcceptance,
  reconcileTargetHermesStagingAcceptance,
} from "@/src/server/staging/hermes-staging-acceptance";
import {
  HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES,
  type HermesStagingAcceptanceCommand,
  parseHermesStagingAcceptanceCommand,
  parseHermesStagingAcceptanceReconcileProjection,
  parseHermesStagingAcceptanceSafeProjection,
} from "@/src/server/staging/hermes-staging-acceptance-transport";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type AcceptanceRouteDependencies = {
  readConfig?: typeof readHermesStagingAcceptanceConfig;
  authorize?: typeof isAuthorizedHermesStagingAcceptanceRequest;
  command?: (command: HermesStagingAcceptanceCommand) => Promise<unknown>;
  read?: (runId: string) => Promise<unknown>;
  reconcileTarget?: (runId: string) => Promise<unknown>;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: AcceptanceRouteDependencies = {},
) {
  const config = (dependencies.readConfig ?? readHermesStagingAcceptanceConfig)();

  if (!config.ok) {
    return errorResponse(
      503,
      "acceptance_configuration_invalid",
      "Hermes staging acceptance is not configured safely.",
    );
  }

  if (!config.enabled) {
    return errorResponse(404, "acceptance_disabled", "Hermes staging acceptance is disabled.");
  }

  if (
    !(dependencies.authorize ?? isAuthorizedHermesStagingAcceptanceRequest)({
      authorizationHeader: request.headers.get("authorization"),
      bearerSecret: config.bearerSecret,
    })
  ) {
    return errorResponse(
      401,
      "acceptance_unauthorized",
      "Hermes staging acceptance authorization is invalid.",
    );
  }

  if (new URL(request.url).search.length > 0) {
    return errorResponse(400, "acceptance_request_invalid", "Query controls are not accepted.");
  }

  if (request.headers.get("content-type") !== "application/json") {
    return errorResponse(
      415,
      "acceptance_content_type_invalid",
      "Content-Type must be application/json.",
    );
  }

  const contentLength = request.headers.get("content-length");

  if (
    contentLength !== null &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) === 0 ||
      Number(contentLength) > HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES)
  ) {
    return errorResponse(
      413,
      "acceptance_request_too_large",
      "The acceptance command body is outside the allowed size.",
    );
  }

  const rawBody = await readBoundedBody(request);

  if (!rawBody.ok) {
    return errorResponse(
      rawBody.tooLarge ? 413 : 400,
      rawBody.tooLarge ? "acceptance_request_too_large" : "acceptance_request_invalid",
      rawBody.tooLarge
        ? "The acceptance command body is outside the allowed size."
        : "The acceptance command body is invalid.",
    );
  }

  let payload: unknown;

  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBody.bytes));
  } catch {
    return errorResponse(400, "acceptance_request_invalid", "The acceptance command is invalid.");
  }

  const command = parseHermesStagingAcceptanceCommand(payload);

  if (!command) {
    return errorResponse(400, "acceptance_request_invalid", "The acceptance command is invalid.");
  }

  try {
    if (command.command === "read") {
      const result = await (dependencies.read ?? readHermesStagingAcceptance)(command.runId);

      if (result === null) {
        return errorResponse(404, "acceptance_run_not_found", "The acceptance run was not found.");
      }

      return safeRunResponse(result);
    }

    if (command.command === "advance") {
      const result = await (dependencies.reconcileTarget ?? reconcileTargetHermesStagingAcceptance)(
        command.runId,
      );
      const projection = parseHermesStagingAcceptanceReconcileProjection(result);

      return projection
        ? Response.json({ ok: true, ...projection }, { headers: { "Cache-Control": "no-store" } })
        : contractErrorResponse();
    }

    const result = await (dependencies.command ?? commandHermesStagingAcceptance)(command);
    return safeRunResponse(result);
  } catch {
    return errorResponse(500, "acceptance_command_failed", "The acceptance command failed safely.");
  }
}

async function readBoundedBody(
  request: Request,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean }> {
  if (!request.body) {
    return { ok: false, tooLarge: false };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      totalBytes += value.byteLength;

      if (totalBytes > HERMES_STAGING_ACCEPTANCE_REQUEST_MAX_BYTES) {
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }

      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  } finally {
    reader.releaseLock();
  }

  if (totalBytes === 0) {
    return { ok: false, tooLarge: false };
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, bytes };
}

function safeRunResponse(value: unknown): Response {
  const run = parseHermesStagingAcceptanceSafeProjection(value);

  return run
    ? Response.json({ ok: true, run }, { headers: { "Cache-Control": "no-store" } })
    : contractErrorResponse();
}

function contractErrorResponse(): Response {
  return errorResponse(
    500,
    "acceptance_contract_invalid",
    "Hermes staging acceptance returned an invalid safe projection.",
  );
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
