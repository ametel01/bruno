import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { FounderPrivacyCenter } from "@/app/operator/_components/founder-privacy-center";
import { getFounderPrivacyCenterForUser } from "@/src/server/operators/founder-privacy-center";
import { getFounderDeletionReceiptForUser } from "@/src/server/operators/founder-deletion";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

export default async function FounderPrivacyPage() {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return (
      <FounderOperatorShell activePage="privacy">
        <section aria-labelledby="privacy-auth-title">
          <h2 id="privacy-auth-title">Sign in to continue</h2>
          <p>Authentication is required to open your private Privacy Center.</p>
        </section>
      </FounderOperatorShell>
    );
  }

  const privacy = await getFounderPrivacyCenterForUser(applicationUser.userId);
  if (!privacy) {
    return (
      <FounderOperatorShell activePage="privacy">
        <section aria-labelledby="privacy-empty-title">
          <h2 id="privacy-empty-title">Your Privacy Center is not ready yet</h2>
          <p>
            Bruno creates the Founder workspace before it records connection or retained-data
            details.
          </p>
        </section>
      </FounderOperatorShell>
    );
  }
  const deletion = await getFounderDeletionReceiptForUser(applicationUser.userId);

  return (
    <FounderOperatorShell activePage="privacy">
      <FounderPrivacyCenter initialPrivacy={privacy} initialDeletion={deletion} />
    </FounderOperatorShell>
  );
}
