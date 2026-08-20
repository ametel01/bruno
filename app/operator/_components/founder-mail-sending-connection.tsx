"use client";

import { useEffect, useState } from "react";
import type { FounderMailSendingConnectionDto } from "@/src/server/operators/founder-mail-sending-connection";
import styles from "./founder-mail-connection.module.css";
import { FounderRecoveryStatus } from "./founder-recovery-status";

export function FounderMailSendingConnection() {
  const [connection, setConnection] = useState<FounderMailSendingConnectionDto | null>(null);
  const [offerAvailable, setOfferAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/operator/mail-sending", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Mail Sending could not be loaded.");
        return (await response.json()) as {
          connection: FounderMailSendingConnectionDto | null;
          offerAvailable: boolean;
        };
      })
      .then((body) => {
        setConnection(body.connection);
        setOfferAvailable(body.offerAvailable);
      })
      .catch((loadError) =>
        setError(
          loadError instanceof Error ? loadError.message : "Mail Sending could not be loaded.",
        ),
      )
      .finally(() => setLoading(false));
  }, []);

  async function run(action: "start" | "verify" | "disconnect") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/mail-sending", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action }),
      });
      const body = (await response.json()) as {
        connection?: FounderMailSendingConnectionDto | null;
        authorization?: { authorizationUrl?: string };
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "Mail Sending needs attention.");
      if (action === "start" && body.authorization?.authorizationUrl)
        window.location.assign(body.authorization.authorizationUrl);
      if (body.connection !== undefined) setConnection(body.connection);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Mail Sending needs attention.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!loading && !connection && !offerAvailable) return null;
  const ready = connection?.status === "ready";
  const disconnected = connection?.status === "disconnected";
  return (
    <section className={styles.card} id="mail-sending" aria-labelledby="mail-sending-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Optional Mail Sending Connection</p>
          <h3 id="mail-sending-title">
            {ready
              ? "Send-only Gmail is ready"
              : disconnected
                ? "Mail Sending is disconnected"
                : "Review send-only Gmail"}
          </h3>
        </div>
        {ready ? <span className={styles.badge}>Ready</span> : null}
      </div>
      <p className={styles.copy}>
        This is a separate Google project, OAuth grant, credential, revocation boundary, and
        receipt. It requests only{" "}
        <strong>
          {connection?.release.requiredScope ?? "https://www.googleapis.com/auth/gmail.send"}
        </strong>
        ; it cannot read, modify, or delete mail.
      </p>
      {connection?.accountLabel ? (
        <p className={styles.account}>{connection.accountLabel}</p>
      ) : null}
      {loading ? (
        <p className={styles.notice} role="status" aria-live="polite">
          Loading your Mail Sending Connection…
        </p>
      ) : null}
      {connection?.recovery ? <FounderRecoveryStatus recovery={connection.recovery} /> : null}
      {!connection?.recovery && !loading && connection?.recoveryMessage ? (
        <p className={styles.notice} role="status" aria-live="polite">
          {connection.recoveryMessage}
        </p>
      ) : null}
      {!loading && !connection ? (
        <p className={styles.notice} role="status" aria-live="polite">
          This offer appears only beside an approved sending outcome or its first send preview.
          Dismiss it once and it will not nag you.
        </p>
      ) : null}
      <p className={styles.disclosure}>
        Disconnecting this capability does not revoke or degrade Gmail reading or Calendar.
      </p>
      <div className={styles.actions}>
        {!ready ? (
          <button
            className={styles.button}
            type="button"
            disabled={busy}
            onClick={() => void run("start")}
          >
            {busy ? "Opening Google…" : "Review send-only access"}
          </button>
        ) : (
          <button
            className={styles.secondary}
            type="button"
            disabled={busy}
            onClick={() => void run("verify")}
          >
            Verify same account
          </button>
        )}
        {connection && !disconnected ? (
          <button
            className={styles.secondary}
            type="button"
            disabled={busy}
            onClick={() => void run("disconnect")}
          >
            Disconnect Sending
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
