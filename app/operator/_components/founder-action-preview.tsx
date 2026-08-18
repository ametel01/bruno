import type { FounderActionPreviewDto } from "@/src/server/operators/founder-action-previews";
import styles from "./founder-action-preview.module.css";

export function FounderActionPreviewCard({
  preview,
  compact = false,
}: {
  preview: FounderActionPreviewDto;
  compact?: boolean;
}) {
  const current = preview.current;
  return (
    <article
      className={`${styles.card} ${compact ? styles.compact : ""}`}
      data-preview-id={preview.id}
      data-preview-revision={current.revision}
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.kicker}>Canonical Action Preview</p>
          <h4>Possible external action · revision {current.revision}</h4>
        </div>
        <span className={styles.badge}>{current.state}</span>
      </div>
      <dl className={styles.details}>
        <div>
          <dt>Recipient</dt>
          <dd>
            {current.recipient.name} · {current.recipient.address}
          </dd>
        </div>
        <div>
          <dt>Content</dt>
          <dd className={styles.content}>{current.content}</dd>
        </div>
        <div>
          <dt>Supporting evidence</dt>
          <dd>
            <ul>
              {current.supportingEvidence.map((evidence) => (
                <li key={`${evidence.label}:${evidence.detail}`}>
                  <strong>{evidence.label}:</strong> {evidence.detail}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Expected external effect</dt>
          <dd>{current.expectedExternalEffect}</dd>
        </div>
      </dl>
      <p className={styles.safety}>
        Preview only. Authority: none. Bruno will not send, approve, or cause an external effect
        from this preview.
      </p>
    </article>
  );
}
