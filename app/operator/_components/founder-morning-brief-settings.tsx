"use client";

import { useEffect, useState } from "react";
import styles from "./founder-limited-operation.module.css";

export function FounderMorningBriefSettings() {
  const [time, setTime] = useState("07:00");
  const [timezone, setTimezone] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void fetch("/api/operator/morning-brief/settings", { credentials: "same-origin" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { preferences?: { localTime?: string; timezone?: string | null } } | null) => {
        if (body?.preferences?.localTime) setTime(body.preferences.localTime);
        if (body?.preferences) setTimezone(body.preferences.timezone ?? null);
      })
      .catch(() => undefined);
  }, []);
  async function save() {
    setBusy(true);
    setSaved(false);
    try {
      const response = await fetch("/api/operator/morning-brief/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ deliveryLocalTime: time }),
      });
      if (response.ok) setSaved(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      className={styles.hint}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label htmlFor="morning-brief-delivery-time">Daily brief time</label>{" "}
      <input
        id="morning-brief-delivery-time"
        type="time"
        value={time}
        onChange={(event) => setTime(event.currentTarget.value)}
        disabled={busy}
      />{" "}
      <button className={styles.button} type="submit" disabled={busy}>
        {busy ? "Saving…" : "Save"}
      </button>
      <span>
        {timezone ? `Founder timezone: ${timezone}.` : "Uses your confirmed Founder timezone."}
      </span>
      {saved ? <span role="status"> Saved.</span> : null}
    </form>
  );
}
