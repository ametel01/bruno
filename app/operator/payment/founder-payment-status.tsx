"use client";

import { useEffect, useState } from "react";
import type { FounderCommerceStatusDto } from "@/src/server/commerce/founder-commerce";
import type { FounderGeneralReleaseActivationDto } from "@/src/server/founder-product-contract/initial-general-release";
import styles from "./payment.module.css";

export function FounderPaymentStatus({
  initialStatus,
  generalRelease,
}: {
  initialStatus: FounderCommerceStatusDto;
  generalRelease?: FounderGeneralReleaseActivationDto;
}) {
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    if (status.state !== "confirming_payment") return;
    const refresh = async () => {
      try {
        const response = await fetch("/api/operator/commerce/status", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as { commerce?: FounderCommerceStatusDto };
        if (body.commerce) setStatus(body.commerce);
      } catch {
        // The persisted confirming state remains authoritative while polling is unavailable.
      }
    };
    const interval = window.setInterval(refresh, 2_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [status.state]);

  if (status.state === "not_started") {
    if (!generalRelease?.offer.available || !generalRelease.offer.priceLabel) {
      return (
        <section className={styles.card} aria-labelledby="payment-title">
          <p className={styles.eyebrow}>Bruno.Ai subscription</p>
          <h2 id="payment-title">The paid offer is not available yet</h2>
          <p>
            Open your first evidence-backed Founder Morning Brief before reviewing checkout. Signup,
            connections, setup waiting, and the first brief are free.
          </p>
          <a className={styles.primary} href="/operator">
            Return to setup
          </a>
        </section>
      );
    }
    return (
      <section className={styles.card} aria-labelledby="payment-title">
        <p className={styles.eyebrow}>Bruno.Ai subscription</p>
        <h2 id="payment-title">Continue with paid access</h2>
        <p>
          <strong>{generalRelease.offer.priceLabel}</strong>
        </p>
        <p>
          Bruno.Ai is billed separately from your OpenAI or Anthropic plan. Checkout, receipts, tax,
          and refunds are handled securely by Lemon Squeezy.
        </p>
        <p className={styles.muted}>
          Your first brief is free. There is no permanent free tier, secret beta price, or automatic
          beta conversion.
        </p>
        <form action="/api/operator/commerce/checkout" method="post">
          <button className={styles.primary} type="submit">
            Continue to secure checkout
          </button>
        </form>
      </section>
    );
  }

  if (status.state === "confirming_payment") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Confirming payment</p>
        <h2 id="payment-title">We’re checking your payment</h2>
        <p>
          You can leave this page. Access will appear here and on your other devices only after
          Bruno.Ai verifies the signed payment record with Lemon Squeezy.
        </p>
        <p className={styles.muted}>This usually takes a few moments.</p>
      </section>
    );
  }

  if (status.state === "entitled") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Paid access confirmed</p>
        <h2 id="payment-title">Your Bruno.Ai access is ready</h2>
        <p>Your Product Entitlement is saved to your Founder workspace and works across devices.</p>
        <a className={styles.primary} href="/operator">
          Return to Bruno
        </a>
      </section>
    );
  }

  if (status.state === "payment_refunded") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Payment refunded</p>
        <h2 id="payment-title">Access could not be established safely</h2>
        <p>
          Bruno.Ai issued a full refund and closed this checkout attempt. Any Operator
          infrastructure is being retired. Start a fresh checkout only when you decide to try again.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
      <p className={styles.eyebrow}>Paid access unavailable</p>
      <h2 id="payment-title">Your Operator has stopped new work</h2>
      <p>Payment state no longer authorizes paid operation. Your retained data is not deleted.</p>
    </section>
  );
}
