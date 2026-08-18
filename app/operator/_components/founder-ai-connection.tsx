"use client";

import { useEffect, useState } from "react";
import type { FounderAiConnectionDto } from "@/src/server/operators/founder-ai-connection";
import styles from "./founder-ai-connection.module.css";

type Authorization = {
  sessionId: string;
  authorizationUrl: string;
  userCode: string;
  expiresAt: string;
};

export function FounderAiConnection() {
  const [connection, setConnection] = useState<FounderAiConnectionDto | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/connections", { credentials: "same-origin" })
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
  }, []);

  useEffect(() => {
    if (!authorization) return;
    const poll = window.setInterval(() => {
      void fetch("/api/operator/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "poll", sessionId: authorization.sessionId }),
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
  }, [authorization]);

  async function startAuthorization() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "start" }),
      });
      const body = (await response.json()) as
        | { connection: FounderAiConnectionDto; authorization: Authorization | null }
        | { error?: { message?: string } };
      if (!response.ok || !("connection" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "We could not start OpenAI authorization.")
            : "We could not start OpenAI authorization.",
        );
      }
      setConnection(body.connection);
      setAuthorization(body.authorization);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not start OpenAI authorization.",
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
        body: JSON.stringify({ action: actionName }),
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
    <section className={styles.card} id="connections" aria-labelledby="ai-connection-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your AI Connection</p>
          <h3 id="ai-connection-title">
            {ready ? "OpenAI is ready" : disconnected ? "OpenAI is disconnected" : "Connect OpenAI"}
          </h3>
        </div>
        {ready ? <span className={styles.badge}>Ready</span> : null}
      </div>
      <p className={styles.copy}>
        Bruno uses the OpenAI account you attend and connect. Bruno does not ask for an API key or
        silently fund another account.
      </p>
      {connection?.accountLabel ? (
        <p className={styles.account}>{connection.accountLabel}</p>
      ) : null}
      {connection?.recoveryMessage ? (
        <p className={styles.notice} role="status">
          {connection.recoveryMessage}
        </p>
      ) : null}
      {authorization ? (
        <div className={styles.authorization} role="status">
          <p>Open the OpenAI page, enter this one-time code, then return here.</p>
          <a href={authorization.authorizationUrl} target="_blank" rel="noreferrer">
            Open OpenAI authorization
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
            {busy ? "Starting…" : disconnected ? "Reconnect OpenAI" : "Connect OpenAI"}
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
            Disconnect OpenAI
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
