import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderExternalBetaManifest } from "@/app/operator/_components/founder-external-beta-manifest";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { getFounderInfrastructureRetirementStatusForUser } from "@/src/server/founder-product-contract/infrastructure-retirement";
import { getFounderExternalBetaManifestStatusForUser } from "@/src/server/founder-product-contract/external-beta-manifest";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import { projectFounderOwnerPreviewStatus } from "@/src/server/founder-product-contract/owner-preview-status";
import {
  getFounderRecoveryArchiveStatusForUser,
  unavailableFounderRecoveryArchiveStatus,
} from "@/src/server/founder-product-contract/recovery-archive";
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
import { resolveFounderOperatorExperience } from "@/src/shared/founder-operator-experience";
import { buildFounderTimezoneOptions } from "@/src/shared/founder-timezones";

export const dynamic = "force-dynamic";

export default async function FounderOperatorPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
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
  const trustedPreviewInvitationToken = readTrustedPreviewInvitationToken(await searchParams);
  const applicationRevision = readFounderApplicationRevision();
  const authMode = resolveAuthMode(process.env).mode;
  const requestedExperience = (await searchParams).experience;
  const experience = resolveFounderOperatorExperience({
    authMode,
    nodeEnvironment: process.env.NODE_ENV,
    requestedExperience: Array.isArray(requestedExperience)
      ? requestedExperience[0]
      : requestedExperience,
  });
  const [
    onboarding,
    recoveryArchive,
    infrastructureRetirement,
    ownerPreviewAccess,
    externalBetaStatus,
  ] = await Promise.all([
    operator ? getFounderOnboardingForUser(applicationUser.userId) : Promise.resolve(undefined),
    applicationRevision
      ? getFounderRecoveryArchiveStatusForUser(applicationUser.userId, new Date(), {
          applicationRevision,
        })
      : Promise.resolve(unavailableFounderRecoveryArchiveStatus()),
    getFounderInfrastructureRetirementStatusForUser(applicationUser.userId),
    requiresFounderReleaseStageAuthority(authMode)
      ? getFounderOwnerPreviewAccessForUser(applicationUser.userId, new Date())
      : Promise.resolve({
          admitted: true,
          availableCapabilities: FOUNDER_OWNER_PREVIEW_CAPABILITIES,
        }),
    getFounderExternalBetaManifestStatusForUser(applicationUser.userId, new Date()),
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
        initialInfrastructureRetirement={infrastructureRetirement}
        ownerPreviewAdmitted={ownerPreviewAccess.admitted}
        ownerPreviewWorkAllowed={hasFounderOwnerPreviewCapabilities(
          ownerPreviewAccess,
          FOUNDER_OWNER_PREVIEW_CAPABILITIES,
        )}
        ownerPreview={projectFounderOwnerPreviewStatus(ownerPreviewAccess)}
        experience={experience}
        {...(trustedPreviewInvitationToken ? { trustedPreviewInvitationToken } : {})}
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
      <FounderExternalBetaManifest status={externalBetaStatus} />
    </FounderOperatorShell>
  );
}

function readTrustedPreviewInvitationToken(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = searchParams?.trusted_preview_invitation;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value) ? value : undefined;
}
