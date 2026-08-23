import { FounderExternalBeta } from "@/app/operator/_components/founder-external-beta";
import { FounderExternalBetaManifest } from "@/app/operator/_components/founder-external-beta-manifest";
import { FounderGeneralRelease } from "@/app/operator/_components/founder-general-release";
import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import { readFounderApplicationRevision } from "@/src/server/founder-product-contract/application-revision";
import { getFounderExternalBetaStatusForUser } from "@/src/server/founder-product-contract/external-beta-admission";
import { getFounderExternalBetaManifestStatusForUser } from "@/src/server/founder-product-contract/external-beta-manifest";
import { getFounderExternalBetaPrivacyStatusForUser } from "@/src/server/founder-product-contract/external-beta-privacy";
import { getFounderInfrastructureRetirementStatusForUser } from "@/src/server/founder-product-contract/infrastructure-retirement";
import { getFounderGeneralReleaseActivationForUser } from "@/src/server/founder-product-contract/initial-general-release";
import { projectFounderOwnerPreviewStatus } from "@/src/server/founder-product-contract/owner-preview-status";
import { FOUNDER_OWNER_PREVIEW_CAPABILITIES } from "@/src/server/founder-product-contract/preview-qualification";
import {
  getFounderRecoveryArchiveStatusForUser,
  unavailableFounderRecoveryArchiveStatus,
} from "@/src/server/founder-product-contract/recovery-archive";
import {
  getFounderOwnerPreviewAccessForUser,
  hasFounderOwnerPreviewCapabilities,
  requiresFounderReleaseStageAuthority,
} from "@/src/server/founder-product-contract/release-stage-access";
import { isFounderAnthropicReleased } from "@/src/server/operators/founder-anthropic-release";
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
  const resolvedSearchParams = await searchParams;
  const trustedPreviewInvitationToken = readTrustedPreviewInvitationToken(resolvedSearchParams);
  const externalBetaInvitation = readExternalBetaInvitation(resolvedSearchParams);
  const applicationRevision = readFounderApplicationRevision();
  const authMode = resolveAuthMode(process.env).mode;
  const requestedExperience = resolvedSearchParams.experience;
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
    externalBetaAccess,
    externalBetaPrivacy,
    generalReleaseStatus,
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
    applicationRevision
      ? getFounderExternalBetaStatusForUser(applicationUser.userId, new Date(), {
          applicationRevision,
        })
      : Promise.resolve({ state: "unavailable" as const }),
    getFounderExternalBetaPrivacyStatusForUser(applicationUser.userId),
    getFounderGeneralReleaseActivationForUser(applicationUser.userId),
  ]);
  const calendarReadingReleased = isFounderGoogleCalendarReleased();
  const mailReadingReleased = isFounderGoogleMailReadingReleased();
  const mailSendingReleased = isFounderGoogleMailSendingReleased();
  const openAiReleased = isFounderOpenAiReleased();
  const anthropicReleased = isFounderAnthropicReleased();
  const generalReleaseSetupAvailable = [
    "setup",
    "waitlisted",
    "provisioning",
    "activation_pending",
  ].includes(generalReleaseStatus.state);
  const generalReleaseBriefInspectable = generalReleaseStatus.state === "activated";
  const generalReleaseWorkspaceAvailable = generalReleaseStatus.state === "entitled";

  return (
    <FounderOperatorShell>
      {generalReleaseStatus.admission.capacity !== "unavailable" ||
      generalReleaseStatus.setup.serviceBusinessConfirmed ||
      generalReleaseStatus.release.decisionState === "held" ? (
        <FounderGeneralRelease initialStatus={generalReleaseStatus} />
      ) : null}
      <FounderExternalBeta
        initialStatus={externalBetaAccess}
        initialPrivacy={externalBetaPrivacy}
        {...(externalBetaInvitation
          ? {
              invitationToken: externalBetaInvitation.invitationToken,
              workspaceReference: externalBetaInvitation.workspaceReference,
            }
          : {})}
      />
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
        anthropicReleased={anthropicReleased}
        generalReleaseSetupAvailable={generalReleaseSetupAvailable}
        generalReleaseBriefInspectable={generalReleaseBriefInspectable}
        generalReleaseWorkspaceAvailable={generalReleaseWorkspaceAvailable}
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

function readExternalBetaInvitation(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): { invitationToken: string; workspaceReference: string } | undefined {
  const invitationToken = searchParams?.external_beta_invitation;
  const workspaceReference = searchParams?.external_beta_workspace;
  return typeof invitationToken === "string" &&
    /^[A-Za-z0-9_-]{43,128}$/.test(invitationToken) &&
    typeof workspaceReference === "string" &&
    workspaceReference.length > 0 &&
    workspaceReference.length <= 200
    ? { invitationToken, workspaceReference }
    : undefined;
}

function readTrustedPreviewInvitationToken(
  searchParams: Record<string, string | string[] | undefined> | undefined,
): string | undefined {
  const value = searchParams?.trusted_preview_invitation;
  return typeof value === "string" && /^[A-Za-z0-9_-]{43,128}$/.test(value) ? value : undefined;
}
