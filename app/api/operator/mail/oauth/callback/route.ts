import { redirect } from "next/navigation";
import {
  denyFounderGoogleMailAuthorizationForState,
  FounderMailConnectionError,
} from "@/src/server/operators/founder-mail-connection";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const providerError = url.searchParams.get("error");
  try {
    await denyFounderGoogleMailAuthorizationForState(state);
  } catch (error) {
    if (error instanceof FounderMailConnectionError) {
      return redirect(`/operator?mail=${encodeURIComponent(error.code)}#mail`);
    }
    throw error;
  }
  if (providerError) {
    return redirect("/operator?mail=authorization_denied#mail");
  }
  return redirect("/operator?mail=owner_preview_capability_unavailable#mail");
}
