import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { getFounderCommerceStatusForUser } from "@/src/server/commerce/founder-commerce";
import { getFounderGeneralReleaseActivationForUser } from "@/src/server/founder-product-contract/initial-general-release";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";
import { FounderPaymentStatus } from "./founder-payment-status";

export const dynamic = "force-dynamic";

export default async function FounderPaymentPage() {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) {
    return (
      <FounderOperatorShell>
        <section aria-labelledby="payment-auth-title">
          <h2 id="payment-auth-title">Sign in to continue</h2>
          <p>Authentication is required to check your private payment status.</p>
        </section>
      </FounderOperatorShell>
    );
  }
  const [status, generalRelease] = await Promise.all([
    getFounderCommerceStatusForUser(applicationUser.userId),
    getFounderGeneralReleaseActivationForUser(applicationUser.userId),
  ]);
  return (
    <FounderOperatorShell>
      <FounderPaymentStatus initialStatus={status} generalRelease={generalRelease} />
    </FounderOperatorShell>
  );
}
