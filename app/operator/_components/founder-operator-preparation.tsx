"use client";

import { useEffect, useRef, useState } from "react";
import type { FounderMailConnectionDto } from "@/src/server/operators/founder-mail-connection";
import type { FounderOnboardingDto } from "@/src/server/operators/founder-onboarding";
import type { FounderOperatorDto } from "@/src/server/operators/founder-operator";
import type { FounderRecoveryArchiveStatusDto } from "@/src/server/founder-product-contract/recovery-archive";
import {
  DEFAULT_FOUNDER_TIMEZONE_OPTIONS,
  type FounderTimezoneOption,
} from "@/src/shared/founder-timezones";
import { FounderActionInbox } from "./founder-action-inbox";
import { FounderAiConnection } from "./founder-ai-connection";
import { FounderCalendarConnection } from "./founder-calendar-connection";
import { FounderConversation } from "./founder-conversation";
import { FounderCoreOperation } from "./founder-core-operation";
import { FounderLimitedOperation } from "./founder-limited-operation";
import { FounderMailConnection } from "./founder-mail-connection";
import { FounderMailSendingConnection } from "./founder-mail-sending-connection";
import styles from "./founder-operator-preparation.module.css";
import { FounderRelationships } from "./founder-relationships";

export function FounderOperatorPreparation({
  initialOperator,
  initialOnboarding,
  initialRecoveryArchive,
  timezoneOptions = DEFAULT_FOUNDER_TIMEZONE_OPTIONS,
  openAiReleased = false,
  calendarReadingReleased = false,
  mailReadingReleased = false,
  mailSendingReleased = false,
  mailReleaseControls,
}: {
  initialOperator: FounderOperatorDto;
  initialOnboarding?: FounderOnboardingDto;
  initialRecoveryArchive?: FounderRecoveryArchiveStatusDto;
  timezoneOptions?: ReadonlyArray<FounderTimezoneOption>;
  openAiReleased?: boolean;
  calendarReadingReleased?: boolean;
  mailReadingReleased?: boolean;
  mailSendingReleased?: boolean;
  mailReleaseControls?: FounderMailConnectionDto["release"] | undefined;
}) {
  const [operator, setOperator] = useState(initialOperator);
  const [timezone, setTimezone] = useState(initialOperator.preparation.timezone ?? "");
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const lastOpenedStep = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void fetch("/api/operator/onboarding", { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as { onboarding?: FounderOnboardingDto };
        })
        .then((body) => {
          if (!cancelled && body?.onboarding) setOnboarding(body.onboarding);
        })
        .catch(() => undefined);
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, []);

  useEffect(() => {
    if (
      !onboarding ||
      lastOpenedStep.current === `${onboarding.nextStep}:${onboarding.activated}`
    ) {
      return;
    }
    lastOpenedStep.current = `${onboarding.nextStep}:${onboarding.activated}`;
    const targetId = onboarding.activated
      ? "conversation"
      : onboarding.nextStep === "ai"
        ? "connections"
        : onboarding.nextStep;
    window.history.replaceState(null, "", `/operator#${targetId}`);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(targetId)
      ?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [onboarding]);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && timezoneOptions.some(([value]) => value === detected)) {
      setDetectedTimezone(detected);
      setTimezone((current) => current || detected);
    }
  }, [timezoneOptions]);

  useEffect(() => {
    if (
      initialOperator.preparation.status === "awaiting_timezone" ||
      (initialOperator.runtime && initialOperator.runtime.status !== "preparing")
    ) {
      return;
    }

    let cancelled = false;
    void fetch("/api/operator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "prepare" }),
    })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { operator?: FounderOperatorDto };
      })
      .then((body) => {
        if (!cancelled && body?.operator) setOperator(body.operator);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [initialOperator]);

  const preparation = operator.preparation;
  const awaitingTimezone = preparation.status === "awaiting_timezone";
  const runtime = operator.runtime;
  const runtimeReady = runtime?.status === "ready";
  const runtimeNeedsAttention = runtime?.status === "needs_attention";
  const activated = onboarding?.activated === true;

  async function confirmTimezone(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await saveTimezone();
  }

  async function saveTimezone() {
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

      const preparationResponse = await fetch("/api/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "prepare" }),
      });
      const preparationBody = (await preparationResponse.json()) as
        | { operator: FounderOperatorDto }
        | { error?: { message?: string } };
      if (preparationResponse.ok && "operator" in preparationBody) {
        setOperator(preparationBody.operator);
      }
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
            : runtimeReady
              ? "Your Operator is ready."
              : runtimeNeedsAttention
                ? "Your Operator needs one recovery step."
                : "Your Operator is being prepared."}
        </h2>
        <p className={styles.intro}>
          {awaitingTimezone
            ? "Bruno keeps your workspace on your local time. Confirm where you are based and we’ll continue from here if you leave and come back."
            : runtimeReady
              ? "Your private operating workspace is ready. Bruno will keep its progress and provider setup in place across restarts."
              : runtimeNeedsAttention
                ? (runtime?.recoveryMessage ??
                  "Bruno could not finish preparing the private workspace.")
                : "Bruno is keeping your progress safe while the private operating workspace is prepared. You can leave this page and return without starting over."}
        </p>
      </section>

      {onboarding ? (
        <section
          className={styles.card}
          id={`onboarding-${onboarding.nextStep}`}
          data-next-step={onboarding.nextStep}
          aria-labelledby="onboarding-next-step-title"
        >
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>{onboarding.activated ? "Now" : "Needs you"}</p>
              <h3 id="onboarding-next-step-title">
                {onboarding.activated
                  ? "Your current brief and Conversation are ready."
                  : `Next step: ${onboardingStepLabel(onboarding.nextStep)}`}
              </h3>
            </div>
            <span className={styles.confirmed}>
              {onboarding.operation === "core" ? "Core Operation" : "Saved"}
            </span>
          </div>
          <p className={styles.hint}>
            {onboarding.activated
              ? "Bruno opens the active workspace here after every refresh."
              : "This step is derived from the latest saved connection, consent, and evidence state."}
          </p>
          <p className={styles.hint}>
            Capabilities — AI: {capabilityLabel(onboarding.capabilities.ai)}; Calendar:{" "}
            {capabilityLabel(onboarding.capabilities.calendar)}; Mail:{" "}
            {capabilityLabel(onboarding.capabilities.mail)}; Core:{" "}
            {capabilityLabel(onboarding.capabilities.core)}.
          </p>
        </section>
      ) : null}

      {!awaitingTimezone && runtimeNeedsAttention ? (
        <section className={styles.card} aria-labelledby="recovery-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>Needs you</p>
              <h3 id="recovery-title">Try preparing again</h3>
            </div>
          </div>
          <button
            className={styles.button}
            type="button"
            onClick={() => void saveTimezone()}
            disabled={saving}
          >
            {saving ? "Trying again…" : "Try again"}
          </button>
        </section>
      ) : null}

      {activated && runtimeReady ? (
        <section className={styles.workspace} aria-label="Current Founder workspace">
          <div className={styles.workspaceConversation}>
            <FounderConversation showDecisionContext={false} />
          </div>
          <div className={styles.workspaceBrief}>
            {onboarding?.operation === "core" ? (
              <FounderCoreOperation />
            ) : (
              <FounderLimitedOperation />
            )}
          </div>
          <div className={styles.workspaceNeeds}>
            <FounderActionInbox mailSendingReleased={mailSendingReleased} />
          </div>
        </section>
      ) : null}

      <section className={styles.card} id="onboarding-timezone" aria-labelledby="timezone-title">
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
            {timezoneOptions.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className={styles.hint}>
            {detectedTimezone
              ? `We detected ${timezoneLabel(timezoneOptions, detectedTimezone)}. Change it if that is not right.`
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

      {!activated && runtimeReady ? <FounderConversation /> : null}

      {!activated && runtimeReady ? (
        <FounderActionInbox mailSendingReleased={mailSendingReleased} />
      ) : null}

      {runtimeReady && mailSendingReleased ? <FounderMailSendingConnection /> : null}

      {runtimeReady && openAiReleased ? <FounderAiConnection /> : null}

      {runtimeReady && calendarReadingReleased ? <FounderCalendarConnection /> : null}

      {runtimeReady && mailReadingReleased && mailReleaseControls ? (
        <FounderMailConnection releaseControls={mailReleaseControls} />
      ) : null}

      {!activated && runtimeReady && onboarding?.operation === "core" ? (
        <FounderCoreOperation />
      ) : null}

      {!activated && runtimeReady && onboarding?.operation !== "core" ? (
        <FounderLimitedOperation />
      ) : null}

      {runtimeReady ? <FounderRelationships /> : null}

      {initialRecoveryArchive ? (
        <section className={styles.card} aria-labelledby="protected-recovery-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>Protected recovery</p>
              <h3 id="protected-recovery-title">
                {recoveryArchiveHeading(initialRecoveryArchive.state)}
              </h3>
            </div>
            <span className={styles.confirmed}>
              {recoveryArchiveBadge(initialRecoveryArchive.state)}
            </span>
          </div>
          <p className={styles.hint}>
            {initialRecoveryArchive.state === "failed" ||
            initialRecoveryArchive.state === "unavailable"
              ? "Bruno could not verify current recovery protection. Connected provider access is never copied."
              : "Bruno keeps a daily encrypted Recovery Archive outside the private workspace and proves it can rebuild the saved Operator state. Connected provider access is never copied and must be authorized again after a restore."}
          </p>
          {initialRecoveryArchive.restoreVerifiedAt ? (
            <p className={styles.hint}>
              Last restore check: {formatRecoveryDate(initialRecoveryArchive.restoreVerifiedAt)}.
              Copies expire automatically after 30 days.
            </p>
          ) : null}
          {initialRecoveryArchive.deletion?.status === "completed" ? (
            <p className={styles.hint}>
              The last expired Recovery Archive and its recovery access were safely deleted.
            </p>
          ) : null}
          {initialRecoveryArchive.deletion?.status === "pending" ? (
            <p className={styles.hint}>Expired Recovery Archive deletion is being verified.</p>
          ) : null}
          {initialRecoveryArchive.deletion?.status === "failed" ? (
            <p className={styles.hint}>Expired Recovery Archive deletion needs attention.</p>
          ) : null}
        </section>
      ) : null}

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

function timezoneLabel(
  timezoneOptions: ReadonlyArray<FounderTimezoneOption>,
  value: string,
): string {
  return timezoneOptions.find(([option]) => option === value)?.[1] ?? "your local time";
}

function onboardingStepLabel(step: FounderOnboardingDto["nextStep"]): string {
  return {
    timezone: "Confirm your local time",
    runtime: "Prepare your private workspace",
    ai: "Connect your Ready AI Connection",
    calendar: "Connect your Ready Calendar Connection",
    mail: "Review Mail evidence access",
    consent: "Confirm Processing Consent",
    brief: "Open your Founder Morning Brief",
    activation: "Activate your Founder workspace",
    conversation: "Open Conversation",
  }[step];
}

function capabilityLabel(state: FounderOnboardingDto["capabilities"]["ai"]): string {
  return {
    ready: "Ready",
    missing: "Not connected",
    authorizing: "In progress",
    stale: "Needs a fresh check",
    mismatch: "Accounts do not match",
    deferred: "Deferred",
    not_offered: "Not offered",
  }[state];
}

function formatRecoveryDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

function recoveryArchiveHeading(state: FounderRecoveryArchiveStatusDto["state"]): string {
  return {
    current: "Recovery Archive verified",
    due: "Recovery Archive verification is due",
    failed: "Recovery Archive needs attention",
    unavailable: "Recovery Archive unavailable",
  }[state];
}

function recoveryArchiveBadge(state: FounderRecoveryArchiveStatusDto["state"]): string {
  return { current: "Current", due: "Due", failed: "Attention", unavailable: "Unavailable" }[state];
}
