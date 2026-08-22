import {
  recordFounderCommerceWebhook,
  reconcileFounderCommerceReceipt,
} from "@/src/server/commerce/founder-commerce";
import {
  LemonSqueezyApiProvider,
  type LemonSqueezyCommerceProvider,
  readLemonSqueezyConfig,
} from "@/src/server/commerce/lemon-squeezy-provider";
import {
  LemonSqueezyWebhookRequestError,
  parseVerifiedLemonSqueezyWebhook,
  readBoundedLemonSqueezyWebhookBody,
} from "@/src/server/commerce/lemon-squeezy-webhook";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

type RouteDependencies = {
  createProvider?: () => {
    provider: LemonSqueezyCommerceProvider;
    webhookSecret: string;
    mode: "test" | "live";
  } | null;
  now?: () => Date;
  record?: typeof recordFounderCommerceWebhook;
  reconcile?: typeof reconcileFounderCommerceReceipt;
};

export async function POST(
  request: Request,
  _context?: unknown,
  dependencies: RouteDependencies = {},
): Promise<Response> {
  if (new URL(request.url).search.length > 0) return errorResponse(400, "webhook_request_invalid");
  let boundary: ReturnType<NonNullable<RouteDependencies["createProvider"]>>;
  try {
    boundary =
      dependencies.createProvider?.() ??
      (() => {
        const config = readLemonSqueezyConfig();
        return config
          ? {
              provider: new LemonSqueezyApiProvider({ config }),
              webhookSecret: config.webhookSecret,
              mode: config.mode,
            }
          : null;
      })();
  } catch {
    return errorResponse(503, "webhook_configuration_invalid");
  }
  if (!boundary) return errorResponse(503, "webhook_unavailable");
  const now = dependencies.now?.() ?? new Date();
  try {
    const rawBody = await readBoundedLemonSqueezyWebhookBody(request);
    const webhook = parseVerifiedLemonSqueezyWebhook({
      rawBody,
      signature: request.headers.get("x-signature"),
      headerEventName: request.headers.get("x-event-name"),
      webhookSecret: boundary.webhookSecret,
      expectedMode: boundary.mode,
    });
    const receipt = await (dependencies.record ?? recordFounderCommerceWebhook)({
      webhook,
      recordedAt: now,
    });
    if (!receipt.terminal) {
      await (dependencies.reconcile ?? reconcileFounderCommerceReceipt)({
        receiptId: receipt.receiptId,
        now,
        provider: boundary.provider,
      });
    }
    return Response.json(
      { ok: true, accepted: true },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof LemonSqueezyWebhookRequestError) {
      return errorResponse(error.code === "webhook_body_too_large" ? 413 : 401, error.code);
    }
    return errorResponse(409, "webhook_delivery_rejected");
  }
}

function errorResponse(status: number, code: string): Response {
  return Response.json(
    { error: { code, message: "Commerce delivery was rejected safely." } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
