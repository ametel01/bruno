"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import type { FounderIdentityRecoveryStatusDto } from "@/src/server/users/founder-identity-recovery";
import styles from "./identity-recovery.module.css";

export function IdentityRecoverySurface() {
  const [proof, setProof] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [status, setStatus] = useState<FounderIdentityRecoveryStatusDto | null>(null);

  useEffect(() => {
    let active = true;
    void fetch("/api/identity-recovery", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const body = (await response.json()) as { recovery?: FounderIdentityRecoveryStatusDto };
        return body.recovery ?? null;
      })
      .then((recovery) => {
        if (!active || !recovery) return;
        setStatus(recovery);
        setRecovered(recovery.state === "recovered");
        if (recovery.state === "recovered") {
          setMessage(
            `Identity recovered ${new Date(recovery.recoveredAt).toLocaleString()}. Your existing Founder workspace is available again.`,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function recover(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/identity-recovery", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recoveryCode: proof }),
      });
      const body = (await response.json()) as {
        recovery?: FounderIdentityRecoveryStatusDto;
        error?: { message?: string };
      };
      if (!response.ok || body.recovery?.state !== "recovered") {
        throw new Error(body.error?.message ?? "Identity recovery was denied.");
      }
      setRecovered(true);
      setStatus(body.recovery);
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
          cancel payment, refund a charge, begin Infrastructure Retirement, request Account Closure,
          or delete Bruno-local records.
        </p>
        <p>
          Start by{" "}
          <Link href="/sign-in?continue=identity-recovery">signing in for Identity Recovery</Link>.
          This return path does not create a new internal Owner before your code is checked.
        </p>
        {status && status.state !== "recovered" ? (
          <p className={styles.notice} role="status">
            {recoveryStateMessage(status.state)}
          </p>
        ) : null}
        {recovered ? (
          <div className={styles.notice} role="status">
            <p>{message}</p>
            <Link className={styles.primary} href="/operator">
              Return to your Operator
            </Link>
          </div>
        ) : (
          <form className={styles.form} onSubmit={(event) => void recover(event)}>
            <label htmlFor="identity-recovery-proof">Identity Recovery code</label>
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
              Use the one-time code you created after recent reauthentication, before losing the
              original identity. Email, checkout details, a new Clerk ID, and this browser session
              are not proof.
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
        {status?.state === "recovered" ? (
          <section className={styles.boundary} aria-labelledby="identity-receipts-title">
            <h2 id="identity-receipts-title">Identity Recovery receipts</h2>
            <p>
              These receipts describe identity only. They do not claim any commerce or deletion.
            </p>
            <ul>
              {status.receipts.map((receipt) => (
                <li key={`${receipt.kind}:${receipt.occurredAt}`}>
                  {receiptLabel(receipt.kind)} · {new Date(receipt.occurredAt).toLocaleString()}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <aside className={styles.boundary} aria-label="Account Closure boundary">
          <strong>Account Closure stays separate</strong>
          <p>
            Only the recently reauthenticated Account Closure control coordinates external-action
            pause, subscription cancellation, connection revocation, Bruno Data Deletion, and its
            receipts. Refunds remain a separate commerce decision. Identity Recovery receipts show
            only identity loss, denied attempts, and successful rebound.
          </p>
        </aside>
      </section>
    </main>
  );
}

function receiptLabel(
  kind: "identity_loss_recorded" | "recovery_denied" | "identity_rebound",
): string {
  if (kind === "identity_loss_recorded") return "Identity loss recorded";
  if (kind === "recovery_denied") return "Recovery attempt denied";
  return "Identity rebound to the same Owner";
}

function recoveryStateMessage(state: "proof_required" | "recovery_required" | "current"): string {
  if (state === "recovery_required") {
    return "Identity loss is recorded. Operator access remains denied until strong same-Owner recovery succeeds.";
  }
  if (state === "current") return "This is the current Owner identity; no recovery is pending.";
  return "A replacement identity needs the one-time code created by the same Owner before identity loss.";
}
