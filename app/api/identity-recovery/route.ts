import { auth } from "@clerk/nextjs/server";
import {
  FounderIdentityRecoveryError,
  getFounderIdentityRecoveryStatusForClerkSubject,
  recoverFounderIdentity,
} from "@/src/server/users/founder-identity-recovery";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  getClerkUserId?: () => Promise<string | null>;
  getStatus?: typeof getFounderIdentityRecoveryStatusForClerkSubject;
  recover?: typeof recoverFounderIdentity;
  readSigningSecret?: () => string | null;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const clerkUserId = await getClerkUserId(dependencies);
  if (!clerkUserId) return authenticationResponse();
  const recovery = await (
    dependencies.getStatus ?? getFounderIdentityRecoveryStatusForClerkSubject
  )(clerkUserId);
  return Response.json({ recovery }, { headers: noStoreHeaders() });
}

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const clerkUserId = await getClerkUserId(dependencies);
  if (!clerkUserId) return authenticationResponse();
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return validationResponse();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("assertion" in value) ||
    typeof value.assertion !== "string" ||
    value.assertion.length === 0 ||
    value.assertion.length > 4_096
  ) {
    return validationResponse();
  }
  const signingSecret = (dependencies.readSigningSecret ?? readIdentityRecoverySigningSecret)();
  if (!signingSecret) {
    return Response.json(
      {
        error: {
          code: "identity_recovery_unavailable",
          message: "Identity recovery is not configured safely.",
        },
      },
      { status: 503, headers: noStoreHeaders() },
    );
  }
  try {
    const recovery = await (dependencies.recover ?? recoverFounderIdentity)({
      replacementClerkUserId: clerkUserId,
      assertion: value.assertion,
      signingSecret,
      now: dependencies.now?.() ?? new Date(),
    });
    return Response.json(
      {
        recovery: {
          state: "recovered",
          recoveredAt: recovery.recoveredAt,
          destination: "/operator",
        },
      },
      { headers: noStoreHeaders() },
    );
  } catch (error) {
    const code =
      error instanceof FounderIdentityRecoveryError ? error.code : "identity_recovery_failed";
    return Response.json(
      {
        error: {
          code,
          message:
            "Recovery was denied. Sign-in state, email, checkout details, and a new Clerk account cannot claim an existing Founder workspace.",
        },
      },
      { status: 403, headers: noStoreHeaders() },
    );
  }
}

async function getClerkUserId(dependencies: RouteDependencies): Promise<string | null> {
  if (dependencies.getClerkUserId) return dependencies.getClerkUserId();
  const { userId } = await auth();
  return userId;
}

function readIdentityRecoverySigningSecret(): string | null {
  const value = process.env.BRUNO_IDENTITY_RECOVERY_SIGNING_SECRET?.trim();
  return value && value.length >= 32 ? value : null;
}

function authenticationResponse(): Response {
  return Response.json(
    { error: { code: "authentication_required", message: "Authentication is required." } },
    { status: 401, headers: noStoreHeaders() },
  );
}

function validationResponse(): Response {
  return Response.json(
    {
      error: {
        code: "identity_recovery_proof_required",
        message: "A bounded identity recovery proof is required.",
      },
    },
    { status: 400, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
