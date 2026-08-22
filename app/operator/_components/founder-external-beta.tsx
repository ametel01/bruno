"use client";

import Link from "next/link";
import { useState } from "react";
import type { FounderExternalBetaStatus } from "@/src/server/founder-product-contract/external-beta-admission";

const EXTERNAL_BETA_COMPACT_VERSION = "bruno.external-beta-compact.v1" as const;

export function FounderExternalBeta({
  initialStatus,
  invitationToken,
  workspaceReference,
}: {
  initialStatus: FounderExternalBetaStatus;
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
          : `New work stopped at ${formatInstant(status.accessExpiresAt)}. Infrastructure Retirement is required by ${formatInstant(status.retirementDueAt)}.`}
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
      {status.withdrawalAvailable ? (
        <button type="button" disabled={busy} onClick={() => void withdraw()}>
          {busy ? "Stopping…" : "Withdraw from External Beta"}
        </button>
      ) : null}
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
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function founderExternalBetaCapabilityLabel(
  capability: "openai" | "anthropic" | "calendar_reading" | "gmail_reading" | "gmail_sending",
): string {
  switch (capability) {
    case "openai":
      return "OpenAI";
    case "anthropic":
      return "Anthropic";
    case "calendar_reading":
      return "Calendar reading";
    case "gmail_reading":
      return "Gmail reading";
    case "gmail_sending":
      return "one-to-one Gmail sending";
  }
}
