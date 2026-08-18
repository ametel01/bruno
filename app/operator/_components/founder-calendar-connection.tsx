"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { FounderCalendarConnectionDto } from "@/src/server/operators/founder-calendar-connection";
import styles from "./founder-calendar-connection.module.css";

export function FounderCalendarConnection() {
  const [connection, setConnection] = useState<FounderCalendarConnectionDto | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyConnection = useCallback((next: FounderCalendarConnectionDto | null) => {
    setConnection(next);
    setSelectedIds(
      next?.resources
        .filter((resource) => resource.selected)
        .map((resource) => resource.providerResourceId) ?? [],
    );
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/operator/calendar", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Google Calendar could not be loaded.");
        return (await response.json()) as { connection: FounderCalendarConnectionDto | null };
      })
      .then((body) => {
        if (!cancelled) applyConnection(body.connection);
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : "Google Calendar could not be loaded.",
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
      setError("Select at least one calendar before continuing.");
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

  async function runAction(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Google Calendar needs attention.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function post(payload: Record<string, unknown>): Promise<{
    connection?: FounderCalendarConnectionDto | null;
    authorization?: { authorizationUrl: string; expiresAt: string } | null;
    error?: { message?: string };
  }> {
    const response = await fetch("/api/operator/calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    const body = (await response.json()) as {
      connection?: FounderCalendarConnectionDto | null;
      authorization?: { authorizationUrl: string; expiresAt: string } | null;
      error?: { message?: string };
    };
    if (!response.ok) throw new Error(body.error?.message ?? "Google Calendar needs attention.");
    return body;
  }

  const availableResources = useMemo(
    () => connection?.resources.filter((resource) => resource.status === "available") ?? [],
    [connection],
  );
  const ready = connection?.status === "ready";
  const disconnected = connection?.status === "disconnected";
  const connected = Boolean(connection?.accountLabel && !disconnected);
  const selectedCount = selectedIds.length;
  const statusCopy =
    connection?.status === "authorizing"
      ? "Finish the Google authorization window, then return here."
      : connection?.status === "selecting"
        ? "Choose exactly which calendars Bruno may read. New calendars stay off until you review them."
        : connection?.status === "verifying"
          ? "Bruno is checking the selected calendars now."
          : connection?.status === "needs_attention"
            ? (connection.recoveryMessage ?? "Google Calendar needs one recovery step.")
            : ready
              ? "Google Calendar is current for the calendars you selected."
              : "Connect Google Calendar to prepare your Founder Morning Brief.";

  return (
    <section className={styles.card} id="calendar" aria-labelledby="calendar-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Your Calendar Connection</p>
          <h3 id="calendar-title">
            {ready
              ? "Google Calendar is ready"
              : disconnected
                ? "Google Calendar is disconnected"
                : "Connect Google Calendar"}
          </h3>
        </div>
        {ready ? <span className={styles.badge}>Ready</span> : null}
      </div>

      <p className={styles.copy}>
        Bruno asks for read-only Calendar access in its own Google connection. You choose which
        calendars it may use; Bruno does not copy your whole calendar into its database.
      </p>
      {connection?.accountLabel ? (
        <p className={styles.account}>{connection.accountLabel}</p>
      ) : null}
      {loading ? <p className={styles.notice}>Loading your Calendar Connection…</p> : null}
      {!loading ? <p className={styles.notice}>{statusCopy}</p> : null}

      {connected && availableResources.length > 0 ? (
        <fieldset
          className={styles.resources}
          disabled={busy || connection?.status === "authorizing"}
        >
          <legend>Calendars Bruno may read</legend>
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
                <strong>{resource.summary}</strong>
                <small>
                  {resource.primaryCalendar
                    ? "Primary calendar"
                    : (resource.timeZone ?? "Calendar")}
                </small>
              </span>
            </label>
          ))}
          <p className={styles.hint}>
            Google may show other calendars later. Bruno leaves newly discovered calendars
            unselected until you review them.
          </p>
        </fieldset>
      ) : null}

      {connection?.receipt ? (
        <div className={styles.receipt} role="status">
          <strong>Connection Receipt</strong>
          <span>Google granted {formatGrantedScopes(connection.receipt.grantedScopes)}.</span>
          <span>
            Bruno is using {connection.receipt.selectedResourceCount} selected calendar
            {connection.receipt.selectedResourceCount === 1 ? "" : "s"}.
          </span>
          <span>
            Evidence is{" "}
            {connection.receipt.evidenceState === "current"
              ? "Current"
              : connection.receipt.evidenceState}
            .
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
                ? "Reconnect Google Calendar"
                : "Connect Google Calendar"}
          </button>
        ) : null}
        {connected && availableResources.length > 0 ? (
          <button
            className={styles.button}
            type="button"
            onClick={() => void saveAndVerify()}
            disabled={busy || selectedCount === 0}
          >
            {busy
              ? "Checking…"
              : ready
                ? "Save and recheck calendars"
                : "Save and verify calendars"}
          </button>
        ) : null}
        {connected && !disconnected ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void startAuthorization()}
            disabled={busy}
          >
            Reauthorize Google Calendar
          </button>
        ) : null}
        {connected && !disconnected ? (
          <button
            className={styles.secondary}
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
          >
            Disconnect Google Calendar
          </button>
        ) : null}
      </div>
      <p className={styles.disclosure}>
        Disconnect removes Bruno’s local access and attempts Google revocation. Your Google Calendar
        data remains in Google.
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
  return scopes.includes("https://www.googleapis.com/auth/calendar.readonly")
    ? "read-only Calendar access"
    : "the reviewed Calendar grant";
}
