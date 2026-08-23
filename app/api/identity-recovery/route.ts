import { auth } from "@clerk/nextjs/server";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { resolveFounderContractIdentity } from "@/src/server/founder-product-contract/deterministic-identity";
import {
  FounderIdentityRecoveryError,
  getFounderIdentityRecoveryStatusForClerkSubject,
  recoverFounderIdentityWithCredential,
} from "@/src/server/users/founder-identity-recovery";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  getClerkUserId?: () => Promise<string | null>;
  getStatus?: typeof getFounderIdentityRecoveryStatusForClerkSubject;
  recover?: typeof recoverFounderIdentityWithCredential;
  readSigningSecret?: () => string | null;
  now?: () => Date;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const clerkUserId = await getClerkUserId(request, dependencies);
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
  const clerkUserId = await getClerkUserId(request, dependencies);
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
    Object.keys(value).length !== 1 ||
    !("recoveryCode" in value) ||
    typeof value.recoveryCode !== "string" ||
    value.recoveryCode.length === 0 ||
    value.recoveryCode.length > 256
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
  let recovered: { ownerId: string; recoveredAt: string };
  try {
    recovered = await (dependencies.recover ?? recoverFounderIdentityWithCredential)({
      replacementClerkUserId: clerkUserId,
      recoveryCode: value.recoveryCode,
      signingSecret,
      now: dependencies.now?.() ?? new Date(),
    });
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
  try {
    const recovery = await (
      dependencies.getStatus ?? getFounderIdentityRecoveryStatusForClerkSubject
    )(clerkUserId);
    if (recovery.state !== "recovered" || recovery.recoveredAt !== recovered.recoveredAt) {
      throw new Error("Recovered identity state was not observable.");
    }
    return Response.json(
      {
        recovery: { ...recovery, destination: "/operator" },
      },
      { headers: noStoreHeaders() },
    );
  } catch {
    return Response.json(
      {
        error: {
          code: "identity_recovery_receipts_unavailable",
          message:
            "Identity was recovered, but its receipts are temporarily unavailable. Reload this page before retrying recovery.",
        },
      },
      { status: 503, headers: noStoreHeaders() },
    );
  }
}

async function getClerkUserId(
  request: Request,
  dependencies: RouteDependencies,
): Promise<string | null> {
  if (dependencies.getClerkUserId) return dependencies.getClerkUserId();
  const contractIdentity = resolveFounderContractIdentity(request.headers);
  if (contractIdentity.present) {
    return contractIdentity.valid ? contractIdentity.subject : null;
  }
  if (resolveAuthMode(process.env).mode !== "clerk") return null;
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
        message: "A one-time Identity Recovery code is required.",
      },
    },
    { status: 400, headers: noStoreHeaders() },
  );
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
