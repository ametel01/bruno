"use client";

import { useEffect, useState } from "react";
import type {
  FounderConversationDto,
  FounderConversationMessageDto,
} from "@/src/server/operators/founder-conversation";
import { FounderActionPreviewCard } from "./founder-action-preview";
import { FounderRecoveryStatus } from "./founder-recovery-status";
import styles from "./founder-conversation.module.css";
import { FounderProposedActionCard } from "./founder-proposed-action";

export function FounderConversation() {
  const [conversation, setConversation] = useState<FounderConversationDto | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/conversation", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Conversation could not be loaded.");
        return (await response.json()) as { conversation: FounderConversationDto };
      })
      .then((body) => {
        if (!cancelled) setConversation(body.conversation);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Conversation could not be loaded.",
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

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ message, requestId: crypto.randomUUID() }),
      });
      const body = (await response.json()) as
        | { conversation: FounderConversationDto }
        | { error?: { message?: string } };
      if (!response.ok || !("conversation" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "Bruno could not send that message.")
            : "Bruno could not send that message.",
        );
      }
      setConversation(body.conversation);
      setDraft("");
    } catch (sendError) {
      setError(
        sendError instanceof Error ? sendError.message : "Bruno could not send that message.",
      );
    } finally {
      setSending(false);
    }
  }

  async function resumeCheckpoint() {
    const workId = conversation?.activeWork?.id;
    if (!workId || sending) return;
    setSending(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/conversation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "resume", workId }),
      });
      const body = (await response.json()) as
        | { conversation: FounderConversationDto }
        | { error?: { message?: string } };
      if (!response.ok || !("conversation" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "Bruno could not resume that checkpoint.")
            : "Bruno could not resume that checkpoint.",
        );
      }
      setConversation(body.conversation);
    } catch (resumeError) {
      setError(
        resumeError instanceof Error
          ? resumeError.message
          : "Bruno could not resume that checkpoint.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={styles.card} id="conversation" aria-labelledby="conversation-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Bruno Conversation</p>
          <h3 id="conversation-title">What should we handle today?</h3>
        </div>
        <span className={conversation?.status === "paused" ? styles.paused : styles.ready}>
          {conversation?.status === "paused" ? "Paused" : "Private"}
        </span>
      </div>

      {loading ? <p className={styles.empty}>Loading your conversation…</p> : null}
      {!loading && conversation?.messages.length === 0 ? (
        <p className={styles.empty}>
          Ask Bruno a question or describe the work you want prepared. Your conversation stays in
          this private Founder workspace.
        </p>
      ) : null}
      {conversation?.messages.length ? (
        <div className={styles.messages} aria-live="polite">
          {conversation.messages.map((message) => (
            <ConversationMessage key={message.id} message={message} />
          ))}
        </div>
      ) : null}

      {conversation?.activeWork?.recovery ? (
        <FounderRecoveryStatus
          recovery={conversation.activeWork.recovery}
          onAction={resumeCheckpoint}
        />
      ) : conversation?.activeWork?.state === "paused" ? (
        <div className={styles.pauseNotice} role="status">
          <strong>This message is safely checkpointed.</strong>
          <span>
            {conversation.activeWork.recoveryMessage ??
              "Bruno is waiting for your connected AI account."}
          </span>
          <div className={styles.pauseChoices}>
            <button type="button" onClick={() => void resumeCheckpoint()} disabled={sending}>
              {sending ? "Checking providers…" : "Resume from checkpoint"}
            </button>
            {conversation.activeWork.recoveryChoices.map((choice) =>
              choice.href ? (
                <a key={choice.kind} href={choice.href}>
                  {choice.label}
                </a>
              ) : (
                <span key={choice.kind}>{choice.label}</span>
              ),
            )}
          </div>
        </div>
      ) : null}

      {conversation?.actionPreview ? (
        <FounderActionPreviewCard preview={conversation.actionPreview} compact />
      ) : null}
      {conversation?.proposedAction ? (
        <FounderProposedActionCard
          action={conversation.proposedAction}
          compact
          onUpdated={(action) =>
            setConversation((current) =>
              current ? { ...current, proposedAction: action } : current,
            )
          }
        />
      ) : null}

      <form className={styles.composer} onSubmit={sendMessage}>
        <label htmlFor="founder-conversation-message">Message Bruno</label>
        <textarea
          id="founder-conversation-message"
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="Ask Bruno or describe what you want prepared…"
          rows={3}
          maxLength={12_000}
          disabled={loading || sending}
        />
        <div className={styles.composerFooter}>
          <span>Conversation is saved across reloads and devices.</span>
          <button type="submit" disabled={loading || sending || !draft.trim()}>
            {sending ? "Sending…" : "Send to Bruno"}
          </button>
        </div>
      </form>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ConversationMessage({ message }: { message: FounderConversationMessageDto }) {
  return (
    <article className={styles.message} data-role={message.role} data-status={message.status}>
      <div className={styles.messageMeta}>
        <strong>{message.role === "founder" ? "You" : "Bruno"}</strong>
        {message.status === "paused" ? <span>Paused safely</span> : null}
      </div>
      <p>{message.body}</p>
    </article>
  );
}
