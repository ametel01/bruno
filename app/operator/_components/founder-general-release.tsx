"use client";

import { useEffect, useState } from "react";
import type { FounderGeneralReleaseActivationDto } from "@/src/server/founder-product-contract/initial-general-release";
import styles from "./founder-general-release.module.css";

export function FounderGeneralRelease({
  initialStatus,
}: {
  initialStatus: FounderGeneralReleaseActivationDto;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [geographyCode, setGeographyCode] = useState(status.admission.geographyCode ?? "");
  const [serviceBusinessConfirmed, setServiceBusinessConfirmed] = useState(
    status.setup.serviceBusinessConfirmed,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try {
        const response = await fetch("/api/operator/general-release", { cache: "no-store" });
        if (!response.ok) return;
        const body = (await response.json()) as {
          generalRelease?: FounderGeneralReleaseActivationDto;
        };
        if (body.generalRelease) setStatus(body.generalRelease);
      } catch {
        // Persisted state remains visible while refresh is unavailable.
      }
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  async function runAction(payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/general-release", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      const body = (await response.json()) as {
        generalRelease?: FounderGeneralReleaseActivationDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.generalRelease) {
        throw new Error(body.error?.message ?? "General Release setup is unavailable.");
      }
      setStatus(body.generalRelease);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "General Release setup is unavailable.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.card} aria-labelledby="general-release-title" aria-busy={busy}>
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Initial General Release</p>
          <h2 id="general-release-title">Public, self-serve setup</h2>
        </div>
        <span className={styles.badge}>{stateLabel(status.state)}</span>
      </div>
      <p>
        Eligible Founder-led Service Businesses can sign up without a personal invitation. Geography
        and capacity may place setup on the public waitlist.
      </p>
      <p className={styles.notice} role="status">
        {status.admission.reason}
      </p>

      {!status.setup.serviceBusinessConfirmed ? (
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void runAction({
              action: "confirm_eligibility",
              serviceBusinessConfirmed,
              geographyCode,
            });
          }}
        >
          <label>
            Business country
            <input
              value={geographyCode}
              onChange={(event) => setGeographyCode(event.currentTarget.value.toUpperCase())}
              maxLength={2}
              placeholder="PH"
              autoComplete="country"
              disabled={busy}
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={serviceBusinessConfirmed}
              onChange={(event) => setServiceBusinessConfirmed(event.currentTarget.checked)}
              disabled={busy}
            />
            I confirm that I lead a service business and can make its product decisions.
          </label>
          <button
            type="submit"
            disabled={busy || !serviceBusinessConfirmed || geographyCode.length !== 2}
          >
            {busy ? "Checking…" : "Check public availability"}
          </button>
        </form>
      ) : (
        <ul className={styles.checklist} aria-label="Operator creation requirements">
          <li data-ready={status.setup.readyAiConnection}>At least one Ready AI Connection</li>
          <li data-ready={status.setup.selectedCompanyConnections}>
            Selected Current Calendar and Mail Connections
          </li>
          <li data-ready={status.setup.processingConsent}>
            Processing Consent and safe Authority Policy
          </li>
        </ul>
      )}

      {status.setup.canCreate ? (
        <div className={styles.decision}>
          <p>
            Bruno.Ai will create one DigitalOcean Droplet only after this explicit decision. The
            free activation window begins at authoritative Droplet creation.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction({ action: "create_operator" })}
          >
            {busy ? "Creating…" : "Create my Operator"}
          </button>
        </div>
      ) : null}

      {status.state === "activation_pending" ? (
        <p className={styles.notice} role="status">
          Your 24-hour activation window is open
          {status.activation.dueAt ? ` until ${formatDate(status.activation.dueAt)}` : ""}. Open the
          first evidence-backed Founder Morning Brief to activate.
        </p>
      ) : null}

      {status.state === "activated" ? (
        <div className={styles.offer}>
          <p className={styles.eyebrow}>Published paid offer</p>
          <h3>{status.offer.priceLabel ?? "Price unavailable"}</h3>
          <p>
            Bruno.Ai is charged separately. OpenAI or Anthropic subscriptions and usage are paid
            directly to those providers. There is no permanent free tier or automatic beta
            conversion.
          </p>
          <p>
            Your first brief remains free. New Operator work is paused while you decide
            {status.offer.decisionDueAt ? `, until ${formatDate(status.offer.decisionDueAt)}` : ""}.
          </p>
          <div className={styles.actions}>
            {status.offer.available ? <a href="/operator/payment">Review and subscribe</a> : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction({ action: "decline_offer" })}
            >
              Not now — retire my Droplet
            </button>
          </div>
        </div>
      ) : null}

      {status.state === "entitled" ? (
        <p className={styles.notice} role="status">
          Product Entitlement verified. Paid Operator work may continue.
        </p>
      ) : null}
      {status.state === "retirement_due" || status.state === "retired" ? (
        <p className={styles.notice} role="status">
          {status.state === "retired"
            ? "Infrastructure Retirement is verified complete."
            : "New work is stopped. Bruno.Ai is archiving eligible state and retiring the exact Droplet."}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function stateLabel(state: FounderGeneralReleaseActivationDto["state"]): string {
  return state.replaceAll("_", " ");
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
