"use client";

import { useEffect, useState } from "react";
import type {
  FounderRelationshipCandidateDto,
  FounderRelationshipRecordDto,
  FounderRelationshipsDto,
} from "@/src/server/operators/founder-relationships";
import styles from "./founder-relationships.module.css";

export function FounderRelationships() {
  const [relationships, setRelationships] = useState<FounderRelationshipsDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetch("/api/operator/relationships", { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) throw new Error("Relationship Records could not be loaded.");
          return (await response.json()) as { relationships: FounderRelationshipsDto };
        })
        .then((body) => {
          if (!cancelled) setRelationships(body.relationships);
        })
        .catch((loadError) => {
          if (!cancelled)
            setError(
              loadError instanceof Error
                ? loadError.message
                : "Relationship Records could not be loaded.",
            );
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, []);

  async function runAction(
    action: "confirm_candidate" | "reject_candidate" | "update_record",
    payload: Record<string, unknown>,
    id: string,
  ) {
    setBusyId(id);
    setError(null);
    try {
      const response = await fetch("/api/operator/relationships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action, ...payload }),
      });
      const body = (await response.json()) as {
        relationships?: FounderRelationshipsDto;
        error?: { message?: string };
      };
      if (!response.ok || !body.relationships) {
        throw new Error(body.error?.message ?? "Relationship state could not be saved.");
      }
      setRelationships(body.relationships);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : "Relationship state could not be saved.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return null;
  if (!relationships && error)
    return (
      <p className={styles.error} role="alert">
        {error}
      </p>
    );
  if (!relationships) return null;
  const pendingCandidates = relationships.candidates.filter(
    (candidate) => candidate.status === "pending",
  );

  return (
    <section className={styles.card} id="relationships" aria-labelledby="relationships-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Lead-to-Client Loop</p>
          <h3 id="relationships-title">Relationship Records</h3>
        </div>
        <span className={styles.badge}>{relationships.records.length} confirmed</span>
      </div>
      <p className={styles.copy}>
        Bruno keeps only Founder-confirmed relationship state, next actions, commitments, and small
        evidence pointers. Calendar and Mail remain the authoritative source.
      </p>

      {pendingCandidates.length ? (
        <section className={styles.candidates} aria-labelledby="relationship-candidates-title">
          <div>
            <p className={styles.kicker}>Needs you</p>
            <h4 id="relationship-candidates-title">Relationship Candidates</h4>
          </div>
          {pendingCandidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              candidate={candidate}
              busy={busyId === candidate.id}
              onConfirm={() =>
                void runAction("confirm_candidate", { candidateId: candidate.id }, candidate.id)
              }
              onReject={() =>
                void runAction("reject_candidate", { candidateId: candidate.id }, candidate.id)
              }
            />
          ))}
        </section>
      ) : null}

      {relationships.records.length ? (
        <div className={styles.records}>
          {relationships.records.map((record) => (
            <RecordCard
              key={record.id}
              record={record}
              busy={busyId === record.id}
              onSave={(payload) =>
                void runAction("update_record", { recordId: record.id, ...payload }, record.id)
              }
            />
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          No confirmed relationships yet. Bruno will keep a candidate here when selected Calendar or
          Mail evidence needs your confirmation.
        </p>
      )}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function CandidateCard({
  candidate,
  busy,
  onConfirm,
  onReject,
}: {
  candidate: FounderRelationshipCandidateDto;
  busy: boolean;
  onConfirm: () => void;
  onReject: () => void;
}) {
  return (
    <article className={styles.candidate}>
      <div className={styles.row}>
        <div>
          <h5>{candidate.displayName}</h5>
          <p className={styles.meta}>
            {candidate.company ?? candidate.primaryEmail ?? "Needs a closer look"} ·{" "}
            {matchLabel(candidate.matchKind)}
          </p>
        </div>
        <span className={evidenceClass(candidate.evidenceState)}>
          {evidenceLabel(candidate.evidenceState)}
        </span>
      </div>
      <EvidenceList evidence={candidate.evidence} />
      <p className={styles.hint}>Fuzzy matches never merge without your decision.</p>
      <div className={styles.actions}>
        <button type="button" className={styles.button} onClick={onConfirm} disabled={busy}>
          {busy ? "Saving…" : "Confirm relationship"}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onReject} disabled={busy}>
          Ignore candidate
        </button>
      </div>
    </article>
  );
}

function RecordCard({
  record,
  busy,
  onSave,
}: {
  record: FounderRelationshipRecordDto;
  busy: boolean;
  onSave: (payload: Record<string, unknown>) => void;
}) {
  const [state, setState] = useState(record.relationshipState);
  const [status, setStatus] = useState(record.status);
  const [nextAction, setNextAction] = useState(record.nextAction ?? "");
  const [nextActionDueAt, setNextActionDueAt] = useState(toDateInput(record.nextActionDueAt));
  const [commitments, setCommitments] = useState(record.commitments.join("\n"));
  useEffect(() => {
    setState(record.relationshipState);
    setStatus(record.status);
    setNextAction(record.nextAction ?? "");
    setNextActionDueAt(toDateInput(record.nextActionDueAt));
    setCommitments(record.commitments.join("\n"));
  }, [record]);

  return (
    <article className={styles.record}>
      <div className={styles.row}>
        <div>
          <h4>{record.displayName}</h4>
          <p className={styles.meta}>
            {record.company ?? record.primaryEmail ?? "Founder-confirmed relationship"}
          </p>
        </div>
        <span className={evidenceClass(record.evidenceState)}>
          {evidenceLabel(record.evidenceState)}
        </span>
      </div>
      <EvidenceList evidence={record.evidence} />
      <div className={styles.fields}>
        <label>
          Relationship state
          <select
            value={state}
            onChange={(event) => setState(event.currentTarget.value as typeof state)}
            disabled={busy}
          >
            <option value="lead">Lead</option>
            <option value="client">Client</option>
            <option value="partner">Partner</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>
        <label>
          Record status
          <select
            value={status}
            onChange={(event) => setStatus(event.currentTarget.value as typeof status)}
            disabled={busy}
          >
            <option value="active">Active</option>
            <option value="closed">Closed</option>
            <option value="ignored">Ignored</option>
          </select>
        </label>
        <label>
          Next action
          <input
            value={nextAction}
            onChange={(event) => setNextAction(event.currentTarget.value)}
            disabled={busy}
            placeholder="What should happen next?"
          />
        </label>
        <label>
          Next action date
          <input
            type="date"
            value={nextActionDueAt}
            onChange={(event) => setNextActionDueAt(event.currentTarget.value)}
            disabled={busy}
          />
        </label>
        <label>
          Commitments
          <textarea
            value={commitments}
            onChange={(event) => setCommitments(event.currentTarget.value)}
            disabled={busy}
            rows={3}
            placeholder="One commitment per line"
          />
        </label>
      </div>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          onClick={() =>
            onSave({
              relationshipState: state,
              status,
              nextAction: nextAction || null,
              nextActionDueAt: nextActionDueAt || null,
              commitments: commitments
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
            })
          }
          disabled={busy}
        >
          {busy ? "Saving…" : "Save relationship"}
        </button>
        <span className={styles.meta}>
          Correction revision {record.revision} · {record.corrections.length} recorded changes
        </span>
      </div>
    </article>
  );
}

function EvidenceList({ evidence }: { evidence: FounderRelationshipRecordDto["evidence"] }) {
  if (!evidence.length) return <p className={styles.hint}>No source pointer is available.</p>;
  return (
    <ul className={styles.evidence}>
      {evidence.map((item) => (
        <li key={item.id}>
          <span>{item.sourceKind === "calendar" ? "Calendar" : "Mail"}</span>
          <span>{item.sourceLabel ?? "Connected source"}</span>
          <span className={evidenceClass(item.state)}>{evidenceLabel(item.state)}</span>
          {item.excerpt ? <small>{item.excerpt}</small> : null}
        </li>
      ))}
    </ul>
  );
}

function matchLabel(value: FounderRelationshipCandidateDto["matchKind"]): string {
  return {
    exact_provider_identity: "exact provider identity",
    exact_email: "exact email",
    fuzzy_name: "name needs confirmation",
    fuzzy_company: "company needs confirmation",
    fuzzy_domain: "domain needs confirmation",
  }[value];
}

function evidenceLabel(value: FounderRelationshipRecordDto["evidenceState"]): string {
  return {
    current: "Source current",
    stale: "Source needs a fresh check",
    disconnected: "Source disconnected",
    unavailable: "Source unavailable",
  }[value];
}

function evidenceClass(value: FounderRelationshipRecordDto["evidenceState"]): string {
  return styles[value] ?? styles.unavailable ?? "";
}

function toDateInput(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}
