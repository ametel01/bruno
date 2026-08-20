"use client";

import { useEffect, useState } from "react";
import type { FounderLimitedOperationDto } from "@/src/server/operators/founder-limited-operation";
import { FounderActionPreviewCard } from "./founder-action-preview";
import styles from "./founder-limited-operation.module.css";
import { FounderMorningBriefSettings } from "./founder-morning-brief-settings";
import { FounderProposedActionCard } from "./founder-proposed-action";
import { FounderRecoveryStatus } from "./founder-recovery-status";

export function FounderLimitedOperation() {
  const [operation, setOperation] = useState<FounderLimitedOperationDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/limited-operation", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Limited Operation could not be loaded.");
        return (await response.json()) as { operation: FounderLimitedOperationDto | null };
      })
      .then((body) => {
        if (!cancelled) setOperation(body.operation);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Limited Operation could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function confirmConsent() {
    await runAction("confirm_consent");
  }

  async function openBrief() {
    await runAction("open_brief");
  }

  async function runAction(action: "confirm_consent" | "open_brief") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/limited-operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as {
        operation?: FounderLimitedOperationDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.operation) {
        throw new Error(body.error?.message ?? "Limited Operation needs attention.");
      }
      setOperation(body.operation);
      setConfirmed(false);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Limited Operation needs attention.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <p className={styles.notice} role="status" aria-live="polite">
        Loading Limited Operation…
      </p>
    );
  }
  if (!operation)
    return error ? (
      <p className={styles.error} role="alert">
        {error}
      </p>
    ) : null;

  const consentActive = operation.consent.status === "active";
  const briefReady = Boolean(operation.brief);
  const activated = Boolean(operation.activatedAt);

  return (
    <section
      className={styles.card}
      id="limited-operation"
      aria-labelledby="limited-operation-title"
      aria-busy={busy}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Founder workspace</p>
          <h3 id="limited-operation-title">{operation.name}</h3>
        </div>
        <span className={styles.badge}>
          {activated ? "Active" : consentActive ? "Ready" : "Review"}
        </span>
      </div>
      <p className={styles.copy}>
        Bruno can observe and prepare work from your selected Calendar. Mail evidence is not
        included in this Limited Operation.
      </p>

      {!consentActive ? (
        <div className={styles.consent}>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              disabled={busy}
            />
            I confirm that my Ready AI Connection may process evidence from the selected Calendar
            for my Founder Morning Brief.
          </label>
          <p className={styles.hint}>
            The safe Authority Policy permits observation and preparation. External effects require
            a separate exact approval, and Mail remains off.
          </p>
          <button
            className={styles.button}
            type="button"
            onClick={() => void confirmConsent()}
            disabled={!confirmed || busy}
          >
            {busy ? "Saving…" : "Confirm Processing Consent"}
          </button>
        </div>
      ) : null}

      {consentActive && operation.authorityPolicy ? (
        <div className={styles.policy} role="status">
          <strong>Safe Authority Policy · v{operation.authorityPolicy.version}</strong>
          <span>Observation: always allowed</span>
          <span>Preparation: always allowed</span>
          <span>External effects: approval required</span>
          <span>Mail evidence: not included</span>
          {operation.authorityPolicy.actionFamilies ? (
            <span>
              Action Families: {summarizeActionFamilies(operation.authorityPolicy.actionFamilies)}
            </span>
          ) : null}
        </div>
      ) : null}

      {briefReady && operation.brief ? (
        <article className={styles.brief} aria-labelledby="morning-brief-title">
          <p className={styles.kicker}>First Brief Ready</p>
          <h4 id="morning-brief-title">Founder Morning Brief</h4>
          <p>{operation.brief.content}</p>
          <p className={styles.hint}>
            Calendar evidence:{" "}
            {operation.brief.evidenceState === "current" ? "Current" : "Unavailable"}.
          </p>
          <FounderRecoveryStatus recovery={operation.brief.recovery ?? null} />
          {operation.brief.items && operation.brief.items.length > 0 ? (
            <ul className={styles.hint}>
              {operation.brief.items.map((item) => (
                <li key={item.id}>
                  {item.title}: {item.detail}
                </li>
              ))}
            </ul>
          ) : null}
          <FounderMorningBriefSettings />
          {!activated ? (
            <button
              className={styles.button}
              type="button"
              onClick={() => void openBrief()}
              disabled={busy}
            >
              {busy ? "Opening…" : "Open Founder Morning Brief"}
            </button>
          ) : (
            <p className={styles.activated} role="status">
              Founder Activation recorded.
            </p>
          )}
        </article>
      ) : consentActive ? (
        <p className={styles.notice} role="status" aria-live="polite">
          Bruno is waiting for a Current check of the selected Calendar.
        </p>
      ) : null}
      {operation.actionPreview ? (
        <FounderActionPreviewCard preview={operation.actionPreview} compact />
      ) : null}
      {operation.proposedAction ? (
        <FounderProposedActionCard
          action={operation.proposedAction}
          compact
          onUpdated={(action) =>
            setOperation((current) => (current ? { ...current, proposedAction: action } : current))
          }
        />
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function summarizeActionFamilies(
  families: NonNullable<FounderLimitedOperationDto["authorityPolicy"]>["actionFamilies"],
): string {
  if (!families) return "safe defaults";
  return Object.entries(families)
    .map(([family, mode]) => `${family.replaceAll("_", " ")} (${mode.replaceAll("_", " ")})`)
    .join(" · ");
}
