"use client";

import { useEffect, useState } from "react";
import type { FounderActionPreviewDto } from "@/src/server/operators/founder-action-previews";
import type { FounderProposedActionDto } from "@/src/server/operators/founder-proposed-actions";
import styles from "./founder-action-inbox.module.css";
import { FounderActionPreviewCard } from "./founder-action-preview";
import { FounderProposedActionCard } from "./founder-proposed-action";

export function FounderActionInbox() {
  const [preview, setPreview] = useState<FounderActionPreviewDto | null>(null);
  const [proposedActions, setProposedActions] = useState<FounderProposedActionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/operator/action-preview", { credentials: "same-origin" }),
      fetch("/api/operator/proposed-actions", { credentials: "same-origin" }),
    ])
      .then(async ([previewResponse, actionsResponse]) => {
        if (!previewResponse.ok || !actionsResponse.ok) {
          throw new Error("Action Inbox could not be loaded.");
        }
        return {
          preview: (await previewResponse.json()) as { preview: FounderActionPreviewDto },
          actions: (await actionsResponse.json()) as { actions: FounderProposedActionDto[] },
        };
      })
      .then((body) => {
        if (!cancelled) {
          setPreview(body.preview.preview);
          setProposedActions(body.actions.actions);
        }
      })
      .catch((loadError) => {
        if (!cancelled)
          setError(
            loadError instanceof Error ? loadError.message : "Action Inbox could not be loaded.",
          );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveDraft(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview || saving) return;
    const form = new FormData(event.currentTarget);
    const recipientName = String(form.get("recipientName") ?? "").trim();
    const recipientAddress = String(form.get("recipientAddress") ?? "").trim();
    const content = String(form.get("content") ?? "").trim();
    const expectedExternalEffect = String(form.get("expectedExternalEffect") ?? "").trim();
    const evidenceLabel = String(form.get("evidenceLabel") ?? "").trim();
    const evidenceDetail = String(form.get("evidenceDetail") ?? "").trim();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/action-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "edit",
          recipient: { name: recipientName, address: recipientAddress },
          content,
          supportingEvidence: [{ label: evidenceLabel, detail: evidenceDetail }],
          expectedExternalEffect,
        }),
      });
      const body = (await response.json()) as {
        preview?: FounderActionPreviewDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.preview) {
        throw new Error(body.error?.message ?? "The new Action Preview draft could not be saved.");
      }
      setPreview(body.preview);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The new Action Preview draft could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function dismissMailOffer() {
    if (!preview || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/action-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "dismiss_mail_offer" }),
      });
      const body = (await response.json()) as {
        preview?: FounderActionPreviewDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.preview) {
        throw new Error(body.error?.message ?? "The Mail Sending offer could not be dismissed.");
      }
      setPreview(body.preview);
    } catch (dismissError) {
      setError(
        dismissError instanceof Error
          ? dismissError.message
          : "The Mail Sending offer could not be dismissed.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <section
      className={styles.card}
      id="needs-you"
      aria-labelledby="action-inbox-title"
      aria-busy={loading || saving}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Action Inbox</p>
          <h3 id="action-inbox-title">Review prepared actions before authority exists.</h3>
        </div>
        <span className={styles.badge}>Non-executable</span>
      </div>
      {loading ? (
        <p className={styles.notice} role="status" aria-live="polite">
          Loading your canonical preview…
        </p>
      ) : null}
      {preview ? <FounderActionPreviewCard preview={preview} /> : null}
      {proposedActions.map((action) => (
        <FounderProposedActionCard
          key={action.id}
          action={action}
          onUpdated={(updated) =>
            setProposedActions((current) =>
              updated.supersedesId
                ? current.some((item) => item.id === updated.id)
                  ? current.map((item) => (item.id === updated.id ? updated : item))
                  : [updated, ...current.filter((item) => item.id !== action.id)]
                : current.map((item) => (item.id === updated.id ? updated : item)),
            )
          }
        />
      ))}
      {preview ? (
        <form className={styles.editor} onSubmit={saveDraft}>
          <p className={styles.kicker}>Edit creates a new draft revision</p>
          <label htmlFor="action-preview-recipient-name">Recipient name</label>
          <input
            id="action-preview-recipient-name"
            name="recipientName"
            defaultValue={preview.current.recipient.name}
            maxLength={240}
            disabled={saving}
          />
          <label htmlFor="action-preview-recipient-address">Recipient address</label>
          <input
            id="action-preview-recipient-address"
            name="recipientAddress"
            defaultValue={preview.current.recipient.address}
            maxLength={320}
            disabled={saving}
          />
          <label htmlFor="action-preview-content">Content</label>
          <textarea
            id="action-preview-content"
            name="content"
            defaultValue={preview.current.content}
            maxLength={12_000}
            rows={4}
            disabled={saving}
          />
          <label htmlFor="action-preview-evidence-label">Supporting evidence label</label>
          <input
            id="action-preview-evidence-label"
            name="evidenceLabel"
            defaultValue={preview.current.supportingEvidence[0]?.label ?? ""}
            maxLength={240}
            disabled={saving}
          />
          <label htmlFor="action-preview-evidence-detail">Supporting evidence detail</label>
          <textarea
            id="action-preview-evidence-detail"
            name="evidenceDetail"
            defaultValue={preview.current.supportingEvidence[0]?.detail ?? ""}
            maxLength={2_000}
            rows={2}
            disabled={saving}
          />
          <label htmlFor="action-preview-effect">Expected external effect</label>
          <textarea
            id="action-preview-effect"
            name="expectedExternalEffect"
            defaultValue={preview.current.expectedExternalEffect}
            maxLength={2_000}
            rows={2}
            disabled={saving}
          />
          <button type="submit" disabled={saving}>
            {saving ? "Saving new draft…" : "Save as new draft"}
          </button>
          <p className={styles.hint}>
            There is no Approve or Send action here. Revision {preview.current.revision} remains a
            preview only.
          </p>
        </form>
      ) : null}
      {preview?.mailSendingOffer === "available" ? (
        <div className={styles.offer} role="status">
          <p className={styles.kicker}>Contextual Connection Offer</p>
          <strong>Mail Sending is unavailable.</strong>
          <p>
            If you want Bruno to prepare one-to-one mail outcomes later, review the optional Mail
            Sending Connection. This preview remains visible and no message can be sent now.
          </p>
          <div className={styles.offerActions}>
            <a href="#mail-sending">Review optional Mail Sending Connection</a>
            <button type="button" onClick={() => void dismissMailOffer()} disabled={saving}>
              Not now
            </button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
