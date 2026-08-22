import { getFounderCommerceStatusForUser } from "@/src/server/commerce/founder-commerce";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type RouteDependencies = {
  requireUser?: typeof requireConfiguredApplicationUser;
  getStatus?: typeof getFounderCommerceStatusForUser;
};

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (dependencies.requireUser ?? requireConfiguredApplicationUser)();
  if (!applicationUser.ok) {
    return Response.json(
      { error: { code: applicationUser.code } },
      { status: applicationUser.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (new URL(request.url).search.length > 0 || request.body !== null) {
    return Response.json(
      { error: { code: "commerce_status_request_invalid" } },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const commerce = await (dependencies.getStatus ?? getFounderCommerceStatusForUser)(
      applicationUser.userId,
    );
    return Response.json({ commerce }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { error: { code: "commerce_status_unavailable" } },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
