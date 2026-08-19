import {
  createFounderRepairProposalForSupport,
  invokeFounderSupportTool,
  FounderSupportError,
  type FounderSupportRepairKind,
  type FounderSupportTool,
} from "@/src/server/operators/founder-support";

export const dynamic = "force-dynamic";

/**
 * The support actor never receives a Founder session. The grant itself is the
 * narrow capability and the actor identity/MFA assertion is checked again by
 * the typed support service.
 */
export async function POST(request: Request): Promise<Response> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return response(
      { code: "validation_failed", message: "Request body must be valid JSON." },
      400,
    );
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return response({ code: "validation_failed", message: "Choose a typed support action." }, 400);
  }
  try {
    if (
      typeof payload.grantId !== "string" ||
      typeof payload.incidentId !== "string" ||
      typeof payload.supportActorIdentity !== "string" ||
      typeof payload.supportAccessToken !== "string" ||
      !payload.supportAccessToken
    ) {
      return response(
        {
          code: "validation_failed",
          message: "The named MFA-authenticated support actor is required.",
        },
        400,
      );
    }
    if (payload.action === "invoke_tool") {
      if (typeof payload.tool !== "string")
        return response(
          { code: "validation_failed", message: "Choose an allowlisted support tool." },
          400,
        );
      const result = await invokeFounderSupportTool(payload.grantId, {
        tool: payload.tool as FounderSupportTool,
        incidentId: payload.incidentId,
        supportActorIdentity: payload.supportActorIdentity,
        supportAccessToken: payload.supportAccessToken,
        arguments: isRecord(payload.arguments) ? payload.arguments : {},
      });
      return Response.json({ result }, { headers: noStoreHeaders() });
    }
    if (payload.action === "propose_repair") {
      if (!isRecord(payload.target) || typeof payload.kind !== "string")
        return response(
          { code: "validation_failed", message: "A typed Repair Proposal target is required." },
          400,
        );
      const proposal = await createFounderRepairProposalForSupport(payload.grantId, {
        incidentId: payload.incidentId,
        kind: payload.kind as FounderSupportRepairKind,
        target: payload.target,
        supportActorIdentity: payload.supportActorIdentity,
        supportAccessToken: payload.supportAccessToken,
      });
      return Response.json({ proposal }, { headers: noStoreHeaders() });
    }
    return response({ code: "validation_failed", message: "Choose a typed support action." }, 400);
  } catch (error) {
    if (error instanceof FounderSupportError)
      return response({ code: error.code, message: error.message }, error.status);
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function response(error: { code: string; message: string }, status: number): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
