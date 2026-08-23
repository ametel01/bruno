import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderPaymentStatus } from "@/app/operator/payment/founder-payment-status";

describe("Founder payment status", () => {
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
        initialStatus={{ state: "entitled", status: "verified", retirementDueAt: null }}
      />,
    );
    expect(entitled).toContain("Paid access confirmed");
    expect(entitled).toContain("works across devices");

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
    setup: {
      authenticated: true as const,
      serviceBusinessConfirmed: true,
      readyAiConnection: true,
      selectedCompanyConnections: true,
      processingConsent: true,
      explicitCreateConfirmed: true,
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
    retirement: { dueAt: null, workStoppedAt: offerAvailable ? "2026-08-23T00:10:00.000Z" : null },
  };
}
