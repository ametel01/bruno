"use client";

import Link from "next/link";
import { useState } from "react";
import type { FounderExternalBetaStatus } from "@/src/server/founder-product-contract/external-beta-admission";
import type {
  FounderExternalBetaConsentDecision,
  FounderExternalBetaConsentPurpose,
  FounderExternalBetaPrivacyStatus,
} from "@/src/server/founder-product-contract/external-beta-privacy";
import { founderExternalBetaCapabilityLabel } from "@/src/shared/founder-external-beta";

const EXTERNAL_BETA_COMPACT_VERSION = "bruno.external-beta-compact.v1" as const;

export function FounderExternalBeta({
  initialStatus,
  initialPrivacy = { state: "unavailable" },
  invitationToken,
  workspaceReference,
}: {
  initialStatus: FounderExternalBetaStatus;
  initialPrivacy?: FounderExternalBetaPrivacyStatus;
  invitationToken?: string;
  workspaceReference?: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const invitationAvailable = Boolean(invitationToken && workspaceReference);

  async function acceptInvitation() {
    if (!invitationToken || !workspaceReference || !accepted) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operator/external-beta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "accept_invitation",
          invitationToken,
          workspaceReference,
          compact: {
            version: EXTERNAL_BETA_COMPACT_VERSION,
            instabilityAccepted: true,
            capabilityBoundaryAccepted: true,
            reactiveSupportAccepted: true,
            companyDataHandlingAccepted: true,
            feedbackBoundaryAccepted: true,
            withdrawalExportDeletionAccepted: true,
            freeNonconvertingBoundaryAccepted: true,
          },
        }),
      });
      if (!response.ok) throw new Error("This invitation could not be accepted.");
      window.location.assign("/operator");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "This invitation could not be accepted.");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operator/external-beta", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "withdraw" }),
      });
      if (!response.ok) throw new Error("Withdrawal could not be recorded.");
      const body = (await response.json()) as {
        externalBeta: { state: "withdrawn"; retirementDueAt: string };
      };
      if (status.state !== "unavailable") {
        setStatus({
          ...status,
          state: "withdrawn",
          remainingSeconds: 0,
          withdrawalAvailable: false,
          retirementDueAt: body.externalBeta.retirementDueAt,
        });
      }
      setMessage("External Beta work stopped. Infrastructure Retirement is now in progress.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Withdrawal could not be recorded.");
    } finally {
      setBusy(false);
    }
  }

  if (status.state === "unavailable" && !invitationAvailable) return null;

  if (status.state === "unavailable") {
    return (
      <section aria-labelledby="external-beta-compact-title">
        <p>External Beta invitation</p>
        <h2 id="external-beta-compact-title">Review the Beta Compact before access</h2>
        <p>
          Bruno.Ai is intentionally unfinished. This invitation is for you and this one private
          workspace, expires after seven days if unused, and cannot be transferred.
        </p>
        <ul>
          <li>
            Access is free for exactly 14 days, with no card, renewal, extension, or paid
            conversion.
          </li>
          <li>
            OpenAI, Anthropic, Calendar reading, Gmail reading, and one-to-one Gmail sending are
            available only while their independent checks remain current.
          </li>
          <li>
            Onboarding and ordinary use are self-serve. Support is reactive after a problem occurs.
          </li>
          <li>
            Use only your isolated company accounts. Beta feedback is product-hardening evidence,
            not Founder Acceptance Evidence or marketing consent.
          </li>
          <li>
            You may withdraw at any time. After access ends, runtime work stops and infrastructure
            is retired while retained Bruno-local data remains exportable or deletable.
          </li>
        </ul>
        <label>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(event) => setAccepted(event.currentTarget.checked)}
          />{" "}
          I accept the complete Beta Compact and its exact 14-day boundary.
        </label>
        <button type="button" disabled={!accepted || busy} onClick={() => void acceptInvitation()}>
          {busy ? "Accepting…" : "Accept External Beta invitation"}
        </button>
        {message ? <p role="alert">{message}</p> : null}
      </section>
    );
  }

  const active = status.state === "active";
  return (
    <section aria-labelledby="external-beta-status-title">
      <p>{status.stage}</p>
      <h2 id="external-beta-status-title">
        {active ? `${formatRemaining(status.remainingSeconds)} remaining` : "Product access ended"}
      </h2>
      <p>
        {active
          ? `Your exact access window ends ${formatInstant(status.accessExpiresAt)}.`
          : `New work stopped at ${formatInstant(status.workStoppedAt ?? status.accessExpiresAt)}. Infrastructure Retirement is required by ${formatInstant(status.retirementDueAt)}.`}
      </p>
      <p>{status.support}.</p>
      <p>{status.payment}.</p>
      <p>{status.evidenceClassification}.</p>
      <h3>Capability boundary</h3>
      <dl>
        {[...status.availableCapabilities, ...status.unavailableCapabilities].map((capability) => (
          <div key={capability}>
            <dt>{founderExternalBetaCapabilityLabel(capability)}</dt>
            <dd>{status.availableCapabilities.includes(capability) ? "Available" : "Paused"}</dd>
          </div>
        ))}
      </dl>
      <p>
        <Link href="/operator/privacy#founder-data-export">Create Founder Data Export</Link>
        {" · "}
        <Link href="/operator/privacy#bruno-data-deletion">Request Bruno Data Deletion</Link>
      </p>
      {initialPrivacy.state === "available" ? (
        <FounderExternalBetaPrivacyControls initialStatus={initialPrivacy} />
      ) : null}
      {status.withdrawalAvailable ? (
        <button type="button" disabled={busy} onClick={() => void withdraw()}>
          {busy ? "Stopping…" : "Withdraw from External Beta"}
        </button>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

const CONSENT_LABELS: Record<FounderExternalBetaConsentPurpose, string> = {
  measurement: "Operational measurement",
  feedback: "Beta feedback",
  recording: "Research recording",
  testimonial: "Testimonial use",
  identity: "Identity use",
  name: "Name use",
  logo: "Logo use",
  quotation: "Quotation use",
  case_study: "Case-study use",
};

function FounderExternalBetaPrivacyControls({
  initialStatus,
}: {
  initialStatus: Extract<FounderExternalBetaPrivacyStatus, { state: "available" }>;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [busyPurpose, setBusyPurpose] = useState<FounderExternalBetaConsentPurpose | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function decide(
    purpose: FounderExternalBetaConsentPurpose,
    decision: FounderExternalBetaConsentDecision,
  ) {
    setBusyPurpose(purpose);
    setMessage(null);
    try {
      const response = await fetch("/api/operator/external-beta/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "decide_consent", purpose, decision }),
      });
      if (!response.ok) throw new Error("This privacy choice could not be saved.");
      const body = (await response.json()) as {
        privacy: Extract<FounderExternalBetaPrivacyStatus, { state: "available" }>;
      };
      setStatus(body.privacy);
      setMessage("Your External Beta privacy choice was saved without changing product access.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "This privacy choice could not be saved.",
      );
    } finally {
      setBusyPurpose(null);
    }
  }

  async function exportPrivacyData() {
    setMessage(null);
    const response = await fetch("/api/operator/external-beta/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "export" }),
    });
    if (!response.ok) {
      setMessage("External Beta privacy data could not be exported.");
      return;
    }
    const payload = await response.json();
    const url = URL.createObjectURL(
      new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "bruno-external-beta-privacy.json";
    link.click();
    URL.revokeObjectURL(url);
    setMessage("External Beta privacy export created.");
  }

  async function deleteMeasurements() {
    setMessage(null);
    const response = await fetch("/api/operator/external-beta/privacy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ action: "delete_measurements" }),
    });
    setMessage(
      response.ok
        ? "Your External Beta measurements were deleted. Product access is unchanged."
        : "External Beta measurements could not be deleted.",
    );
  }

  return (
    <section aria-labelledby="external-beta-privacy-title">
      <h3 id="external-beta-privacy-title">External Beta privacy</h3>
      <p>
        Nothing is measured until you opt in. Bruno.Ai never uses autocapture, session replay, or
        person profiles for External Beta learning.
      </p>
      <p>
        Collected only with measurement consent: {status.collection.allowlistedFacts.join(", ")}.
      </p>
      <p>Never collected: {status.collection.neverCollected.join(", ")}.</p>
      <p>
        Recordings are a separate choice and are deleted within {status.recordingRetentionDays} days
        with verified deletion. Every marketing use is also a separate choice.
      </p>
      <p>{status.evidenceClassification}.</p>
      <dl>
        {Object.entries(CONSENT_LABELS).map(([purpose, label]) => {
          const typedPurpose = purpose as FounderExternalBetaConsentPurpose;
          const consent = status.consent[typedPurpose];
          return (
            <div key={purpose}>
              <dt>{label}</dt>
              <dd>{consent.replace("_", " ")}</dd>
              <dd>
                <button
                  type="button"
                  disabled={busyPurpose === typedPurpose}
                  onClick={() => void decide(typedPurpose, "grant")}
                >
                  Allow
                </button>{" "}
                <button
                  type="button"
                  disabled={busyPurpose === typedPurpose}
                  onClick={() => void decide(typedPurpose, "refuse")}
                >
                  Refuse
                </button>{" "}
                <button
                  type="button"
                  disabled={busyPurpose === typedPurpose || consent === "not_granted"}
                  onClick={() => void decide(typedPurpose, "withdraw")}
                >
                  Withdraw
                </button>
              </dd>
            </div>
          );
        })}
      </dl>
      <p>Refusing feedback, recording, or marketing never reduces your 14-day access.</p>
      <button type="button" onClick={() => void exportPrivacyData()}>
        Export External Beta privacy data
      </button>{" "}
      <button type="button" onClick={() => void deleteMeasurements()}>
        Delete External Beta measurements
      </button>
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}

function formatRemaining(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function formatInstant(value: string): string {
  const instant = new Date(value);
  const hour = instant.getUTCHours();
  const hour12 = hour % 12 || 12;
  const minute = instant.getUTCMinutes().toString().padStart(2, "0");
  const period = hour < 12 ? "AM" : "PM";
  const month = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ][instant.getUTCMonth()];
  return `${month} ${instant.getUTCDate()}, ${instant.getUTCFullYear()}, ${hour12}:${minute} ${period} UTC`;
}
