import { redirect } from "next/navigation";
import {
  completeFounderGoogleCalendarAuthorizationForState,
  FounderCalendarConnectionError,
} from "@/src/server/operators/founder-calendar-connection";
import { isFounderGoogleCalendarReleased } from "@/src/server/operators/founder-google-reading-release";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const providerError = url.searchParams.get("error");
  if (providerError) {
    return redirect("/operator?calendar=authorization_denied#calendar");
  }
  if (!isFounderGoogleCalendarReleased()) {
    return redirect("/operator?calendar=calendar_reading_not_released#calendar");
  }

  try {
    const connection = await completeFounderGoogleCalendarAuthorizationForState(state, code);
    return redirect(
      connection.status === "selecting"
        ? "/operator?calendar=connected#calendar"
        : "/operator?calendar=needs_attention#calendar",
    );
  } catch (error) {
    if (error instanceof FounderCalendarConnectionError) {
      const query = encodeURIComponent(error.code);
      return redirect(`/operator?calendar=${query}#calendar`);
    }
    throw error;
  }
}
