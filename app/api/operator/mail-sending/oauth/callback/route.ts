import { redirect } from "next/navigation";
import {
  denyFounderGoogleMailSendingAuthorizationForState,
  FounderMailSendingConnectionError,
} from "@/src/server/operators/founder-mail-sending-connection";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  try {
    await denyFounderGoogleMailSendingAuthorizationForState(state);
  } catch (error) {
    if (error instanceof FounderMailSendingConnectionError)
      return redirect(`/operator?mail_sending=${encodeURIComponent(error.code)}#mail-sending`);
    throw error;
  }
  if (url.searchParams.get("error")) {
    return redirect("/operator?mail_sending=authorization_denied#mail-sending");
  }
  return redirect("/operator?mail_sending=owner_preview_capability_unavailable#mail-sending");
}
