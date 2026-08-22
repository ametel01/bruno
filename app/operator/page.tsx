import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { requireExecutingFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { getFounderRecoveryArchiveStatusForUser } from "@/src/server/founder-product-contract/recovery-archive";
import {
  getFounderOwnerPreviewAccessForUser,
  hasFounderOwnerPreviewCapabilities,
  requiresFounderReleaseStageAuthority,
} from "@/src/server/founder-product-contract/release-stage-access";
import { isFounderGoogleMailSendingReleased } from "@/src/server/operators/founder-google-mail-sending-release";
import {
  isFounderGoogleCalendarReleased,
  isFounderGoogleMailReadingReleased,
} from "@/src/server/operators/founder-google-reading-release";
import {
  FOUNDER_GOOGLE_MAIL_RELEASE_CONTROLS,
  REQUIRED_MAIL_SCOPE,
} from "@/src/server/operators/founder-mail-connection";
import { getFounderOnboardingForUser } from "@/src/server/operators/founder-onboarding";
import { isFounderOpenAiReleased } from "@/src/server/operators/founder-openai-release";
import { getFounderOperatorForUser } from "@/src/server/operators/founder-operator";
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

  const operator = await getFounderOperatorForUser(applicationUser.userId);
  const applicationRevision = requireExecutingFounderApplicationRevision();
  const [onboarding, recoveryArchive, ownerPreviewAccess] = await Promise.all([
    operator ? getFounderOnboardingForUser(applicationUser.userId) : Promise.resolve(undefined),
    getFounderRecoveryArchiveStatusForUser(applicationUser.userId, new Date(), {
      applicationRevision,
    }),
    requiresFounderReleaseStageAuthority(resolveAuthMode(process.env).mode)
      ? getFounderOwnerPreviewAccessForUser(applicationUser.userId, new Date())
      : Promise.resolve({
          admitted: true,
          availableCapabilities: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
        }),
  ]);
  const calendarReadingReleased = isFounderGoogleCalendarReleased();
  const mailReadingReleased = isFounderGoogleMailReadingReleased();
  const mailSendingReleased = isFounderGoogleMailSendingReleased();
  const openAiReleased = isFounderOpenAiReleased();

  return (
    <FounderOperatorShell>
      <FounderOperatorPreparation
        initialOperator={operator}
        {...(onboarding ? { initialOnboarding: onboarding } : {})}
        initialRecoveryArchive={recoveryArchive}
        ownerPreviewAdmitted={ownerPreviewAccess.admitted}
        ownerPreviewWorkAllowed={hasFounderOwnerPreviewCapabilities(
          ownerPreviewAccess,
          FOUNDER_OWNER_PREVIEW_CAPABILITIES,
        )}
        timezoneOptions={buildFounderTimezoneOptions()}
        openAiReleased={openAiReleased}
        calendarReadingReleased={calendarReadingReleased}
        mailReadingReleased={mailReadingReleased}
        mailSendingReleased={mailSendingReleased}
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
