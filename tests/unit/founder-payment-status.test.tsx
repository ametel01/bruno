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
});
