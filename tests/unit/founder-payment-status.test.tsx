import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderGeneralRelease } from "@/app/operator/_components/founder-general-release";
import { FounderPaymentStatus } from "@/app/operator/payment/founder-payment-status";

describe("Founder payment status", () => {
  it("keeps a Hold visible and surfaces explicit Resume re-confirmation", () => {
    const baseline = generalReleaseStatus(false);
    const newApplicant = {
      ...baseline,
      release: { ...baseline.release, qualified: false, decisionState: "denied" as const },
      setup: { ...baseline.setup, serviceBusinessConfirmed: false },
    };
    expect(renderToStaticMarkup(<FounderGeneralRelease initialStatus={newApplicant} />)).toContain(
      "Check public availability",
    );
    const held = {
      ...baseline,
      release: {
        ...baseline.release,
        qualified: false,
        decisionState: "held" as const,
        capabilities: baseline.release.capabilities.map((capability) =>
          capability.id === "gmail_sending"
            ? { ...capability, state: "paused" as const }
            : capability,
        ),
      },
    };
    const heldHtml = renderToStaticMarkup(<FounderGeneralRelease initialStatus={held} />);
    expect(heldHtml).toContain("Gmail sending: Paused");
    expect(heldHtml).toContain("Operator creation requirements");

    const resumed = {
      ...baseline,
      release: { ...baseline.release, qualified: false, decisionState: "denied" as const },
      setup: { ...baseline.setup, requiresReleaseReconfirmation: true },
    };
    const resumedHtml = renderToStaticMarkup(<FounderGeneralRelease initialStatus={resumed} />);
    expect(resumedHtml).toContain("Reconfirm current release");
    expect(resumedHtml).toContain("fresh release decision resumed setup");
  });

  it("keeps the return surface in plain-language confirming payment state", () => {
    const html = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "confirming_payment",
          reconciliationDueAt: "2026-08-23T01:00:00.000Z",
        }}
      />,
    );
    expect(html).toContain("Confirming payment");
    expect(html).toContain("We’re checking your payment");
    expect(html).toContain("other devices");
    expect(html).not.toMatch(/subscriptionId|orderId|checkoutCorrelation|clerk/i);
  });

  it("renders persisted cross-device entitlement and terminal refund truth", () => {
    const entitled = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "entitled",
          status: "verified",
          customerPortalAvailable: true,
        }}
      />,
    );
    expect(entitled).toContain("Paid access confirmed");
    expect(entitled).toContain("works across devices");
    expect(entitled).toContain("Open secure billing portal");
    expect(entitled).toContain("Plan switching and subscription pausing are not available");

    const refunded = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "payment_refunded",
          refundConfirmedAt: "2026-08-23T01:00:00.000Z",
          cleanup: "required",
        }}
      />,
    );
    expect(refunded).toContain("Payment refunded");
    expect(refunded).toContain("full refund");
    expect(refunded).toContain("fresh checkout");
  });

  it("distinguishes recovery, cancelled-through, stopped, and completed retirement", () => {
    const recovery = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "payment_recovery",
          recoveryEndsAt: "2026-08-30T00:00:00.000Z",
          customerPortalAvailable: true,
        }}
      />,
    );
    expect(recovery).toContain("Payment recovery");
    expect(recovery).toContain("Your Operator is still working");
    expect(recovery).toContain("Open secure billing portal");

    const cancelled = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "cancelled_through",
          endsAt: "2026-08-30T00:00:00.000Z",
          customerPortalAvailable: true,
        }}
      />,
    );
    expect(cancelled).toContain("Subscription cancelled");
    expect(cancelled).toContain("paid access continues");
    expect(cancelled).toContain("eligible and choose to resume");

    const stopped = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "work_stopped",
          reason: "refunded",
          retirementDueAt: "2026-08-24T00:00:00.000Z",
          retirement: "in_progress",
        }}
      />,
    );
    expect(stopped).toContain("New work stopped");
    expect(stopped).toContain("A full refund ended Product Entitlement immediately");
    expect(stopped).toContain("not Account Closure");

    const completed = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "retirement_completed",
          reason: "expired",
          completedAt: "2026-08-24T00:00:00.000Z",
        }}
      />,
    );
    expect(completed).toContain("Infrastructure Retirement complete");
    expect(completed).toContain("provider absence was verified");
    expect(completed).toContain("separate actions");
  });

  it("keeps returning-Founder infrastructure, provider, and refund truth explicit", () => {
    const restoring = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "provider_reauthorization_required",
          environment: "same Operator, new infrastructure",
          providerAccess: "reauthorization required",
          work: "paused",
        }}
      />,
    );
    expect(restoring).toContain("Reconnect your providers to resume");
    expect(restoring).toContain("same logical Operator");
    expect(restoring).toContain("old IP address and infrastructure identity are not preserved");
    expect(restoring).toContain("New work remains paused");
    expect(restoring).not.toMatch(/droplet-[a-z0-9]|firewall-[a-z0-9]|runtimeIdentity/i);

    const expired = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{
          state: "new_operator_environment",
          payment: "refunded",
          providerAccess: "not carried forward",
          work: "paused",
        }}
      />,
    );
    expect(expired).toContain("Recovery Archive window has ended");
    expect(expired).toContain("remain deleted");
    expect(expired).toContain("refunded this paid attempt");
    expect(expired).toContain("clearly new Operator setup");
  });

  it("keeps checkout behind activation and separates Bruno price from provider costs", () => {
    const unavailable = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{ state: "not_started" }}
        generalRelease={generalReleaseStatus(false)}
      />,
    );
    expect(unavailable).toContain("paid offer is not available yet");
    expect(unavailable).toContain("first brief are free");
    expect(unavailable).not.toContain("Continue to secure checkout");

    const available = renderToStaticMarkup(
      <FounderPaymentStatus
        initialStatus={{ state: "not_started" }}
        generalRelease={generalReleaseStatus(true)}
      />,
    );
    expect(available).toContain("$30/month");
    expect(available).toContain("separately from your OpenAI or Anthropic plan");
    expect(available).toContain("no permanent free tier, secret beta price");
    expect(available).toContain("Continue to secure checkout");
  });
});

function generalReleaseStatus(offerAvailable: boolean) {
  return {
    state: offerAvailable ? ("activated" as const) : ("activation_pending" as const),
    admission: {
      publicSelfServe: true as const,
      personalSelection: false as const,
      geographyCode: "PH",
      capacity: "available" as const,
      reason: "Public capacity is available.",
    },
    release: {
      qualified: true,
      decisionState: "approved" as const,
      capabilities: [
        { id: "openai" as const, label: "OpenAI", state: "available" as const },
        { id: "anthropic" as const, label: "Anthropic", state: "available" as const },
        {
          id: "calendar_reading" as const,
          label: "Calendar reading",
          state: "available" as const,
        },
        { id: "gmail_reading" as const, label: "Gmail reading", state: "available" as const },
        { id: "gmail_sending" as const, label: "Gmail sending", state: "available" as const },
      ],
      providerChoice: "OpenAI, Anthropic, or both" as const,
      sending: "Off" as const,
      supportBoundary: "Ordinary product support" as const,
    },
    setup: {
      authenticated: true as const,
      serviceBusinessConfirmed: true,
      readyAiConnection: true,
      selectedCompanyConnections: true,
      processingConsent: true,
      explicitCreateConfirmed: true,
      requiresReleaseReconfirmation: false,
      canCreate: false,
    },
    activation: {
      dropletCreatedAt: "2026-08-23T00:00:00.000Z",
      dueAt: "2026-08-24T00:00:00.000Z",
      activatedAt: offerAvailable ? "2026-08-23T00:10:00.000Z" : null,
    },
    offer: {
      available: offerAvailable,
      priceLabel: "$30/month",
      brunoPriceSeparateFromAiProviderCosts: true as const,
      aiProviderCosts: "Paid separately to OpenAI or Anthropic" as const,
      freeTier: false as const,
      betaConversion: false as const,
      decisionDueAt: offerAvailable ? "2026-08-24T00:10:00.000Z" : null,
    },
    retirement: {
      dueAt: null,
      workStoppedAt: offerAvailable ? "2026-08-23T00:10:00.000Z" : null,
    },
  };
}
