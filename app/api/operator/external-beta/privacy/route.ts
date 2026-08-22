import {
  captureFounderExternalBetaMeasurement,
  decideFounderExternalBetaConsent,
  deleteFounderExternalBetaMeasurements,
  exportFounderExternalBetaPrivacyData,
  FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES,
  getFounderExternalBetaPrivacyStatusForUser,
  type FounderExternalBetaConsentDecision,
  type FounderExternalBetaConsentPurpose,
} from "@/src/server/founder-product-contract/external-beta-privacy";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type RouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  getStatus?: typeof getFounderExternalBetaPrivacyStatusForUser;
  decideConsent?: typeof decideFounderExternalBetaConsent;
  captureMeasurement?: typeof captureFounderExternalBetaMeasurement;
  exportData?: typeof exportFounderExternalBetaPrivacyData;
  deleteMeasurements?: typeof deleteFounderExternalBetaMeasurements;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const privacy = await (dependencies.getStatus ?? getFounderExternalBetaPrivacyStatusForUser)(
    user.userId,
  );
  return Response.json({ privacy }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireApplicationUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const body = await readBody(request);
  if (!body) return errorResponse(400, "external_beta_privacy_request_invalid");
  const now = dependencies.now?.() ?? new Date();
  try {
    if (body.action === "decide_consent") {
      await (dependencies.decideConsent ?? decideFounderExternalBetaConsent)(user.userId, {
        purpose: body.purpose,
        decision: body.decision,
        decidedAt: now,
      });
      const privacy = await (dependencies.getStatus ?? getFounderExternalBetaPrivacyStatusForUser)(
        user.userId,
      );
      return Response.json({ privacy }, { headers: noStoreHeaders() });
    }
    if (body.action === "capture_measurement") {
      await (dependencies.captureMeasurement ?? captureFounderExternalBetaMeasurement)(
        user.userId,
        body.measurement,
        now,
      );
      return Response.json({ accepted: true }, { headers: noStoreHeaders() });
    }
    if (body.action === "export") {
      const privacyExport = await (dependencies.exportData ?? exportFounderExternalBetaPrivacyData)(
        user.userId,
      );
      return Response.json({ privacyExport }, { headers: noStoreHeaders() });
    }
    const deleted = await (
      dependencies.deleteMeasurements ?? deleteFounderExternalBetaMeasurements
    )(user.userId);
    return Response.json({ deleted }, { headers: noStoreHeaders() });
  } catch {
    return errorResponse(409, "external_beta_privacy_transition_unavailable");
  }
}

type RequestBody =
  | {
      action: "decide_consent";
      purpose: FounderExternalBetaConsentPurpose;
      decision: FounderExternalBetaConsentDecision;
    }
  | { action: "capture_measurement"; measurement: unknown }
  | { action: "export" }
  | { action: "delete_measurements" };

async function readBody(request: Request): Promise<RequestBody | null> {
  try {
    const value = (await request.json()) as unknown;
    if (!isRecord(value) || typeof value.action !== "string") return null;
    if (value.action === "decide_consent") {
      if (
        !hasExactKeys(value, ["action", "decision", "purpose"]) ||
        typeof value.purpose !== "string" ||
        !FOUNDER_EXTERNAL_BETA_CONSENT_PURPOSES.includes(
          value.purpose as FounderExternalBetaConsentPurpose,
        ) ||
        (value.decision !== "grant" && value.decision !== "refuse" && value.decision !== "withdraw")
      ) {
        return null;
      }
      return {
        action: value.action,
        purpose: value.purpose as FounderExternalBetaConsentPurpose,
        decision: value.decision,
      };
    }
    if (value.action === "capture_measurement") {
      if (!hasExactKeys(value, ["action", "measurement"])) return null;
      return { action: value.action, measurement: value.measurement };
    }
    if (value.action === "export" || value.action === "delete_measurements") {
      return hasExactKeys(value, ["action"]) ? { action: value.action } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function authenticationResponse(status: number): Response {
  return errorResponse(status, "authentication_required");
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "External Beta privacy controls are unavailable." } },
    { status, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "no-store" };
}
