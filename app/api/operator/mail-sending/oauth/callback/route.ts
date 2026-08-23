import { hasFounderGeneralReleaseSetupAccessForUser } from "@/src/server/founder-product-contract/initial-general-release";
import {
  completeFounderGoogleMailSendingAuthorizationForState,
  denyFounderGoogleMailSendingAuthorizationForState,
  FounderMailSendingConnectionError,
  isFounderGoogleMailSendingReleased,
  resolveFounderGoogleMailSendingAuthorizationUserForState,
} from "@/src/server/operators/founder-mail-sending-connection";

type Dependencies = {
  completeAuthorization?: typeof completeFounderGoogleMailSendingAuthorizationForState;
  denyAuthorization?: typeof denyFounderGoogleMailSendingAuthorizationForState;
  hasGeneralReleaseSetupAccess?: typeof hasFounderGeneralReleaseSetupAccessForUser;
  isMailSendingReleased?: () => boolean;
  resolveAuthorizationUser?: typeof resolveFounderGoogleMailSendingAuthorizationUserForState;
};

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  _context?: unknown,
  dependencies: Dependencies = {},
): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  if (url.searchParams.get("error")) {
    try {
      await (dependencies.denyAuthorization ?? denyFounderGoogleMailSendingAuthorizationForState)(
        state,
      );
    } catch (error) {
      if (error instanceof FounderMailSendingConnectionError)
        return redirectToOperator(request, error.code);
      throw error;
    }
    return redirectToOperator(request, "authorization_denied");
  }
  if (!(dependencies.isMailSendingReleased ?? isFounderGoogleMailSendingReleased)()) {
    return redirectToOperator(request, "mail_sending_not_released");
  }
  try {
    const userId = await (
      dependencies.resolveAuthorizationUser ??
      resolveFounderGoogleMailSendingAuthorizationUserForState
    )(state);
    const hasAccess = await (
      dependencies.hasGeneralReleaseSetupAccess ?? hasFounderGeneralReleaseSetupAccessForUser
    )(userId, {}, ["gmail_sending"]);
    if (!hasAccess) {
      return redirectToOperator(request, "owner_preview_capability_unavailable");
    }
    const connection = await (
      dependencies.completeAuthorization ?? completeFounderGoogleMailSendingAuthorizationForState
    )(state, url.searchParams.get("code") ?? "");
    return redirectToOperator(
      request,
      connection.status === "ready" ? "connected" : "needs_attention",
    );
  } catch (error) {
    if (error instanceof FounderMailSendingConnectionError)
      return redirectToOperator(request, error.code);
    throw error;
  }
}

function redirectToOperator(request: Request, outcome: string): Response {
  const destination = new URL("/operator", request.url);
  destination.searchParams.set("mail_sending", outcome);
  destination.hash = "mail-sending";
  return Response.redirect(destination, 303);
}
