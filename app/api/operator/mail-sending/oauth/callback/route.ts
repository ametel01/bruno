import { redirect } from "next/navigation";
import { isFounderGoogleMailSendingReleased } from "@/src/server/operators/founder-google-mail-sending-release";
import {
  completeFounderGoogleMailSendingAuthorizationForState,
  denyFounderGoogleMailSendingAuthorizationForState,
  FounderMailSendingConnectionError,
} from "@/src/server/operators/founder-mail-sending-connection";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.get("error")) {
    await denyFounderGoogleMailSendingAuthorizationForState(state);
    return redirect("/operator?mail_sending=authorization_denied#mail-sending");
  }
  if (!isFounderGoogleMailSendingReleased()) {
    return redirect("/operator?mail_sending=mail_sending_not_released#mail-sending");
  }
  try {
    const connection = await completeFounderGoogleMailSendingAuthorizationForState(state, code);
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
