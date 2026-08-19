import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { FounderTroubleshooting } from "@/app/operator/_components/founder-troubleshooting";
import { getFounderTroubleshootingForUser } from "@/src/server/operators/founder-troubleshooting";
import { getFounderSupportForUser } from "@/src/server/operators/founder-support";
import { isFounderRecoveryCapability } from "@/src/server/operators/founder-recovery";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

export default async function FounderTroubleshootingPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return (
      <FounderOperatorShell activePage="troubleshooting">
        <section aria-labelledby="troubleshooting-auth-title">
          <h2 id="troubleshooting-auth-title">Sign in to continue</h2>
          <p>Authentication is required to open private Troubleshooting Help.</p>
        </section>
      </FounderOperatorShell>
    );
  }
  const params = (await searchParams) ?? {};
  const requested = typeof params.capability === "string" ? params.capability : null;
  const capability = isFounderRecoveryCapability(requested) ? requested : null;
  const troubleshooting = await getFounderTroubleshootingForUser(
    applicationUser.userId,
    capability,
  );
  const support = await getFounderSupportForUser(applicationUser.userId);
  return (
    <FounderOperatorShell activePage="troubleshooting">
      <FounderTroubleshooting initialTroubleshooting={troubleshooting} initialSupport={support} />
    </FounderOperatorShell>
  );
}
