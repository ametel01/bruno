"use client";

import { useEffect, useRef, useState } from "react";
import type { FounderMailConnectionDto } from "@/src/server/operators/founder-mail-connection";
import type { FounderOnboardingDto } from "@/src/server/operators/founder-onboarding";
import type { FounderOperatorDto } from "@/src/server/operators/founder-operator";
import type { FounderRecoveryArchiveStatusDto } from "@/src/server/founder-product-contract/recovery-archive";
import type { FounderInfrastructureRetirementStatusDto } from "@/src/server/founder-product-contract/infrastructure-retirement";
import {
  type FounderOwnerPreviewStatus,
  projectFounderOwnerPreviewStatus,
} from "@/src/server/founder-product-contract/owner-preview-status";
import {
  FOUNDER_OPERATOR_LEGACY_COMPATIBILITY_EXPERIENCE,
  type FounderOperatorExperience,
} from "@/src/shared/founder-operator-experience";
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
  initialInfrastructureRetirement,
  ownerPreviewAdmitted = false,
  ownerPreviewWorkAllowed = ownerPreviewAdmitted,
  ownerPreview,
  experience = "owner_preview",
  trustedPreviewInvitationToken,
  timezoneOptions = DEFAULT_FOUNDER_TIMEZONE_OPTIONS,
  openAiReleased = false,
  calendarReadingReleased = false,
  mailReadingReleased = false,
  mailSendingReleased = false,
  mailReleaseControls,
}: {
  initialOperator: FounderOperatorDto | null;
  initialOnboarding?: FounderOnboardingDto;
  initialRecoveryArchive?: FounderRecoveryArchiveStatusDto;
  initialInfrastructureRetirement?: FounderInfrastructureRetirementStatusDto;
  ownerPreviewAdmitted?: boolean;
  ownerPreviewWorkAllowed?: boolean;
  ownerPreview?: FounderOwnerPreviewStatus;
  experience?: FounderOperatorExperience;
  trustedPreviewInvitationToken?: string;
  timezoneOptions?: ReadonlyArray<FounderTimezoneOption>;
  openAiReleased?: boolean;
  calendarReadingReleased?: boolean;
  mailReadingReleased?: boolean;
  mailSendingReleased?: boolean;
  mailReleaseControls?: FounderMailConnectionDto["release"] | undefined;
}) {
  const [operator, setOperator] = useState(initialOperator);
  const [timezone, setTimezone] = useState(initialOperator?.preparation.timezone ?? "");
  const [detectedTimezone, setDetectedTimezone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [onboarding, setOnboarding] = useState(initialOnboarding);
  const [admitted, setAdmitted] = useState(ownerPreviewAdmitted);
  const [workAllowed, setWorkAllowed] = useState(ownerPreviewWorkAllowed);
  const [previewStatus, setPreviewStatus] = useState<FounderOwnerPreviewStatus>(
    ownerPreview ??
      fallbackOwnerPreviewStatus(
        ownerPreviewAdmitted,
        ownerPreviewWorkAllowed,
        Boolean(trustedPreviewInvitationToken),
      ),
  );
  const ownerPreviewExperience = experience === "owner_preview";
  const lastOpenedStep = useRef<string | null>(null);

  useEffect(() => {
    if (!operator) return;
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
  }, [operator]);

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
    const route = ownerPreviewExperience
      ? `/operator#${targetId}`
      : `/operator?experience=${FOUNDER_OPERATOR_LEGACY_COMPATIBILITY_EXPERIENCE}#${targetId}`;
    window.history.replaceState(null, "", route);
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(targetId)
      ?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
  }, [onboarding, ownerPreviewExperience]);

  useEffect(() => {
    const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (detected && timezoneOptions.some(([value]) => value === detected)) {
      setDetectedTimezone(detected);
      setTimezone((current) => current || detected);
    }
  }, [timezoneOptions]);

  useEffect(() => {
    if (
      !initialOperator ||
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
        return (await response.json()) as {
          operator?: FounderOperatorDto;
          ownerPreviewAdmitted?: boolean;
          ownerPreviewWorkAllowed?: boolean;
          ownerPreview?: FounderOwnerPreviewStatus;
        };
      })
      .then((body) => {
        if (!cancelled && body?.operator) {
          setOperator(body.operator);
          setAdmitted(body.ownerPreviewAdmitted === true);
          setWorkAllowed(body.ownerPreviewWorkAllowed === true);
          if (body.ownerPreview) setPreviewStatus(body.ownerPreview);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [initialOperator]);

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
        | {
            operator: FounderOperatorDto;
            ownerPreviewAdmitted?: boolean;
            ownerPreviewWorkAllowed?: boolean;
            ownerPreview?: FounderOwnerPreviewStatus;
          }
        | { error?: { message?: string } };
      if (preparationResponse.ok && "operator" in preparationBody) {
        setOperator(preparationBody.operator);
        setAdmitted(preparationBody.ownerPreviewAdmitted === true);
        setWorkAllowed(preparationBody.ownerPreviewWorkAllowed === true);
        if (preparationBody.ownerPreview) setPreviewStatus(preparationBody.ownerPreview);
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

  async function startPreparation() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "prepare" }),
      });
      const body = (await response.json()) as
        | {
            operator: FounderOperatorDto;
            ownerPreviewAdmitted?: boolean;
            ownerPreviewWorkAllowed?: boolean;
            ownerPreview?: FounderOwnerPreviewStatus;
          }
        | { error?: { message?: string } };
      if (!response.ok || !("operator" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "We could not begin preparing your Operator.")
            : "We could not begin preparing your Operator.",
        );
      }
      setOperator(body.operator);
      setTimezone(body.operator.preparation.timezone ?? "");
      setAdmitted(body.ownerPreviewAdmitted === true);
      setWorkAllowed(body.ownerPreviewWorkAllowed === true);
      if (body.ownerPreview) setPreviewStatus(body.ownerPreview);
    } catch (preparationError) {
      setError(
        preparationError instanceof Error
          ? preparationError.message
          : "We could not begin preparing your Operator.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function enterOwnerPreview() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "enter_owner_preview" }),
      });
      const body = (await response.json()) as
        | {
            ownerPreviewAdmitted: boolean;
            ownerPreviewWorkAllowed: boolean;
            ownerPreview: FounderOwnerPreviewStatus;
          }
        | { error?: { message?: string } };
      if (!response.ok || !("ownerPreview" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "Owner Preview could not be entered.")
            : "Owner Preview could not be entered.",
        );
      }
      setAdmitted(body.ownerPreviewAdmitted);
      setWorkAllowed(body.ownerPreviewWorkAllowed);
      setPreviewStatus(body.ownerPreview);
    } catch (admissionError) {
      setError(
        admissionError instanceof Error
          ? admissionError.message
          : "Owner Preview could not be entered.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function acceptTrustedPreviewInvitation() {
    if (!trustedPreviewInvitationToken) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "accept_trusted_preview_invitation",
          invitationToken: trustedPreviewInvitationToken,
        }),
      });
      const body = (await response.json()) as
        | {
            ownerPreviewAdmitted: boolean;
            ownerPreviewWorkAllowed: boolean;
            ownerPreview: FounderOwnerPreviewStatus;
          }
        | { error?: { message?: string } };
      if (!response.ok || !("ownerPreview" in body)) {
        throw new Error(
          "error" in body
            ? (body.error?.message ?? "Trusted Preview could not be entered.")
            : "Trusted Preview could not be entered.",
        );
      }
      setAdmitted(body.ownerPreviewAdmitted);
      setWorkAllowed(body.ownerPreviewWorkAllowed);
      setPreviewStatus(body.ownerPreview);
      window.history.replaceState(null, "", "/operator");
    } catch (admissionError) {
      setError(
        admissionError instanceof Error
          ? admissionError.message
          : "Trusted Preview could not be entered.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (!operator) {
    return (
      <div className={styles.content}>
        <section className={styles.hero} aria-labelledby="operator-preparation-title">
          <div className={styles.heroSignal} aria-hidden="true">
            <span />
          </div>
          <p className={styles.kicker}>Your Bruno.Ai Operator</p>
          <h2 id="operator-preparation-title">Create your private Operator workspace.</h2>
          <p className={styles.intro}>
            Bruno will prepare a resumable workspace after you choose to begin. Opening this page
            alone does not create one.
          </p>
        </section>
        <section className={styles.card} aria-labelledby="operator-create-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>Needs you</p>
              <h3 id="operator-create-title">Begin Operator preparation</h3>
            </div>
          </div>
          <button
            className={styles.button}
            type="button"
            onClick={() => void startPreparation()}
            disabled={saving}
          >
            {saving ? "Beginning…" : "Create my Operator"}
          </button>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    );
  }

  const preparation = operator.preparation;
  const awaitingTimezone = preparation.status === "awaiting_timezone";
  const runtime = operator.runtime;
  const runtimeReady = runtime?.status === "ready";
  const runtimeNeedsAttention = runtime?.status === "needs_attention";
  const activated = onboarding?.activated === true;
  const workspaceAvailable = admitted;

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
                  : `Next step: ${
                      ownerPreviewExperience
                        ? ownerPreviewOnboardingStepLabel(onboarding.nextStep)
                        : onboardingStepLabel(onboarding.nextStep)
                    }`}
              </h3>
            </div>
            <span className={styles.confirmed}>
              {ownerPreviewExperience
                ? "Limited Operation"
                : onboarding.operation === "core"
                  ? "Core Operation"
                  : "Saved"}
            </span>
          </div>
          <p className={styles.hint}>
            {onboarding.activated
              ? "Bruno opens the active workspace here after every refresh."
              : "This step is derived from the latest saved connection, consent, and evidence state."}
          </p>
          {ownerPreviewExperience ? (
            <p className={styles.hint}>
              Owner Preview capabilities — AI: {capabilityLabel(onboarding.capabilities.ai)}
              {"; "}Calendar: {capabilityLabel(onboarding.capabilities.calendar)}.
            </p>
          ) : (
            <p className={styles.hint}>
              Capabilities — AI: {capabilityLabel(onboarding.capabilities.ai)}; Calendar:{" "}
              {capabilityLabel(onboarding.capabilities.calendar)}; Mail:{" "}
              {capabilityLabel(onboarding.capabilities.mail)}; Core:{" "}
              {capabilityLabel(onboarding.capabilities.core)}.
            </p>
          )}
        </section>
      ) : null}

      {ownerPreviewExperience ? (
        <section className={styles.card} aria-labelledby="owner-preview-boundary-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>{previewStatus.evidenceClassification}</p>
              <h3 id="owner-preview-boundary-title">{previewStatus.stage}</h3>
            </div>
            <span className={styles.confirmed}>{ownerPreviewStateLabel(previewStatus.state)}</span>
          </div>
          <p className={styles.hint}>
            Available now: {capabilityList(previewStatus.availableCapabilities)}.
          </p>
          <p className={styles.hint}>
            Support is {previewStatus.supportBoundary.toLowerCase()}. This attended use remains a
            Learning Round, cannot become Founder Acceptance Evidence, and never promotes Bruno
            automatically.
          </p>
        </section>
      ) : null}

      {ownerPreviewExperience &&
      ((runtimeReady && !admitted) || (admitted && (!runtimeReady || !workAllowed))) ? (
        <section className={styles.card} aria-labelledby="owner-preview-access-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>Needs you</p>
              <h3 id="owner-preview-access-title">
                {admitted
                  ? "Some new work is paused"
                  : `${previewStatus.stage} is waiting for current protection`}
              </h3>
            </div>
          </div>
          <p className={styles.hint}>
            {admitted
              ? "Your saved workspace remains available. Bruno starts work only for capabilities whose exact Release Decision, runtime, and Recovery Archive protection remain current."
              : "Bruno will open the workspace only after current qualification and a verified Recovery Archive are confirmed together. Try preparation again when protection is available."}
          </p>
          {runtimeReady && !admitted ? (
            <button
              className={styles.button}
              type="button"
              onClick={() =>
                void (trustedPreviewInvitationToken
                  ? acceptTrustedPreviewInvitation()
                  : enterOwnerPreview())
              }
              disabled={saving}
            >
              {saving
                ? "Checking…"
                : trustedPreviewInvitationToken
                  ? "Accept Trusted Preview invitation"
                  : "Enter Owner Preview"}
            </button>
          ) : null}
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

      {activated && workspaceAvailable ? (
        <section className={styles.workspace} aria-label="Current Founder workspace">
          <div className={styles.workspaceConversation}>
            <FounderConversation showDecisionContext={false} />
          </div>
          <div className={styles.workspaceBrief}>
            {ownerPreviewExperience || onboarding?.operation !== "core" ? (
              <FounderLimitedOperation />
            ) : (
              <FounderCoreOperation />
            )}
          </div>
          <div className={styles.workspaceNeeds}>
            <FounderActionInbox
              mailSendingReleased={ownerPreviewExperience ? false : mailSendingReleased}
            />
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

      {!activated && workspaceAvailable ? <FounderConversation /> : null}

      {!activated && workspaceAvailable ? (
        <FounderActionInbox
          mailSendingReleased={ownerPreviewExperience ? false : mailSendingReleased}
        />
      ) : null}

      {!ownerPreviewExperience && workspaceAvailable && mailSendingReleased ? (
        <FounderMailSendingConnection />
      ) : null}

      {workspaceAvailable &&
      openAiReleased &&
      (!ownerPreviewExperience || previewStatus.availableCapabilities.includes("OpenAI")) ? (
        <FounderAiConnection />
      ) : null}

      {workspaceAvailable &&
      calendarReadingReleased &&
      (!ownerPreviewExperience ||
        previewStatus.availableCapabilities.includes("Calendar reading")) ? (
        <FounderCalendarConnection />
      ) : null}

      {!ownerPreviewExperience &&
      workspaceAvailable &&
      mailReadingReleased &&
      mailReleaseControls ? (
        <FounderMailConnection releaseControls={mailReleaseControls} />
      ) : null}

      {!activated &&
      workspaceAvailable &&
      !ownerPreviewExperience &&
      onboarding?.operation === "core" ? (
        <FounderCoreOperation />
      ) : null}

      {!activated &&
      workspaceAvailable &&
      (ownerPreviewExperience || onboarding?.operation !== "core") ? (
        <FounderLimitedOperation />
      ) : null}

      {workspaceAvailable ? <FounderRelationships /> : null}

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
          {initialRecoveryArchive.state === "current" &&
          initialRecoveryArchive.latestAttempt?.status === "failed" ? (
            <p className={styles.hint}>
              Current protection remains verified. The latest daily refresh needs another try.
            </p>
          ) : null}
          {initialRecoveryArchive.state === "current" &&
          initialRecoveryArchive.latestAttempt?.status === "pending" ? (
            <p className={styles.hint}>
              Current protection remains verified while the latest daily refresh is being checked.
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

      {initialInfrastructureRetirement &&
      initialInfrastructureRetirement.state !== "unavailable" ? (
        <section className={styles.card} aria-labelledby="infrastructure-retirement-title">
          <div className={styles.cardHeading}>
            <div>
              <p className={styles.kicker}>Infrastructure retirement</p>
              <h3 id="infrastructure-retirement-title">
                {initialInfrastructureRetirement.state === "completed"
                  ? "Runtime cost stopped"
                  : "Runtime removal is still being verified"}
              </h3>
            </div>
            <span className={styles.confirmed}>
              {initialInfrastructureRetirement.state === "completed" ? "Verified" : "In progress"}
            </span>
          </div>
          <p className={styles.hint}>
            {initialInfrastructureRetirement.state === "completed"
              ? "DigitalOcean independently confirmed that the exact Droplet and firewall are absent."
              : "Bruno has stopped new work and disabled runtime access. Retirement is not complete until DigitalOcean independently confirms that the exact Droplet and firewall are absent."}
          </p>
          {initialInfrastructureRetirement.archive.outcome === "failed" ? (
            <p className={styles.error} role="status">
              The final Recovery Archive failed. This is a critical preservation failure, but it did
              not keep billable infrastructure running beyond its destruction boundary.
            </p>
          ) : null}
          {initialInfrastructureRetirement.needsAttention ? (
            <p className={styles.error} role="status">
              Provider verification needs another automatic attempt. Bruno will keep checking the
              same exact resource; it will not broaden deletion scope.
            </p>
          ) : null}
          <p className={styles.hint}>
            Droplet: {initialInfrastructureRetirement.provider.droplet}. Firewall:{" "}
            {initialInfrastructureRetirement.provider.firewall}.
          </p>
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

function ownerPreviewOnboardingStepLabel(step: FounderOnboardingDto["nextStep"]): string {
  return step === "mail" ? "Continue with OpenAI and Calendar" : onboardingStepLabel(step);
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

function fallbackOwnerPreviewStatus(
  admitted: boolean,
  workAllowed: boolean,
  trustedPreviewInvitation = false,
): FounderOwnerPreviewStatus {
  return projectFounderOwnerPreviewStatus({
    admitted,
    availableCapabilities: admitted && workAllowed ? ["openai", "calendar_reading"] : [],
    stage: trustedPreviewInvitation ? "trusted_preview" : "owner_preview",
  });
}

function ownerPreviewStateLabel(state: FounderOwnerPreviewStatus["state"]): string {
  return { waiting: "Waiting", active: "Active", limited: "Limited" }[state];
}

function capabilityList(capabilities: readonly string[]): string {
  return capabilities.length > 0 ? capabilities.join(" and ") : "none until admission is current";
}
