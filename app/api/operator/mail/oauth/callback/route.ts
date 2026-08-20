import { redirect } from "next/navigation";
import { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-google-reading-release";
import {
  completeFounderGoogleMailAuthorizationForState,
  denyFounderGoogleMailAuthorizationForState,
  FounderMailConnectionError,
} from "@/src/server/operators/founder-mail-connection";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const providerError = url.searchParams.get("error");
  if (providerError) {
    await denyFounderGoogleMailAuthorizationForState(state);
    return redirect("/operator?mail=authorization_denied#mail");
  }
  if (!isFounderGoogleMailReadingReleased()) {
    return redirect("/operator?mail=mail_reading_not_released#mail");
  }

  try {
    const connection = await completeFounderGoogleMailAuthorizationForState(state, code);
    return redirect(
      connection.status === "selecting"
        ? "/operator?mail=connected#mail"
        : "/operator?mail=needs_attention#mail",
    );
  } catch (error) {
    if (error instanceof FounderMailConnectionError) {
      const query = encodeURIComponent(error.code);
      return redirect(`/operator?mail=${query}#mail`);
    }
    throw error;
  }
}
