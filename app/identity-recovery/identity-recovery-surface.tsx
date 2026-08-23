"use client";

import Link from "next/link";
import { useState } from "react";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import styles from "./identity-recovery.module.css";

export function IdentityRecoverySurface() {
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);

  async function recover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/identity-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assertion: proof }),
      });
      const body = (await response.json()) as {
        recovery?: { state?: string };
        error?: { message?: string };
      };
      if (!response.ok || body.recovery?.state !== "recovered") {
        throw new Error(body.error?.message ?? "Identity recovery was denied.");
      }
      setRecovered(true);
      setProof("");
      setMessage("Identity recovered. Your existing Founder workspace is available again.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Identity recovery was denied.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="identity-recovery-title">
        <Link className={styles.brand} href="/" aria-label="Bruno.Ai home">
          <BrunoLogo compact />
        </Link>
        <p className={styles.kicker}>Identity recovery</p>
        <h1 id="identity-recovery-title">Reconnect to the same Founder workspace</h1>
        <p>
          A lost or deleted Clerk identity pauses access to your existing Operator. It does not
          cancel payment, refund a charge, retire infrastructure, close your account, or delete
          Bruno-local records.
        </p>
        {recovered ? (
          <div className={styles.notice} role="status">
            <p>{message}</p>
            <Link className={styles.primary} href="/operator">
              Return to your Operator
            </Link>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => void recover(event)}>
            <label htmlFor="identity-recovery-proof">Recovery proof</label>
            <textarea
              autoComplete="off"
              id="identity-recovery-proof"
              maxLength={4096}
              onChange={(event) => setProof(event.target.value)}
              required
              rows={5}
              spellCheck={false}
              value={proof}
            />
            <p className={styles.help}>
              Use only the short-lived proof issued after Bruno verifies you are the same internal
              Owner. Email, checkout details, a new Clerk ID, and this browser session are not
              proof.
            </p>
            <button className={styles.primary} disabled={busy || proof.length === 0} type="submit">
              {busy ? "Verifying…" : "Recover my Founder workspace"}
            </button>
          </form>
        )}
        {message && !recovered ? (
          <p className={styles.error} role="alert">
            {message}
          </p>
        ) : null}
        <aside className={styles.boundary} aria-label="Separate account controls">
          <strong>Account Closure stays separate</strong>
          <p>
            Only the recently reauthenticated Account Closure control coordinates external-action
            pause, subscription cancellation, connection revocation, Bruno Data Deletion, and its
            receipts. Refunds remain a separate commerce decision.
          </p>
        </aside>
      </section>
    </main>
  );
}
