"use client";

import { useEffect, useState } from "react";
import type { FounderCoreOperationDto } from "@/src/server/operators/founder-core-operation";
import { FounderActionPreviewCard } from "./founder-action-preview";
import styles from "./founder-limited-operation.module.css";
import { FounderMorningBriefSettings } from "./founder-morning-brief-settings";
import { FounderProposedActionCard } from "./founder-proposed-action";

export function FounderCoreOperation() {
  const [operation, setOperation] = useState<FounderCoreOperationDto | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/core-operation", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Core Operation could not be loaded.");
        return (await response.json()) as { operation: FounderCoreOperationDto | null };
      })
      .then((body) => {
        if (!cancelled) setOperation(body.operation);
      })
      .catch((loadError) => {
        if (!cancelled)
          setError(
            loadError instanceof Error ? loadError.message : "Core Operation could not be loaded.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function runAction(action: "confirm_consent" | "open_brief") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/core-operation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as {
        operation?: FounderCoreOperationDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.operation)
        throw new Error(body.error?.message ?? "Core Operation needs attention.");
      setOperation(body.operation);
      setConfirmed(false);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Core Operation needs attention.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading || !operation) return error ? <p className={styles.error}>{error}</p> : null;
  const consentActive = operation.consent.status === "active";
  const activated = Boolean(operation.activatedAt);

  return (
    <section className={styles.card} id="core-operation" aria-labelledby="core-operation-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Founder workspace</p>
          <h3 id="core-operation-title">Core Operation</h3>
        </div>
        <span className={styles.badge}>
          {activated ? "Active" : consentActive ? "Ready" : "Review"}
        </span>
      </div>
      <p className={styles.copy}>
        Bruno can prepare your current brief from the same Primary Communications Suite: read-only
        Calendar and selected Mail evidence. Mail Sending is never required here.
      </p>
      <p className={styles.hint}>
        Suite identity:{" "}
        {operation.suite.providerSubjectId ?? "waiting for a matched Calendar and Mail identity"}.
      </p>
      {!consentActive ? (
        <div className={styles.consent}>
          <label>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.currentTarget.checked)}
              disabled={busy}
            />{" "}
            I confirm that my Ready AI Connection may process evidence from my matched Calendar and
            selected Mail for my Founder brief.
          </label>
          <p className={styles.hint}>
            Observation and preparation are allowed. External effects require a separate exact
            approval, and Mail Sending remains off.
          </p>
          <button
            className={styles.button}
            type="button"
            onClick={() => void runAction("confirm_consent")}
            disabled={!confirmed || busy}
          >
            {busy ? "Saving…" : "Confirm Core Operation"}
          </button>
        </div>
      ) : null}
      {consentActive && operation.authorityPolicy ? (
        <div className={styles.policy} role="status">
          <strong>Safe Authority Policy · v{operation.authorityPolicy.version}</strong>
          <span>Calendar + Mail evidence: read-only preparation</span>
          <span>Mail Sending: not required</span>
          <span>External effects: approval required</span>
          {operation.authorityPolicy.actionFamilies ? (
            <span>
              Action Families: {summarizeActionFamilies(operation.authorityPolicy.actionFamilies)}
            </span>
          ) : null}
        </div>
      ) : null}
      {operation.brief ? (
        <article className={styles.brief} aria-labelledby="core-brief-title">
          <p className={styles.kicker}>Current Brief Ready</p>
          <h4 id="core-brief-title">Founder Morning Brief</h4>
          <p>{operation.brief.content}</p>
          <p className={styles.hint}>
            Calendar and Mail evidence:{" "}
            {operation.brief.evidenceState === "current" ? "Current" : "Unavailable"}.
          </p>
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
              onClick={() => void runAction("open_brief")}
              disabled={busy}
            >
              {busy ? "Opening…" : "Open Founder Morning Brief"}
            </button>
          ) : (
            <p className={styles.activated} role="status">
              Founder Activation recorded. Conversation is your current workspace.
            </p>
          )}
        </article>
      ) : consentActive ? (
        <p className={styles.notice}>
          Bruno is waiting for Current evidence from both Calendar and Mail.
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
  families: NonNullable<FounderCoreOperationDto["authorityPolicy"]>["actionFamilies"],
): string {
  if (!families) return "safe defaults";
  return Object.entries(families)
    .map(([family, mode]) => `${family.replaceAll("_", " ")} (${mode.replaceAll("_", " ")})`)
    .join(" · ");
}
