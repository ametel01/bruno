"use client";

import { useEffect, useState } from "react";
import type { FounderCommerceStatusDto } from "@/src/server/commerce/founder-commerce";
import styles from "./payment.module.css";

export function FounderPaymentStatus({
  initialStatus,
}: {
  initialStatus: FounderCommerceStatusDto;
}) {
  const [status, setStatus] = useState(initialStatus);

  useEffect(() => {
    if (
      status.state !== "confirming_payment" &&
      status.state !== "restoring" &&
      status.state !== "provider_reauthorization_required"
    ) {
      return;
    }
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
    return (
      <section className={styles.card} aria-labelledby="payment-title">
        <p className={styles.eyebrow}>Bruno.Ai subscription</p>
        <h2 id="payment-title">Continue with paid access</h2>
        <p>
          Bruno.Ai is billed separately from your OpenAI or Anthropic plan. Checkout, receipts, tax,
          and refunds are handled securely by Lemon Squeezy.
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
        <p>
          Use Lemon Squeezy for payment methods, billing history, cancellation, or an eligible
          resumption. Plan switching and subscription pausing are not available.
        </p>
        <PortalButton />
        <a className={styles.primary} href="/operator">
          Return to Bruno
        </a>
      </section>
    );
  }

  if (status.state === "restoring" || status.state === "provider_reauthorization_required") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Restoring your Operator</p>
        <h2 id="payment-title">
          {status.state === "provider_reauthorization_required"
            ? "Reconnect your providers to resume"
            : "New infrastructure is being verified"}
        </h2>
        <p>
          Your same logical Operator is being rebuilt on a new Droplet and firewall. The old IP
          address and infrastructure identity are not preserved. New work remains paused until the
          Recovery Archive, infrastructure, provider access, and Product Entitlement are all ready.
        </p>
      </section>
    );
  }

  if (status.state === "new_operator_environment") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>New Operator environment</p>
        <h2 id="payment-title">The Recovery Archive window has ended</h2>
        <p>
          The expired archive and its recovery access remain deleted. Bruno.Ai refunded this paid
          attempt and started a clearly new Operator setup; old provider access was not carried
          forward.
        </p>
      </section>
    );
  }

  if (status.state === "payment_recovery") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Payment recovery</p>
        <h2 id="payment-title">Your Operator is still working</h2>
        <p>
          Update your payment method by {formatFounderDate(status.recoveryEndsAt)}. New work stops
          when this disclosed recovery window ends if payment has not recovered.
        </p>
        <PortalButton />
      </section>
    );
  }

  if (status.state === "cancelled_through") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Subscription cancelled</p>
        <h2 id="payment-title">Your paid access continues for now</h2>
        <p>
          Your Operator can keep working through {formatFounderDate(status.endsAt)}. Infrastructure
          Retirement begins at that paid boundary unless you are eligible and choose to resume in
          Lemon Squeezy.
        </p>
        <PortalButton />
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

  if (status.state === "retirement_completed") {
    return (
      <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
        <p className={styles.eyebrow}>Infrastructure Retirement complete</p>
        <h2 id="payment-title">Your retired infrastructure is no longer billable</h2>
        <p>
          New work is stopped and provider absence was verified on{" "}
          {formatFounderDate(status.completedAt)}. Subscription cancellation, refunds,
          Infrastructure Retirement, and Account Closure remain separate actions. Your retained
          Bruno.Ai data was not deleted.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-labelledby="payment-title" aria-live="polite">
      <p className={styles.eyebrow}>New work stopped</p>
      <h2 id="payment-title">
        Infrastructure Retirement{" "}
        {status.retirement === "in_progress" ? "is in progress" : "is required"}
      </h2>
      <p>
        {workStoppedReason(status.reason)} Retirement is due by{" "}
        {formatFounderDate(status.retirementDueAt)}. Your retained Bruno.Ai data is not deleted, and
        this is not Account Closure.
      </p>
    </section>
  );
}

function PortalButton() {
  return (
    <form action="/api/operator/commerce/portal" method="post">
      <button className={styles.secondary} type="submit">
        Open secure billing portal
      </button>
    </form>
  );
}

function formatFounderDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function workStoppedReason(reason: "unpaid" | "expired" | "refunded" | "cancelled" | "past_due") {
  switch (reason) {
    case "unpaid":
      return "Payment recovery ended without payment, so Product Entitlement no longer authorizes new work.";
    case "expired":
      return "Verified subscription expiry ended Product Entitlement.";
    case "refunded":
      return "A full refund ended Product Entitlement immediately.";
    case "cancelled":
      return "The paid cancellation boundary has passed.";
    case "past_due":
      return "The disclosed payment-recovery window has ended.";
  }
}
