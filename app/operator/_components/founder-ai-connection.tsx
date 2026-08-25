"use client";

import { useEffect, useState } from "react";
import type { FounderAiConnectionDto } from "@/src/server/operators/founder-ai-connection";
import styles from "./founder-ai-connection.module.css";
import { FounderRecoveryStatus } from "./founder-recovery-status";

type Authorization = {
  sessionId: string;
  authorizationUrl: string;
  userCode: string;
  expiresAt: string;
};

type FounderAiProvider = "openai" | "anthropic";

export function FounderAiConnection({ provider = "openai" }: { provider?: FounderAiProvider }) {
  const providerName = provider === "anthropic" ? "Anthropic" : "OpenAI";
  const providerQuery = `?provider=${provider}`;
  const [connection, setConnection] = useState<FounderAiConnectionDto | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/operator/connections${providerQuery}`, { credentials: "same-origin" })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { connection: FounderAiConnectionDto | null })
          : null,
      )
      .then((body) => {
        if (!cancelled && body) setConnection(body.connection);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [providerQuery]);

  useEffect(() => {
    if (!authorization) return;
    const poll = window.setInterval(() => {
      void fetch("/api/operator/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "poll",
          provider,
          sessionId: authorization.sessionId,
        }),
      })
        .then(async (response) =>
          response.ok ? ((await response.json()) as { connection: FounderAiConnectionDto }) : null,
        )
        .then((body) => {
          if (!body) return;
          setConnection(body.connection);
          if (body.connection.status !== "authorizing") setAuthorization(null);
        })
        .catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(poll);
  }, [authorization, provider]);

  async function startAuthorization() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "start", provider }),
      });
      const body = (await response.json()) as
        | { connection: FounderAiConnectionDto; authorization: Authorization | null }
        | { error?: { message?: string } };
      if (!response.ok || !("connection" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? `We could not start ${providerName} authorization.`)
            : `We could not start ${providerName} authorization.`,
        );
      }
      setConnection(body.connection);
      setAuthorization(body.authorization);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : `We could not start ${providerName} authorization.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function action(actionName: "recheck" | "disconnect") {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: actionName, provider }),
      });
      const body = (await response.json()) as {
        connection?: FounderAiConnectionDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.connection)
        throw new Error(body.error?.message ?? "We could not update this connection.");
      setConnection(body.connection);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not update this connection.",
      );
    } finally {
      setBusy(false);
    }
  }

  const ready = connection?.status === "ready";
  const disconnected = connection?.status === "disconnected";
  const needsAction = connection && !ready && !disconnected && connection.status !== "authorizing";

  return (
    <section
      className={styles.card}
      id={`connections-${provider}`}
      aria-labelledby={`ai-connection-title-${provider}`}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your AI Connection</p>
          <h3 id={`ai-connection-title-${provider}`}>
            {ready
              ? `${providerName} is ready`
              : disconnected
                ? `${providerName} is disconnected`
                : `Connect ${providerName}`}
          </h3>
        </div>
        {ready ? <span className={styles.badge}>Ready</span> : null}
      </div>
      <p className={styles.copy}>
        Bruno uses the {providerName} account you attend and connect. Bruno does not ask for an API
        key or silently fund another account.
      </p>
      {connection?.accountLabel ? (
        <p className={styles.account}>{connection.accountLabel}</p>
      ) : null}
      {connection?.recovery ? <FounderRecoveryStatus recovery={connection.recovery} /> : null}
      {!connection?.recovery && connection?.recoveryMessage ? (
        <p className={styles.notice} role="status">
          {connection.recoveryMessage}
        </p>
      ) : null}
      {authorization ? (
        <div className={styles.authorization} role="status">
          <p>Open the {providerName} page, enter this one-time code, then return here.</p>
          <a href={authorization.authorizationUrl} target="_blank" rel="noreferrer">
            Open {providerName} authorization
          </a>
          <strong>{authorization.userCode}</strong>
        </div>
      ) : null}
      <div className={styles.actions}>
        {!ready && !authorization ? (
          <button
            className={styles.button}
            type="button"
            onClick={() => void startAuthorization()}
            disabled={busy}
          >
            {busy
              ? "Starting…"
              : disconnected
                ? `Reconnect ${providerName}`
                : `Connect ${providerName}`}
          </button>
        ) : null}
        {needsAction ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void action("recheck")}
            disabled={busy}
          >
            Check again
          </button>
        ) : null}
        {ready ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void action("disconnect")}
            disabled={busy}
          >
            Disconnect {providerName}
          </button>
        ) : null}
      </div>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      {connection?.receipt ? (
        <p className={styles.receipt}>
          Connection receipt: {connection.receipt.outcome} on{" "}
          {new Date(connection.receipt.issuedAt).toLocaleDateString()}
        </p>
      ) : null}
    </section>
  );
}
