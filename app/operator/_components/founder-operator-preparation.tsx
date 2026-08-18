"use client";

import { useEffect, useState } from "react";
import type { FounderOperatorDto } from "@/src/server/operators/founder-operator";
import styles from "./founder-operator-preparation.module.css";

const TIMEZONE_OPTIONS = buildTimezoneOptions();

const TIMEZONE_VALUES: ReadonlySet<string> = new Set(TIMEZONE_OPTIONS.map(([value]) => value));

export function FounderOperatorPreparation({
  initialOperator,
}: {
  initialOperator: FounderOperatorDto;
}) {
  const [operator, setOperator] = useState(initialOperator);
  const [timezone, setTimezone] = useState(initialOperator.preparation.timezone ?? "");
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && TIMEZONE_VALUES.has(detected)) {
      setDetectedTimezone(detected);
      setTimezone((current) => current || detected);
    }
  }, []);

  const preparation = operator.preparation;
  const awaitingTimezone = preparation.status === "awaiting_timezone";

  async function confirmTimezone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ timezone }),
      });
      const body = (await response.json()) as
        | { operator: FounderOperatorDto }
        | { error?: { message?: string } };

      if (!response.ok || !("operator" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "We could not save that timezone.")
            : "We could not save that timezone.",
        );
      }

      setOperator(body.operator);
      setTimezone(body.operator.preparation.timezone ?? timezone.trim());
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "We could not save that timezone. Try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.content}>
      <section className={styles.hero} aria-labelledby="operator-preparation-title">
        <div className={styles.heroSignal} aria-hidden="true">
          <span />
        </div>
        <p className={styles.kicker}>Your Bruno.Ai Operator</p>
        <h2 id="operator-preparation-title">
          {awaitingTimezone
            ? "One quick choice, then Bruno can get to work."
            : "Your Operator is being prepared."}
        </h2>
        <p className={styles.intro}>
          {awaitingTimezone
            ? "Bruno keeps your workspace on your local time. Confirm where you are based and we’ll continue from here if you leave and come back."
            : "Bruno is keeping your progress safe while the private operating workspace is prepared. You can leave this page and return without starting over."}
        </p>
      </section>

      <section className={styles.card} aria-labelledby="timezone-title">
        <div className={styles.cardHeading}>
          <div>
            <p className={styles.kicker}>Your local time</p>
            <h3 id="timezone-title">When should Bruno consider your day?</h3>
          </div>
          {preparation.timezone ? <span className={styles.confirmed}>Confirmed</span> : null}
        </div>
        <form onSubmit={confirmTimezone}>
          <label htmlFor="operator-timezone">Where do you work?</label>
          <select
            id="operator-timezone"
            name="timezone"
            value={timezone}
            onChange={(event) => setTimezone(event.currentTarget.value)}
            required
          >
            <option value="" disabled>
              Choose your local time
            </option>
            {TIMEZONE_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            {detectedTimezone
              ? `We detected ${timezoneLabel(detectedTimezone)}. Change it if that is not right.`
              : "Choose the place whose local time matches your working day."}
          </p>
          <button className={styles.button} type="submit" disabled={saving || !timezone.trim()}>
            {saving ? "Saving…" : preparation.timezone ? "Save timezone" : "Confirm timezone"}
          </button>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </form>
      </section>

      <section className={styles.resume} aria-labelledby="resume-title">
        <p className={styles.kicker}>Safe to resume</p>
        <h3 id="resume-title">Your progress is saved</h3>
        <p>
          This Founder workspace will always return to the next unfinished step. Nothing needs to be
          configured outside Bruno.
        </p>
      </section>
    </div>
  );
}

function timezoneLabel(value: string): string {
  return TIMEZONE_OPTIONS.find(([option]) => option === value)?.[1] ?? "your local time";
}

function buildTimezoneOptions(): ReadonlyArray<readonly [string, string]> {
  const values =
    typeof Intl.supportedValuesOf === "function"
      ? ["UTC", ...Intl.supportedValuesOf("timeZone")]
      : ["UTC", "Asia/Manila", "America/Los_Angeles", "America/New_York"];

  return [...new Set(values)].map((value) => [value, friendlyTimezoneLabel(value)] as const);
}

function friendlyTimezoneLabel(value: string): string {
  const [region, ...placeParts] = value.split("/");
  const place = placeParts.join(" / ").replaceAll("_", " ");
  const readableRegion = (region ?? "Other").replaceAll("_", " ");
  return place ? `${place} (${readableRegion})` : readableRegion;
}
