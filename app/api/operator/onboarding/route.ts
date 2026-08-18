import { getFounderOnboardingForUser } from "@/src/server/operators/founder-onboarding";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return Response.json(
      {
        error: {
          code:
            applicationUser.status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
          message:
            applicationUser.status === 401
              ? "Authentication is required."
              : "Authentication is not configured safely.",
        },
      },
      { status: applicationUser.status, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const onboarding = await getFounderOnboardingForUser(applicationUser.userId);
    return Response.json({ onboarding }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      {
        error: {
          code: "onboarding_unavailable",
          message:
            "Founder onboarding is being reconciled. Refresh to continue from the saved step.",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
