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
});
