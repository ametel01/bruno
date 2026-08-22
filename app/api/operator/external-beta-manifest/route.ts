import {
  getFounderExternalBetaManifestForUser,
  projectFounderExternalBetaManifestStatus,
  unavailableFounderExternalBetaManifestStatus,
} from "@/src/server/founder-product-contract/external-beta-manifest";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type ExternalBetaManifestRouteDependencies = {
  getManifest?: typeof getFounderExternalBetaManifestForUser;
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
  now?: () => Date;
};

export async function GET(
  _request: Request,
  _context?: { params: Promise<unknown> },
  dependencies: ExternalBetaManifestRouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (
    dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
  )();
  if (!applicationUser.ok) {
    return Response.json(
      { error: { code: applicationUser.status === 401 ? "unauthenticated" : "unavailable" } },
      { status: applicationUser.status, headers: noStoreHeaders() },
    );
  }

  try {
    const manifest = await (dependencies.getManifest ?? getFounderExternalBetaManifestForUser)(
      applicationUser.userId,
      dependencies.now?.() ?? new Date(),
    );
    return Response.json(
      { externalBeta: projectFounderExternalBetaManifestStatus(manifest) },
      { headers: noStoreHeaders() },
    );
  } catch {
    return Response.json(
      {
        externalBeta: unavailableFounderExternalBetaManifestStatus(),
      },
      { headers: noStoreHeaders() },
    );
  }
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
