"use client";

import { useState } from "react";
import type {
  FounderPrivacyCenterDto,
  FounderPrivacyConnection,
} from "@/src/server/operators/founder-privacy-center";
import type { FounderDeletionReceipt } from "@/src/server/operators/founder-deletion";
import styles from "./founder-privacy-center.module.css";

export function FounderPrivacyCenter({
  initialPrivacy,
  initialDeletion = null,
}: {
  initialPrivacy: FounderPrivacyCenterDto;
  initialDeletion?: FounderDeletionReceipt | null;
}) {
  const [privacy] = useState(initialPrivacy);
  const [deletion, setDeletion] = useState<FounderDeletionReceipt | null>(initialDeletion);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [exportLinks, setExportLinks] = useState<{
    json: string;
    html: string;
    expiresAt: string;
  } | null>(null);

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

  async function requestDeletion(kind: "request_deletion" | "close_account") {
    const isClosure = kind === "close_account";
    if (
      !window.confirm(
        isClosure
          ? "Close this Bruno account? Connections will be revoked, unstarted effects cancelled, and deletion will begin."
          : "Request staged deletion of Bruno-local retained data? Access stops now; purge and backup expiry are tracked separately.",
      )
    )
      return;
    setBusy(isClosure ? "close" : "delete");
    setMessage(null);
    try {
      const response = await fetch("/api/operator/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: kind,
          ...(isClosure ? { confirmation: "CLOSE_ACCOUNT" } : {}),
        }),
      });
      const body = (await response.json()) as {
        deletion?: FounderDeletionReceipt | null;
        error?: { message?: string };
      };
      if (!response.ok)
        throw new Error(body.error?.message ?? "Deletion request could not be created.");
      setDeletion(body.deletion ?? null);
      setMessage(
        isClosure
          ? "Account closure requested. Access is stopped and provider revocation results are tracked below."
          : "Deletion requested. Access is stopped; purge and backup expiry remain staged below.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Retained data could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  async function retryRevocations() {
    setBusy("retry-revocations");
    setMessage(null);
    try {
      const response = await fetch("/api/operator/privacy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry_revocations" }),
      });
      const body = (await response.json()) as {
        deletion?: FounderDeletionReceipt | null;
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "Revocation retry failed.");
      setDeletion(body.deletion ?? null);
      setMessage("Provider revocation was retried. Review each connection result below.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Revocation retry failed.");
    } finally {
      setBusy(null);
    }
  }

  async function createExport() {
    setBusy("export");
    setMessage(null);
    setExportLinks(null);
    try {
      const response = await fetch("/api/operator/privacy/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = (await response.json()) as {
        export?: { downloads?: { json?: string; html?: string }; expiresAt?: string };
        error?: { message?: string };
      };
      if (!response.ok || !body.export?.downloads?.json || !body.export.downloads.html) {
        throw new Error(body.error?.message ?? "Founder Data Export could not be created.");
      }
      setExportLinks({
        json: body.export.downloads.json,
        html: body.export.downloads.html,
        expiresAt: body.export.expiresAt ?? "",
      });
      setMessage("Founder Data Export ready. Both downloads expire after 24 hours.");
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Founder Data Export could not be created.",
      );
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
        <div className={styles.aiPanel}>
          <strong>Retention schedule</strong>
          <p>
            Working Context expires after {privacy.retention.schedules.workingContextDays} days.
            Closed or ignored Relationship Records expire after{" "}
            {privacy.retention.schedules.closedRelationshipMonths} months. Decision metadata is
            retained for {privacy.retention.schedules.decisionMetadataMonths} months.
          </p>
          {privacy.retention.warnings.length === 0 ? (
            <p>No Relationship Records are currently within their 30-day removal warning window.</p>
          ) : (
            <ul>
              {privacy.retention.warnings.map((warning) => (
                <li key={warning.entityId}>
                  {warning.label} expires on {formatDate(warning.expiresAt)}.
                </li>
              ))}
            </ul>
          )}
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
            <h3 id="bruno-data-deletion">Delete retained data</h3>
            <p>{privacy.deletionBoundary}</p>
            <button
              className={styles.danger}
              disabled={busy !== null}
              onClick={() => void requestDeletion("request_deletion")}
              type="button"
            >
              {busy === "delete" ? "Requesting…" : "Request staged deletion"}
            </button>
          </div>
          <div>
            <h3>Close account</h3>
            <p>
              Revokes every connected account, cancels unstarted effects, and starts staged
              deletion.
            </p>
            <button
              className={styles.danger}
              disabled={busy !== null}
              onClick={() => void requestDeletion("close_account")}
              type="button"
            >
              {busy === "close" ? "Closing…" : "Close account"}
            </button>
          </div>
        </div>
        {deletion ? (
          <DeletionReceipt receipt={deletion} onRetry={retryRevocations} busy={busy !== null} />
        ) : null}
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

      <section className={styles.section} aria-labelledby="founder-data-export">
        <div className={styles.sectionHeading}>
          <p className={styles.kicker}>Founder Data Export</p>
          <h2 id="founder-data-export">Take your retained Bruno records with you</h2>
        </div>
        <div className={styles.dataControls}>
          <div>
            <h3>Portable and bounded</h3>
            <p>{privacy.exportPolicy.description}</p>
            <ul>
              {privacy.exportPolicy.exclusions.map((exclusion) => (
                <li key={exclusion}>{exclusion}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>Request a fresh snapshot</h3>
            <p>
              Available as {privacy.exportPolicy.formats.join(" and ").toUpperCase()}. Creating an
              export does not disconnect providers or delete local data.
            </p>
            <button
              className={styles.secondary}
              disabled={busy !== null}
              onClick={() => void createExport()}
              type="button"
            >
              {busy === "export" ? "Preparing…" : "Create Founder Data Export"}
            </button>
            {exportLinks ? (
              <div className={styles.exportLinks}>
                <a href={exportLinks.html} download>
                  Download human-readable HTML
                </a>
                <a href={exportLinks.json} download>
                  Download portable JSON
                </a>
                <small>Expires {formatDate(exportLinks.expiresAt)}</small>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function DeletionReceipt({
  receipt,
  onRetry,
  busy,
}: {
  receipt: FounderDeletionReceipt;
  onRetry: () => void;
  busy: boolean;
}) {
  const hasFailedRevocation = receipt.revocations.some((item) => item.status === "failed");
  return (
    <div className={styles.aiPanel} aria-live="polite">
      <h3>Deletion Receipt · {receipt.request.status}</h3>
      <p>Requested {formatDate(receipt.request.requestedAt)}.</p>
      <ul>
        <li>Access stopped: {formatDate(receipt.request.accessStoppedAt)}</li>
        <li>Active purge due: {formatDate(receipt.request.activePurgeDueAt)}</li>
        <li>Backup expiry due: {formatDate(receipt.request.backupExpiryDueAt)}</li>
        <li>Active purge complete: {formatDate(receipt.request.activePurgeCompletedAt)}</li>
        <li>Backup expiry complete: {formatDate(receipt.request.backupExpiredAt)}</li>
      </ul>
      {receipt.revocations.length > 0 ? (
        <>
          <strong>Provider revocation</strong>
          <ul>
            {receipt.revocations.map((item) => (
              <li key={item.connectionKind}>
                {item.connectionKind}: {item.status}
                {item.errorCode ? ` (${item.errorCode})` : ""}
              </li>
            ))}
          </ul>
          {hasFailedRevocation ? (
            <button className={styles.secondary} disabled={busy} onClick={onRetry} type="button">
              Retry provider revocation
            </button>
          ) : null}
        </>
      ) : null}
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
