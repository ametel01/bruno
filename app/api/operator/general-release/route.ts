import {
  confirmFounderGeneralReleaseEligibility,
  createFounderGeneralReleaseOperator,
  declineFounderGeneralReleaseOffer,
  FounderGeneralReleaseError,
  getFounderGeneralReleaseActivationForUser,
} from "@/src/server/founder-product-contract/initial-general-release";
import { getDigitalOceanRunnerProvisioningForUser } from "@/src/server/runners/runner-provisioning";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type Dependencies = {
  requireUser?: typeof requireConfiguredApplicationUser;
  getStatus?: typeof getFounderGeneralReleaseActivationForUser;
  confirmEligibility?: typeof confirmFounderGeneralReleaseEligibility;
  createOperator?: typeof createFounderGeneralReleaseOperator;
  declineOffer?: typeof declineFounderGeneralReleaseOffer;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  const status = await (dependencies.getStatus ?? getFounderGeneralReleaseActivationForUser)(
    user.userId,
  );
  return Response.json({ generalRelease: status }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const user = await (dependencies.requireUser ?? requireConfiguredApplicationUser)();
  if (!user.ok) return authenticationResponse(user.status);
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return errorResponse(400, "validation_failed", "Request body must be valid JSON.");
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return errorResponse(400, "validation_failed", "Choose a General Release setup action.");
  }
  const now = dependencies.now?.() ?? deterministicContractNow() ?? new Date();
  try {
    if (payload.action === "confirm_eligibility") {
      const generalRelease = await (
        dependencies.confirmEligibility ?? confirmFounderGeneralReleaseEligibility
      )({
        userId: user.userId,
        serviceBusinessConfirmed: payload.serviceBusinessConfirmed === true,
        geographyCode: typeof payload.geographyCode === "string" ? payload.geographyCode : "",
        now,
      });
      return Response.json({ generalRelease }, { headers: noStoreHeaders() });
    }
    if (payload.action === "create_operator") {
      const createOperator =
        dependencies.createOperator ??
        (deterministicBoundaryAvailable()
          ? (input: { userId: string; now: Date }) =>
              createFounderGeneralReleaseOperator(input, {
                provisionRunner: async (userId) => {
                  const runner = await getDigitalOceanRunnerProvisioningForUser(userId);
                  return runner
                    ? { ok: true, duplicate: true, runner }
                    : { ok: false, reason: "provider_not_configured" };
                },
              })
          : createFounderGeneralReleaseOperator);
      const generalRelease = await createOperator({ userId: user.userId, now });
      return Response.json({ generalRelease }, { status: 201, headers: noStoreHeaders() });
    }
    if (payload.action === "decline_offer") {
      await (dependencies.declineOffer ?? declineFounderGeneralReleaseOffer)(user.userId, now);
      const generalRelease = await (
        dependencies.getStatus ?? getFounderGeneralReleaseActivationForUser
      )(user.userId);
      return Response.json({ generalRelease }, { headers: noStoreHeaders() });
    }
    return errorResponse(400, "validation_failed", "Choose a General Release setup action.");
  } catch (error) {
    if (error instanceof FounderGeneralReleaseError) {
      return errorResponse(error.status, error.code, error.message);
    }
    throw error;
  }
}

function deterministicBoundaryAvailable(): boolean {
  return (
    process.env.BRUNO_AUTH_MODE === "development" &&
    process.env.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE === "deterministic"
  );
}

function deterministicContractNow(): Date | null {
  if (!deterministicBoundaryAvailable()) return null;
  const value = process.env.BRUNO_FOUNDER_CONTRACT_OBSERVED_AT;
  if (!value) return null;
  const observedAt = new Date(value);
  return Number.isNaN(observedAt.valueOf()) ? null : new Date(observedAt.valueOf() + 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function authenticationResponse(status: 401 | 503): Response {
  return errorResponse(
    status,
    status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
    status === 401 ? "Authentication is required." : "Authentication is not configured safely.",
  );
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
