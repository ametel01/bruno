"use client";

import { useState } from "react";
import type {
  FounderProposedActionDto,
  FounderProposedActionDraft,
} from "@/src/server/operators/founder-proposed-actions";
import styles from "./founder-proposed-action.module.css";

export function FounderProposedActionCard({
  action,
  compact = false,
  onUpdated,
}: {
  action: FounderProposedActionDto;
  compact?: boolean;
  onUpdated?: (action: FounderProposedActionDto) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showChanges, setShowChanges] = useState(false);
  const [change, setChange] = useState("");
  const canDecide = action.state === "awaiting_approval" || action.state === "proposed";

  async function decide(kind: "approve" | "decline" | "request_changes") {
    if (busy) return;
    setBusy(true);
    setError(null);
    const changes =
      kind === "request_changes"
        ? buildChanges(action, change.trim() || "Founder requested a material revision.")
        : undefined;
    try {
      const response = await fetch(`/api/operator/proposed-actions/${action.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          kind,
          expectedVersion: action.version,
          ...(changes ? { changes } : {}),
        }),
      });
      const body = (await response.json()) as {
        action?: FounderProposedActionDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.action) {
        throw new Error(body.error?.message ?? "The Founder decision could not be saved.");
      }
      setShowChanges(false);
      setChange("");
      onUpdated?.(body.action);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error
          ? decisionError.message
          : "The Founder decision could not be saved.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className={`${styles.card} ${compact ? styles.compact : ""} ${action.productGuardrails.blocked ? styles.blocked : ""}`}
      data-proposed-action-id={action.id}
      data-proposed-action-version={action.version}
      data-state={action.state}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Proposed Action · version {action.version}</p>
          <h4>{action.businessOutcome}</h4>
        </div>
        <span className={styles.badge}>{readableState(action.state)}</span>
      </div>
      <dl className={styles.details}>
        <div>
          <dt>Action family</dt>
          <dd>{readableFamily(action.actionFamily)}</dd>
        </div>
        <div>
          <dt>Destination</dt>
          <dd>{readableObject(action.destination)}</dd>
        </div>
        <div>
          <dt>Material content</dt>
          <dd>{readableObject(action.materialContent)}</dd>
        </div>
        <div>
          <dt>Expected side effects</dt>
          <dd>{action.sideEffects.length ? action.sideEffects.join("; ") : "None recorded."}</dd>
        </div>
        <div>
          <dt>Policy and validity</dt>
          <dd>
            {action.policy.mode.replaceAll("_", " ")} · policy v{action.policy.version} · valid
            until {new Date(action.validUntil).toLocaleString()}
          </dd>
        </div>
      </dl>
      {action.preconditions.length ? (
        <div>
          <p className={styles.label}>Required preconditions</p>
          <ul className={styles.preconditions}>
            {action.preconditions.map((condition) => (
              <li key={`${condition.key}:${condition.description}`}>{condition.description}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {action.productGuardrails.blocked ? (
        <p className={styles.hint} role="status">
          Blocked by Product Guardrails. No approval or conversation instruction can bypass this
          boundary.
        </p>
      ) : null}
      {action.state === "authorized" ? (
        <p className={styles.hint} role="status">
          Authorized for this exact version once. Bruno has not executed an external effect here.
        </p>
      ) : null}
      {canDecide && !action.productGuardrails.blocked ? (
        <fieldset className={styles.actions}>
          <legend className={styles.label}>Proposed Action decision</legend>
          <button type="button" onClick={() => void decide("approve")} disabled={busy}>
            {busy ? "Saving…" : "Approve exact version"}
          </button>
          <button
            type="button"
            data-kind="decline"
            onClick={() => void decide("decline")}
            disabled={busy}
          >
            Decline
          </button>
          <button
            type="button"
            data-kind="decline"
            onClick={() => setShowChanges((visible) => !visible)}
            disabled={busy}
          >
            Request changes
          </button>
        </fieldset>
      ) : null}
      {showChanges ? (
        <form
          className={styles.changeForm}
          onSubmit={(event) => {
            event.preventDefault();
            void decide("request_changes");
          }}
        >
          <label className={styles.label} htmlFor={`proposed-action-change-${action.id}`}>
            What should change?
          </label>
          <textarea
            id={`proposed-action-change-${action.id}`}
            value={change}
            onChange={(event) => setChange(event.currentTarget.value)}
            placeholder="Describe the material change Bruno should prepare."
            maxLength={2_000}
            disabled={busy}
          />
          <button className={styles.saveButton} type="submit" disabled={busy || !change.trim()}>
            Save requested changes
          </button>
        </form>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <p className={styles.hint}>
        One decision applies only to this immutable version. Later edits require a new version.
      </p>
    </article>
  );
}

function buildChanges(
  action: FounderProposedActionDto,
  request: string,
): FounderProposedActionDraft {
  return {
    actionFamily: action.actionFamily,
    actionSubtype: action.actionSubtype,
    businessOutcome: action.businessOutcome,
    companyConnectionId: action.connection.companyConnectionId,
    connectionResourceId: action.connection.connectionResourceId,
    processingConsentId: action.connection.processingConsentId,
    destination: action.destination,
    materialContent: { ...action.materialContent, founderRequestedChange: request },
    sideEffects: action.sideEffects,
    preconditions: action.preconditions,
    validUntil: action.validUntil,
    executionWindowStart: action.executionWindow.start,
    executionWindowEnd: action.executionWindow.end,
  };
}

function readableFamily(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function readableState(value: string): string {
  return value.replaceAll("_", " ");
}

function readableObject(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${readableFamily(key)}: ${typeof item === "string" ? item : JSON.stringify(item)}`,
    )
    .join(" · ");
}
