import { redirect } from "next/navigation";
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
