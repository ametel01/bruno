import { createFounderCheckout } from "@/src/server/commerce/founder-commerce";
import {
  LemonSqueezyApiProvider,
  type LemonSqueezyCommerceProvider,
  readLemonSqueezyConfig,
} from "@/src/server/commerce/lemon-squeezy-provider";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

type RouteDependencies = {
  requireUser?: typeof requireConfiguredApplicationUser;
  createProvider?: () => LemonSqueezyCommerceProvider | null;
  createCheckout?: typeof createFounderCheckout;
  now?: () => Date;
  appUrl?: () => string | null;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  const applicationUser = await (dependencies.requireUser ?? requireConfiguredApplicationUser)();
  if (!applicationUser.ok) {
    return errorResponse(applicationUser.status, applicationUser.code);
  }
  if (new URL(request.url).search.length > 0) {
    return errorResponse(400, "checkout_request_invalid");
  }
  let provider: LemonSqueezyCommerceProvider | null;
  let appUrl: string | null;
  try {
    provider =
      dependencies.createProvider?.() ??
      (() => {
        const config = readLemonSqueezyConfig();
        return config ? new LemonSqueezyApiProvider({ config }) : null;
      })();
    appUrl = dependencies.appUrl?.() ?? process.env.NEXT_PUBLIC_APP_URL?.trim() ?? null;
  } catch {
    return errorResponse(503, "commerce_configuration_invalid");
  }
  if (!provider || !appUrl) return errorResponse(503, "commerce_unavailable");
  try {
    const checkout = await (dependencies.createCheckout ?? createFounderCheckout)({
      userId: applicationUser.userId,
      appUrl,
      now: dependencies.now?.() ?? new Date(),
      provider,
    });
    return new Response(null, {
      status: 303,
      headers: { Location: checkout.checkoutUrl, "Cache-Control": "no-store" },
    });
  } catch {
    return errorResponse(409, "checkout_unavailable");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Checkout is not available safely right now." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
