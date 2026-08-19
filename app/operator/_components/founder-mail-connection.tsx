"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  FounderMailConnectionDto,
  FounderMailOfferDisposition,
} from "@/src/server/operators/founder-mail-connection";
import { FounderRecoveryStatus } from "./founder-recovery-status";
import styles from "./founder-mail-connection.module.css";

export function FounderMailConnection({
  releaseControls,
}: {
  releaseControls: FounderMailConnectionDto["release"];
}) {
  const [connection, setConnection] = useState<FounderMailConnectionDto | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offerPreference, setOfferPreference] = useState<"unknown" | FounderMailOfferDisposition>(
    "unknown",
  );

  const applyConnection = useCallback((next: FounderMailConnectionDto | null) => {
    setConnection(next);
    setSelectedIds(
      next?.resources
        .filter((resource) => resource.selected)
        .map((resource) => resource.providerResourceId) ?? [],
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/mail", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Gmail reading could not be loaded.");
        return (await response.json()) as {
          connection: FounderMailConnectionDto | null;
          offerDisposition?: FounderMailOfferDisposition | null;
        };
      })
      .then((body) => {
        if (!cancelled) {
          applyConnection(body.connection);
          if (body.offerDisposition) setOfferPreference(body.offerDisposition);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Gmail reading could not be loaded.",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [applyConnection]);

  async function startAuthorization() {
    await runAction(async () => {
      const body = await post({ action: "start" });
      if (!body.authorization?.authorizationUrl) {
        if (body.connection) applyConnection(body.connection);
        return;
      }
      window.location.assign(body.authorization.authorizationUrl);
    });
  }

  async function saveAndVerify() {
    if (selectedIds.length === 0) {
      setError("Select at least one Gmail label before continuing.");
      return;
    }
    await runAction(async () => {
      const selected = await post({ action: "select", resourceIds: selectedIds });
      if (selected.connection) applyConnection(selected.connection);
      const verified = await post({ action: "verify" });
      if (verified.connection) applyConnection(verified.connection);
    });
  }

  async function disconnect() {
    await runAction(async () => {
      const body = await post({ action: "disconnect" });
      if (body.connection) applyConnection(body.connection);
    });
  }

  async function setOfferDisposition(disposition: FounderMailOfferDisposition) {
    await runAction(async () => {
      const body = await post({ action: "offer", disposition });
      if (body.offerDisposition) setOfferPreference(body.offerDisposition);
    });
  }

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Gmail reading needs attention.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function post(payload: Record<string, unknown>): Promise<{
    connection?: FounderMailConnectionDto | null;
    authorization?: { authorizationUrl: string; expiresAt: string } | null;
    offerDisposition?: FounderMailOfferDisposition | null;
    error?: { message?: string };
  }> {
    const response = await fetch("/api/operator/mail", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      connection?: FounderMailConnectionDto | null;
      authorization?: { authorizationUrl: string; expiresAt: string } | null;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message ?? "Gmail reading needs attention.");
    return body;
  }

  const availableResources = useMemo(
    () => connection?.resources.filter((resource) => resource.status === "available") ?? [],
    [connection],
  );
  const ready = connection?.status === "ready";
  const disconnected = connection?.status === "disconnected";
  const connected = Boolean(connection?.accountLabel && !disconnected);
  const statusCopy =
    connection?.status === "authorizing"
      ? "Finish the Google authorization window, then return here."
      : connection?.status === "selecting"
        ? "Choose exactly which Gmail labels Bruno may read. New labels stay off until you review them."
        : connection?.status === "verifying"
          ? "Bruno is checking the selected Gmail labels now."
          : connection?.status === "needs_attention"
            ? (connection.recoveryMessage ?? "Gmail reading needs one recovery step.")
            : ready
              ? "Gmail reading is current for the labels you selected."
              : "Connect Gmail reading when you want Mail evidence in Bruno.";

  if (!loading && !connection && offerPreference === "dismissed") return null;
  if (!loading && !connection && offerPreference === "unknown") {
    return (
      <section className={styles.card} id="mail" aria-labelledby="mail-offer-title">
        <p className={styles.kicker}>Contextual Connection Offer</p>
        <h3 id="mail-offer-title">Bring Mail evidence into your workspace?</h3>
        <p className={styles.copy}>
          When you explicitly enable this outcome, Bruno can read selected Gmail labels alongside
          your Calendar Connection. This is optional and does not change Calendar access.
        </p>
        <p className={styles.disclosure}>
          {releaseControls.disclosure} Retention is limited to {releaseControls.retentionDays} days.{" "}
          {releaseControls.deletion} AI Limited Use: {releaseControls.aiLimitedUse}
        </p>
        <div className={styles.actions}>
          <button
            className={styles.button}
            type="button"
            onClick={() => void setOfferDisposition("enabled")}
          >
            Review Gmail reading
          </button>
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void setOfferDisposition("dismissed")}
          >
            Not now
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.card} id="mail" aria-labelledby="mail-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your Mail Connection</p>
          <h3 id="mail-title">
            {ready
              ? "Gmail reading is ready"
              : disconnected
                ? "Gmail reading is disconnected"
                : "Connect Gmail reading"}
          </h3>
        </div>
        {ready ? <span className={styles.badge}>Ready</span> : null}
      </div>

      <p className={styles.copy}>
        Bruno requests a separate, read-only Gmail grant. It cannot send mail, modify messages, or
        use this connection to access your whole mailbox without your selected labels.
      </p>
      {connection?.accountLabel ? (
        <p className={styles.account}>{connection.accountLabel}</p>
      ) : null}
      {loading ? <p className={styles.notice}>Loading your Mail Connection…</p> : null}
      {connection?.recovery ? <FounderRecoveryStatus recovery={connection.recovery} /> : null}
      {!loading && !connection?.recovery ? <p className={styles.notice}>{statusCopy}</p> : null}

      {connected && availableResources.length > 0 ? (
        <fieldset className={styles.resources} disabled={busy}>
          <legend>Gmail labels Bruno may read</legend>
          {availableResources.map((resource) => (
            <label className={styles.resource} key={resource.providerResourceId}>
              <input
                type="checkbox"
                checked={selectedIds.includes(resource.providerResourceId)}
                onChange={(event) => {
                  const checked = event.currentTarget.checked;
                  setSelectedIds((current) =>
                    checked
                      ? [...current, resource.providerResourceId]
                      : current.filter((id) => id !== resource.providerResourceId),
                  );
                }}
              />
              <span>
                <strong>{resource.name}</strong>
                <small>
                  {resource.labelType === "system" ? "Google system label" : "Your label"}
                </small>
              </span>
            </label>
          ))}
          <p className={styles.hint}>
            Google may show more labels later. Bruno leaves newly discovered labels unselected until
            you review them.
          </p>
        </fieldset>
      ) : null}

      {connection?.receipt ? (
        <div className={styles.receipt} role="status">
          <strong>Connection Receipt</strong>
          <span>Google granted {formatGrantedScopes(connection.receipt.grantedScopes)}.</span>
          <span>
            Bruno is using {connection.receipt.selectedResourceCount} selected Gmail label
            {connection.receipt.selectedResourceCount === 1 ? "" : "s"}.
          </span>
          <span>
            Evidence is{" "}
            {connection.receipt.evidenceState === "current"
              ? "Current"
              : connection.receipt.evidenceState}
            .
          </span>
          <span>
            Primary Communications Suite:{" "}
            {connection.suite.grouped ? "matched" : connection.suite.status}.
          </span>
        </div>
      ) : null}

      <div className={styles.actions}>
        {!connected || disconnected ? (
          <button
            className={styles.button}
            type="button"
            onClick={() => void startAuthorization()}
            disabled={busy || loading}
          >
            {busy
              ? "Starting…"
              : disconnected
                ? "Reconnect Gmail reading"
                : "Connect Gmail reading"}
          </button>
        ) : null}
        {connected && availableResources.length > 0 ? (
          <button
            className={styles.button}
            type="button"
            onClick={() => void saveAndVerify()}
            disabled={busy || selectedIds.length === 0}
          >
            {busy ? "Checking…" : ready ? "Save and recheck labels" : "Save and verify labels"}
          </button>
        ) : null}
        {connected && !disconnected ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void startAuthorization()}
            disabled={busy}
          >
            Reauthorize Gmail reading
          </button>
        ) : null}
        {connected && !disconnected ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
          >
            Disconnect Gmail reading
          </button>
        ) : null}
      </div>
      <p className={styles.disclosure}>
        {releaseControls.disclosure} Retained Bruno data follows a {releaseControls.retentionDays}
        -day default lifecycle; disconnecting does not claim Google deleted its copies. AI Limited
        Use: {releaseControls.aiLimitedUse}
      </p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function formatGrantedScopes(scopes: string[]): string {
  return scopes.includes("https://www.googleapis.com/auth/gmail.readonly")
    ? "read-only Gmail access"
    : "the reviewed Gmail grant";
}
