"use client";

import { useState } from "react";
import type {
  FounderPrivacyCenterDto,
  FounderPrivacyConnection,
} from "@/src/server/operators/founder-privacy-center";
import styles from "./founder-privacy-center.module.css";

export function FounderPrivacyCenter({
  initialPrivacy,
}: {
  initialPrivacy: FounderPrivacyCenterDto;
}) {
  const [privacy, setPrivacy] = useState(initialPrivacy);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function disconnect(connection: FounderPrivacyConnection) {
    if (
      !window.confirm(
        `Disconnect ${connection.provider} access for ${connection.accountLabel ?? "this account"}?`,
      )
    )
      return;
    setBusy(`disconnect:${connection.id}`);
    setMessage(null);
    try {
      const response = await fetch("/api/operator/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "disconnect",
          kind: connection.kind,
          provider: connection.provider,
        }),
      });
      const body = (await response.json()) as { error?: { message?: string } };
      if (!response.ok)
        throw new Error(body.error?.message ?? "Disconnect could not be completed.");
      setMessage("Disconnected. Bruno-local retained data was not deleted.");
      window.location.reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Disconnect could not be completed.");
    } finally {
      setBusy(null);
    }
  }

  async function deleteRetainedData() {
    if (
      !window.confirm(
        "Delete the Bruno-local conversation content and relationship evidence retained for this Founder workspace?",
      )
    )
      return;
    setBusy("delete");
    setMessage(null);
    try {
      const response = await fetch("/api/operator/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete_retained_data" }),
      });
      const body = (await response.json()) as {
        result?: { deleted?: Record<string, number> };
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(body.error?.message ?? "Retained data could not be deleted.");
      const deleted = body.result?.deleted;
      setMessage(
        `Deleted ${deleted?.conversationMessages ?? 0} conversation messages, ${deleted?.conversationWorks ?? 0} work records, ${deleted?.relationshipEvidence ?? 0} relationship evidence records, ${deleted?.relationshipRecords ?? 0} relationship records, and ${deleted?.relationshipCandidates ?? 0} relationship candidates.`,
      );
      setPrivacy((current) => ({
        ...current,
        retainedData: current.retainedData.map((item) =>
          item.deletableInBruno
            ? { ...item, retention: "No Bruno-local rows remain from this deletion request." }
            : item,
        ),
      }));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retained data could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className={styles.content}>
      <section className={styles.intro}>
        <p className={styles.kicker}>Privacy Center</p>
        <h2>See what Bruno can reach, what it keeps, and what you control.</h2>
        <p>
          This is the Founder view of your private workspace. Provider copies and provider-side
          retention remain governed by the provider; Bruno never represents those as deletable here.
        </p>
      </section>

      {message ? (
        <p className={styles.message} role="status">
          {message}
        </p>
      ) : null}

      <section className={styles.section} aria-labelledby="connected-accounts-title">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>Connected accounts</p>
          <h2 id="connected-accounts-title">Access is explicit and narrow</h2>
        </div>
        {privacy.connections.length === 0 ? (
          <p className={styles.empty}>No provider connection is recorded yet.</p>
        ) : (
          <div className={styles.grid}>
            {privacy.connections.map((connection) => (
              <article className={styles.card} key={connection.id}>
                <div className={styles.cardHeading}>
                  <div>
                    <p className={styles.kicker}>{connection.kind.replace("_", " ")}</p>
                    <h3>{connection.provider}</h3>
                  </div>
                  <span className={connection.isActiveRoute ? styles.active : styles.status}>
                    {connection.isActiveRoute ? "Active route" : connection.availability}
                  </span>
                </div>
                <dl className={styles.details}>
                  <Detail label="Account" value={connection.accountLabel ?? "Not established"} />
                  <Detail
                    label="Immutable provider identity"
                    value={connection.providerIdentity ?? "Not established"}
                  />
                  <Detail
                    label="Selected resources"
                    value={connection.selectedResources.join(", ") || "None selected"}
                  />
                  <Detail
                    label="Granted access"
                    value={connection.grantedAccess.join(", ") || "None"}
                  />
                  <Detail label="Bruno's narrower use" value={connection.narrowerUse} />
                  <Detail label="Capabilities" value={connection.capabilities.join(", ")} />
                  <Detail label="Evidence freshness" value={formatDate(connection.freshness)} />
                  <Detail label="Last recorded use" value={formatDate(connection.lastUse)} />
                </dl>
                <button
                  className={styles.secondary}
                  disabled={busy !== null}
                  onClick={() => void disconnect(connection)}
                  type="button"
                >
                  {busy === `disconnect:${connection.id}` ? "Disconnecting…" : "Disconnect access"}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className={styles.section} aria-labelledby="keeps-title">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>What Bruno keeps</p>
          <h2 id="keeps-title">Local records have a purpose and a boundary</h2>
        </div>
        <div className={styles.table}>
          {privacy.retainedData.map((item) => (
            <div className={styles.row} key={item.category}>
              <div>
                <strong>{item.category}</strong>
                <span>{item.purpose}</span>
              </div>
              <span>{item.retention}</span>
            </div>
          ))}
        </div>
      </section>

      <section className={styles.section} aria-labelledby="ai-processing-title">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>AI processing</p>
          <h2 id="ai-processing-title">The actual route is visible</h2>
        </div>
        <div className={styles.aiPanel}>
          <strong>
            {privacy.aiRoute.provider
              ? `${privacy.aiRoute.provider} · ${privacy.aiRoute.accountLabel ?? "account not labeled"}`
              : "No AI provider is currently routed"}
          </strong>
          <p>
            {privacy.aiRoute.purpose} Compatibility policy v{privacy.aiRoute.policyVersion}.
          </p>
          <p>
            <strong>Data posture:</strong> {privacy.aiRoute.posture}
          </p>
          <p>
            <strong>Known retention:</strong> {privacy.aiRoute.knownRetention}
          </p>
          <ul>
            {privacy.aiRoute.limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="your-data-title">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>Your data</p>
          <h2 id="your-data-title">Two controls, two consequences</h2>
        </div>
        <div className={styles.dataControls}>
          <div>
            <h3>Disconnect access</h3>
            <p>
              Stops Bruno using that provider grant. It does not erase Bruno-local retained data or
              claim to remove provider-held copies.
            </p>
          </div>
          <div>
            <h3>Delete retained data</h3>
            <p>{privacy.deletionBoundary}</p>
            <button
              className={styles.danger}
              disabled={busy !== null}
              onClick={() => void deleteRetainedData()}
              type="button"
            >
              {busy === "delete" ? "Deleting…" : "Delete retained data"}
            </button>
          </div>
        </div>
        <div className={styles.restricted}>
          <h3>Restricted launch categories</h3>
          <ul>
            {privacy.restrictedCategories.map((category) => (
              <li key={category}>{category}</li>
            ))}
          </ul>
          <p>
            Detection is bounded by the scopes and evidence Bruno can actually observe; absence from
            this list is not a promise that a provider has no copy.
          </p>
        </div>
      </section>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatDate(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value),
      )
    : "No recorded use";
}
