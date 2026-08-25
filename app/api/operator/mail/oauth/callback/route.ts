import {
  completeFounderGoogleMailAuthorizationForState,
  denyFounderGoogleMailAuthorizationForState,
  FounderMailConnectionError,
  isFounderGoogleMailReadingReleased,
} from "@/src/server/operators/founder-mail-connection";

type Dependencies = {
  completeAuthorization?: typeof completeFounderGoogleMailAuthorizationForState;
  denyAuthorization?: typeof denyFounderGoogleMailAuthorizationForState;
  isMailReadingReleased?: () => boolean;
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
      await (dependencies.denyAuthorization ?? denyFounderGoogleMailAuthorizationForState)(state);
    } catch (error) {
      if (error instanceof FounderMailConnectionError)
        return redirectToOperator(request, error.code);
      throw error;
    }
    return redirectToOperator(request, "authorization_denied");
  }
  if (!(dependencies.isMailReadingReleased ?? isFounderGoogleMailReadingReleased)()) {
    return redirectToOperator(request, "mail_reading_not_released");
  }
  try {
    const connection = await (
      dependencies.completeAuthorization ?? completeFounderGoogleMailAuthorizationForState
    )(state, url.searchParams.get("code") ?? "");
    return redirectToOperator(
      request,
      connection.status === "selecting" ? "connected" : "needs_attention",
    );
  } catch (error) {
    if (error instanceof FounderMailConnectionError) return redirectToOperator(request, error.code);
    throw error;
  }
}

function redirectToOperator(request: Request, outcome: string): Response {
  const destination = new URL("/operator", request.url);
  destination.searchParams.set("mail", outcome);
  destination.hash = "mail";
  return Response.redirect(destination, 303);
}
