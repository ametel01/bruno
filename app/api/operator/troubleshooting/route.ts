import {
  approveFounderTroubleshootingCaseForUser,
  closeFounderTroubleshootingCaseForUser,
  getFounderTroubleshootingForUser,
  FounderTroubleshootingError,
} from "@/src/server/operators/founder-troubleshooting";
import { requireRecentFounderAuthentication } from "@/src/server/operators/founder-recent-authentication";
import { isFounderRecoveryCapability } from "@/src/server/operators/founder-recovery";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import {
  createFounderRepairProposalForSupport,
  createFounderSupportAccessGrantForUser,
  decideFounderRepairProposalForUser,
  executeFounderRepairProposalForUser,
  getFounderSupportForUser,
  invokeFounderSupportTool,
  revokeFounderSupportAccessGrantForUser,
  FounderSupportError,
  type FounderSupportRepairKind,
  type FounderSupportScope,
  type FounderSupportTool,
} from "@/src/server/operators/founder-support";

export const dynamic = "force-dynamic";

type TroubleshootingRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getTroubleshooting?: typeof getFounderTroubleshootingForUser;
  approveCase?: typeof approveFounderTroubleshootingCaseForUser;
  closeCase?: typeof closeFounderTroubleshootingCaseForUser;
  requireRecentAuth?: (request: Request) => Promise<boolean>;
  getSupport?: typeof getFounderSupportForUser;
  grantAccess?: typeof createFounderSupportAccessGrantForUser;
  revokeAccess?: typeof revokeFounderSupportAccessGrantForUser;
  proposeRepair?: typeof createFounderRepairProposalForSupport;
  decideRepair?: typeof decideFounderRepairProposalForUser;
  executeRepair?: typeof executeFounderRepairProposalForUser;
  invokeTool?: typeof invokeFounderSupportTool;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: TroubleshootingRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const requested = new URL(request.url).searchParams.get("capability");
  const capability = isFounderRecoveryCapability(requested) ? requested : null;
  const troubleshooting = await (
    dependencies.getTroubleshooting ?? getFounderTroubleshootingForUser
  )(user.userId, capability);
  const support = dependencies.getSupport
    ? await dependencies.getSupport(user.userId)
    : dependencies.getTroubleshooting
      ? undefined
      : await getFounderSupportForUser(user.userId);
  return Response.json(
    { troubleshooting, ...(support ? { support } : {}) },
    { headers: noStoreHeaders() },
  );
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: TroubleshootingRouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return validationResponse("Choose a Troubleshooting action.");
  }
  const actions = [
    "approve_case",
    "close_case",
    "grant_access",
    "revoke_access",
    "propose_repair",
    "decide_repair",
    "execute_repair",
    "invoke_tool",
  ];
  if (!actions.includes(payload.action)) {
    return validationResponse("Choose a supported Troubleshooting action.");
  }
  if (
    payload.action === "approve_case" ||
    payload.action === "close_case" ||
    payload.action === "grant_access" ||
    payload.action === "propose_repair"
  ) {
    if (typeof payload.incidentId !== "string" || !payload.incidentId.trim()) {
      return validationResponse("A Troubleshooting Incident is required.");
    }
  }
  const incidentId = typeof payload.incidentId === "string" ? payload.incidentId.trim() : "";
  const recentAuth = await (
    dependencies.requireRecentAuth ??
    ((currentRequest: Request) =>
      requireRecentFounderAuthentication(currentRequest, "/api/operator/troubleshooting"))
  )(request);
  if (!recentAuth) return recentAuthenticationResponse();

  try {
    if (payload.action === "approve_case" || payload.action === "close_case") {
      const incident =
        payload.action === "approve_case"
          ? await (dependencies.approveCase ?? approveFounderTroubleshootingCaseForUser)(
              user.userId,
              incidentId,
            )
          : await (dependencies.closeCase ?? closeFounderTroubleshootingCaseForUser)(
              user.userId,
              incidentId,
            );
      return Response.json({ incident }, { headers: noStoreHeaders() });
    }
    if (payload.action === "grant_access") {
      const grant = await (dependencies.grantAccess ?? createFounderSupportAccessGrantForUser)(
        user.userId,
        {
          incidentId,
          supportActorName:
            typeof payload.supportActorName === "string" ? payload.supportActorName : "",
          supportActorIdentity:
            typeof payload.supportActorIdentity === "string" ? payload.supportActorIdentity : "",
          mfaAuthenticated: payload.mfaAuthenticated === true,
          scope: payload.scope as FounderSupportScope,
          ttlMinutes:
            typeof payload.ttlMinutes === "number"
              ? payload.ttlMinutes
              : Number(payload.ttlMinutes),
        },
      );
      return Response.json({ grant }, { headers: noStoreHeaders() });
    }
    if (payload.action === "revoke_access") {
      if (typeof payload.grantId !== "string" || !payload.grantId.trim())
        return validationResponse("A Support Access Grant is required.");
      const grant = await (dependencies.revokeAccess ?? revokeFounderSupportAccessGrantForUser)(
        user.userId,
        payload.grantId.trim(),
      );
      return Response.json({ grant }, { headers: noStoreHeaders() });
    }
    if (payload.action === "propose_repair") {
      const grant = typeof payload.grantId === "string" ? payload.grantId.trim() : "";
      if (!grant || !isRecord(payload.target))
        return validationResponse("A grant and exact Repair Proposal target are required.");
      const proposal = await (dependencies.proposeRepair ?? createFounderRepairProposalForSupport)(
        grant,
        {
          incidentId,
          kind: payload.kind as FounderSupportRepairKind,
          target: payload.target,
          supportActorIdentity:
            typeof payload.supportActorIdentity === "string" ? payload.supportActorIdentity : "",
          supportAccessToken:
            typeof payload.supportAccessToken === "string" ? payload.supportAccessToken : "",
        },
      );
      return Response.json({ proposal }, { headers: noStoreHeaders() });
    }
    if (payload.action === "decide_repair") {
      if (
        typeof payload.proposalId !== "string" ||
        typeof payload.proposalDigest !== "string" ||
        (payload.decision !== "approve" && payload.decision !== "decline")
      )
        return validationResponse("The exact Repair Proposal and a Founder decision are required.");
      const proposal = await (dependencies.decideRepair ?? decideFounderRepairProposalForUser)(
        user.userId,
        {
          proposalId: payload.proposalId.trim(),
          proposalDigest: payload.proposalDigest,
          decision: payload.decision,
        },
      );
      return Response.json({ proposal }, { headers: noStoreHeaders() });
    }
    if (payload.action === "execute_repair") {
      if (typeof payload.proposalId !== "string" || !payload.proposalId.trim())
        return validationResponse("A Repair Proposal is required.");
      const proposal = await (dependencies.executeRepair ?? executeFounderRepairProposalForUser)(
        user.userId,
        payload.proposalId.trim(),
      );
      return Response.json({ proposal }, { headers: noStoreHeaders() });
    }
    if (payload.action === "invoke_tool") {
      if (
        typeof payload.grantId !== "string" ||
        typeof payload.incidentId !== "string" ||
        typeof payload.tool !== "string"
      )
        return validationResponse("A grant, incident, and typed support tool are required.");
      const result = await (dependencies.invokeTool ?? invokeFounderSupportTool)(
        payload.grantId.trim(),
        {
          tool: payload.tool as FounderSupportTool,
          incidentId,
          supportActorIdentity:
            typeof payload.supportActorIdentity === "string" ? payload.supportActorIdentity : "",
          supportAccessToken:
            typeof payload.supportAccessToken === "string" ? payload.supportAccessToken : "",
          arguments: isRecord(payload.arguments) ? payload.arguments : {},
        },
      );
      return Response.json({ result }, { headers: noStoreHeaders() });
    }
    throw new Error("Unsupported Troubleshooting action.");
  } catch (error) {
    if (error instanceof FounderTroubleshootingError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    if (error instanceof FounderSupportError) {
      return Response.json(
        { error: { code: error.code, message: error.message } },
        { status: error.status, headers: noStoreHeaders() },
      );
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function authenticationResponse(status: 401 | 503): Response {
  return Response.json(
    {
      error: {
        code: status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
        message:
          status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status, headers: noStoreHeaders() },
  );
}

function validationResponse(message: string): Response {
  return Response.json(
    { error: { code: "validation_failed", message } },
    { status: 400, headers: noStoreHeaders() },
  );
}

function recentAuthenticationResponse(): Response {
  return Response.json(
    {
      error: {
        code: "recent_authentication_required",
        message: "Sign in again before attaching or closing a Troubleshooting Incident.",
      },
    },
    { status: 401, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
