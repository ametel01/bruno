import { redirect } from "next/navigation";
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
        return redirect(`/operator?mail_sending=${encodeURIComponent(error.code)}#mail-sending`);
      throw error;
    }
    return redirect("/operator?mail_sending=authorization_denied#mail-sending");
  }
  if (!(dependencies.isMailSendingReleased ?? isFounderGoogleMailSendingReleased)()) {
    return redirect("/operator?mail_sending=mail_sending_not_released#mail-sending");
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
      return redirect("/operator?mail_sending=owner_preview_capability_unavailable#mail-sending");
    }
    const connection = await (
      dependencies.completeAuthorization ?? completeFounderGoogleMailSendingAuthorizationForState
    )(state, url.searchParams.get("code") ?? "");
    return redirect(
      connection.status === "ready"
        ? "/operator?mail_sending=connected#mail-sending"
        : "/operator?mail_sending=needs_attention#mail-sending",
    );
  } catch (error) {
    if (error instanceof FounderMailSendingConnectionError)
      return redirect(`/operator?mail_sending=${encodeURIComponent(error.code)}#mail-sending`);
    throw error;
  }
}
