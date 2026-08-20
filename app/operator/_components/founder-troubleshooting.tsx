"use client";

import { useState } from "react";
import { FounderHermesSetup } from "@/app/operator/_components/founder-hermes-setup";
import type { FounderSupportDto } from "@/src/server/operators/founder-support";
import type {
  FounderTroubleshootingDto,
  FounderTroubleshootingIncidentDto,
} from "@/src/server/operators/founder-troubleshooting";
import styles from "./founder-troubleshooting.module.css";

export function FounderTroubleshooting({
  initialTroubleshooting,
  initialSupport,
}: {
  initialTroubleshooting: FounderTroubleshootingDto;
  initialSupport?: FounderSupportDto;
}) {
  const [troubleshooting, setTroubleshooting] = useState(initialTroubleshooting);
  const [support, setSupport] = useState(initialSupport);
  const [busyIncident, setBusyIncident] = useState<string | null>(null);
  const [busyGrant, setBusyGrant] = useState(false);
  const [supportActorName, setSupportActorName] = useState("");
  const [supportActorIdentity, setSupportActorIdentity] = useState("");
  const [mfaConfirmed, setMfaConfirmed] = useState(false);
  const [supportScope, setSupportScope] = useState<
    "troubleshooting_evidence" | "capability_status" | "recovery_checkpoint"
  >("troubleshooting_evidence");
  const [supportTtl, setSupportTtl] = useState(30);
  const [error, setError] = useState<string | null>(null);

  async function updateIncident(incidentId: string, action: "approve_case" | "close_case") {
    setBusyIncident(incidentId);
    setError(null);
    try {
      const response = await fetch("/api/operator/troubleshooting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ incidentId, action }),
      });
      const body = (await response.json()) as {
        incident?: FounderTroubleshootingIncidentDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.incident) {
        throw new Error(body.error?.message ?? "Troubleshooting could not be updated.");
      }
      setTroubleshooting((current) => ({
        ...current,
        incidents: current.incidents.map((item) =>
          item.id === body.incident?.id ? body.incident : item,
        ),
      }));
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Troubleshooting could not be updated.",
      );
    } finally {
      setBusyIncident(null);
    }
  }

  const { help } = troubleshooting;
  async function revokeGrant(grantId: string) {
    setError(null);
    try {
      const response = await fetch("/api/operator/troubleshooting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action: "revoke_access", grantId }),
      });
      const body = (await response.json()) as {
        grant?: NonNullable<typeof support>["grants"][number];
        error?: { message?: string };
      };
      if (!response.ok || !body.grant)
        throw new Error(body.error?.message ?? "Support access could not be revoked.");
      setSupport((current) =>
        current
          ? {
              ...current,
              grants: current.grants.map((grant) =>
                grant.id === body.grant?.id ? body.grant : grant,
              ),
            }
          : current,
      );
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Support access could not be revoked.",
      );
    }
  }

  async function grantAccess(incidentId: string) {
    setBusyGrant(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/troubleshooting", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          action: "grant_access",
          incidentId,
          supportActorName,
          supportActorIdentity,
          mfaAuthenticated: mfaConfirmed,
          scope: supportScope,
          ttlMinutes: supportTtl,
        }),
      });
      const body = (await response.json()) as {
        grant?: NonNullable<typeof support>["grants"][number];
        error?: { message?: string };
      };
      if (!response.ok || !body.grant)
        throw new Error(body.error?.message ?? "Support access could not be granted.");
      const nextGrant = body.grant;
      setSupport((current) =>
        current
          ? {
              ...current,
              grants: [
                nextGrant,
                ...current.grants.filter((grant) => grant.incidentId !== incidentId),
              ],
            }
          : current,
      );
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : "Support access could not be granted.",
      );
    } finally {
      setBusyGrant(false);
    }
  }
  return (
    <div className={styles.content}>
      <section className={styles.hero} aria-labelledby="troubleshooting-title">
        <p className={styles.kicker}>Help</p>
        <h2 id="troubleshooting-title">Keep the business moving</h2>
        <p>
          Bruno explains what is affected and gives you one safe next step. Technical evidence is
          shown only after a durable recovery limit has been reached.
        </p>
      </section>

      <section
        className={styles.card}
        aria-labelledby="help-title"
        data-help-state={help.state ?? "none"}
      >
        <div className={styles.heading}>
          <div>
            <p className={styles.kicker}>{help.state ? labelState(help.state) : "Ready"}</p>
            <h3 id="help-title">{help.title}</h3>
          </div>
          {help.technicalEvidenceAvailable ? (
            <span className={styles.badge}>Incident opened</span>
          ) : null}
        </div>
        <p>{help.impact}</p>
        {help.action ? (
          help.action.href ? (
            <a className={styles.action} href={help.action.href}>
              {help.action.label}
            </a>
          ) : (
            <p className={styles.hint}>{help.action.label} in the Conversation checkpoint.</p>
          )
        ) : null}
        {!help.technicalEvidenceAvailable ? (
          <p className={styles.hint}>
            No Troubleshooting Evidence is available for routine recovery.
          </p>
        ) : null}
      </section>

      {troubleshooting.incidents.length > 0 ? (
        <section className={styles.incidents} aria-labelledby="incidents-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>Troubleshooting</p>
            <h3 id="incidents-title">Founder-readable incidents</h3>
          </div>
          {troubleshooting.incidents.map((incident) => (
            <IncidentCard
              key={incident.id}
              incident={incident}
              busy={busyIncident === incident.id}
              onAction={updateIncident}
            />
          ))}
        </section>
      ) : null}

      {help.technicalEvidenceAvailable ? <FounderHermesSetup /> : null}

      {support ? (
        <section className={styles.incidents} aria-labelledby="support-access-title">
          <div className={styles.sectionHeading}>
            <p className={styles.kicker}>Support boundary</p>
            <h3 id="support-access-title">Scoped support access</h3>
          </div>
          <div className={styles.card}>
            <p>
              Opening a Support Case grants no access. A named, MFA-authenticated support person can
              receive one exact read-only scope for no more than 60 minutes.
            </p>
            {troubleshooting.incidents
              .filter(
                (incident) =>
                  incident.status === "open" &&
                  incident.supportCase === "open" &&
                  !support.grants.some(
                    (grant) => grant.incidentId === incident.id && grant.status === "active",
                  ),
              )
              .map((incident) => (
                <form
                  className={styles.grantForm}
                  key={incident.id}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void grantAccess(incident.id);
                  }}
                >
                  <strong>Grant access to {incident.title}</strong>
                  <label>
                    Support name
                    <input
                      value={supportActorName}
                      onChange={(event) => setSupportActorName(event.target.value)}
                      required
                      maxLength={160}
                    />
                  </label>
                  <label>
                    Support identity
                    <input
                      value={supportActorIdentity}
                      onChange={(event) => setSupportActorIdentity(event.target.value)}
                      required
                      maxLength={240}
                    />
                  </label>
                  <label>
                    <span>
                      <input
                        type="checkbox"
                        checked={mfaConfirmed}
                        onChange={(event) => setMfaConfirmed(event.target.checked)}
                        required
                      />{" "}
                      I confirmed this named support actor is MFA-authenticated.
                    </span>
                  </label>
                  <label>
                    Read-only scope
                    <select
                      value={supportScope}
                      onChange={(event) =>
                        setSupportScope(event.target.value as typeof supportScope)
                      }
                    >
                      <option value="troubleshooting_evidence">Troubleshooting Evidence</option>
                      <option value="capability_status">Capability status</option>
                      <option value="recovery_checkpoint">Recovery checkpoint</option>
                    </select>
                  </label>
                  <label>
                    Minutes (1–60)
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={supportTtl}
                      onChange={(event) => setSupportTtl(Number(event.target.value))}
                    />
                  </label>
                  <button type="submit" disabled={busyGrant}>
                    {busyGrant ? "Granting…" : "Grant scoped access"}
                  </button>
                </form>
              ))}
            {support.grants.length === 0 ? (
              <p className={styles.hint}>No Support Access Grant exists.</p>
            ) : (
              support.grants.map((grant) => (
                <div className={styles.supportRow} key={grant.id} data-grant-status={grant.status}>
                  <div>
                    <strong>{grant.supportActor.name}</strong>
                    <span>
                      {grant.scope.replaceAll("_", " ")} · expires {formatDate(grant.expiresAt)}
                    </span>
                    <small>Receipt {grant.receiptDigest}</small>
                    {grant.supportAccessToken ? (
                      <small>
                        Share this Support Access Token with the named actor:{" "}
                        {grant.supportAccessToken}
                      </small>
                    ) : null}
                  </div>
                  {grant.status === "active" ? (
                    <button type="button" onClick={() => void revokeGrant(grant.id)}>
                      Revoke access
                    </button>
                  ) : (
                    <span className={styles.badge}>{grant.status}</span>
                  )}
                </div>
              ))
            )}
          </div>
          <div className={styles.card}>
            <h4>Typed Repair Catalogue</h4>
            <p className={styles.hint}>
              Support may propose these repairs; only your separate Founder decision can approve
              one.
            </p>
            <ul>
              {support.repairs.map((repair) => (
                <li key={repair}>{repair.replaceAll("_", " ")}</li>
              ))}
            </ul>
            {support.proposals.map((proposal) => (
              <div className={styles.supportRow} key={proposal.id}>
                <div>
                  <strong>{proposal.kind.replaceAll("_", " ")}</strong>
                  <span>
                    {proposal.state} · {proposal.proposalDigest}
                  </span>
                  {proposal.verification ? (
                    <small>{String(proposal.verification.summary)}</small>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function IncidentCard({
  incident,
  busy,
  onAction,
}: {
  incident: FounderTroubleshootingIncidentDto;
  busy: boolean;
  onAction: (incidentId: string, action: "approve_case" | "close_case") => void;
}) {
  return (
    <article className={styles.card} data-incident-status={incident.status}>
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>{incident.status === "open" ? "Open" : "Closed"}</p>
          <h4>{incident.title}</h4>
        </div>
        <time dateTime={incident.openedAt}>{formatDate(incident.openedAt)}</time>
      </div>
      <p>{incident.impactSummary}</p>
      <div className={styles.capabilityGrid}>
        <div>
          <strong>Affected</strong>
          <ul>
            {incident.affectedCapabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <strong>Unaffected</strong>
          <ul>
            {incident.unaffectedCapabilities.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      {incident.evidence.length > 0 ? (
        <details className={styles.evidence}>
          <summary>Troubleshooting Evidence</summary>
          <ul>
            {incident.evidence.map((item) => (
              <li key={`${incident.id}-${item.kind}`}>
                <strong>{item.kind.replaceAll("_", " ")}</strong>
                <span>{evidenceSummary(item.payload)}</span>
              </li>
            ))}
          </ul>
          <small>
            {incident.evidenceExpiresAt
              ? `Evidence expires ${formatDate(incident.evidenceExpiresAt)}.`
              : "Evidence is retained only while the approved support case is open."}
          </small>
        </details>
      ) : null}
      {incident.status === "open" ? (
        <div className={styles.actions}>
          {incident.supportCase === "not_attached" ? (
            <button
              type="button"
              onClick={() => onAction(incident.id, "approve_case")}
              disabled={busy}
            >
              {busy ? "Saving…" : "Approve support case"}
            </button>
          ) : null}
          <button type="button" onClick={() => onAction(incident.id, "close_case")} disabled={busy}>
            {busy ? "Saving…" : "Close incident"}
          </button>
        </div>
      ) : null}
    </article>
  );
}

function evidenceSummary(
  payload: FounderTroubleshootingIncidentDto["evidence"][number]["payload"],
): string {
  if (payload.safeAction) return payload.safeAction;
  if (payload.affectedCapabilities) return payload.affectedCapabilities.join(", ");
  return `${payload.attemptCount} of ${payload.maxAttempts} attempts · ${formatElapsed(payload.elapsedMs)} of ${formatElapsed(payload.maxElapsedMs)}`;
}

function labelState(state: NonNullable<FounderTroubleshootingDto["help"]["state"]>): string {
  return state
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function formatElapsed(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "under a minute";
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
