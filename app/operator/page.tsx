import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import {
  FOUNDER_GOOGLE_MAIL_RELEASE_CONTROLS,
  isFounderGoogleMailReadingReleased,
  REQUIRED_MAIL_SCOPE,
} from "@/src/server/operators/founder-mail-connection";
import { getFounderOnboardingForUser } from "@/src/server/operators/founder-onboarding";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { buildFounderTimezoneOptions } from "@/src/shared/founder-timezones";

export const dynamic = "force-dynamic";

export default async function FounderOperatorPage() {
  const applicationUser = await requireConfiguredApplicationUser();

  if (!applicationUser.ok) {
    return (
      <FounderOperatorShell>
        <section aria-labelledby="operator-auth-title">
          <h2 id="operator-auth-title">Sign in to continue</h2>
          <p>Authentication is required to open your private Founder workspace.</p>
        </section>
      </FounderOperatorShell>
    );
  }

  const operator = await ensureFounderOperatorForUser(applicationUser.userId);
  const onboarding = await getFounderOnboardingForUser(applicationUser.userId);
  const mailReadingReleased = isFounderGoogleMailReadingReleased();

  return (
    <FounderOperatorShell>
      <FounderOperatorPreparation
        initialOperator={operator}
        initialOnboarding={onboarding}
        timezoneOptions={buildFounderTimezoneOptions()}
        mailReadingReleased={mailReadingReleased}
        mailReleaseControls={
          mailReadingReleased
            ? {
                qualified: true,
                requiredScope: REQUIRED_MAIL_SCOPE,
                ...FOUNDER_GOOGLE_MAIL_RELEASE_CONTROLS,
              }
            : undefined
        }
      />
    </FounderOperatorShell>
  );
}
