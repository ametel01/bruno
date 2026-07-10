import type {
  CostEstimate,
  CostEstimateWindowDto,
  DevelopmentUserCostEstimatesDto,
} from "@/src/server/costs/cost-estimates";
import styles from "./cost-summary.module.css";

export type DashboardCostResult =
  | { ok: true; estimates: DevelopmentUserCostEstimatesDto }
  | { ok: false };

export function DashboardCostSummary({ result }: { result: DashboardCostResult }) {
  return (
    <section className={styles.panel} aria-labelledby="dashboard-cost-summary-title">
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Cost telemetry</p>
          <h2 id="dashboard-cost-summary-title">Infrastructure cost estimates</h2>
        </div>
        <span className={styles.badge}>Raw compute estimate</span>
      </div>
      {result.ok ? (
        <>
          <p className={styles.intro}>
            Trailing usage windows from persisted runner activity. Manual runners and unknown
            provider prices remain unavailable until price metadata is configured.
          </p>
          <div className={styles.windows}>
            <CostWindow window={result.estimates.daily} />
            <CostWindow window={result.estimates.monthly} />
          </div>
          <p className={styles.disclaimer}>
            Raw compute estimate only; plans may also include orchestration, monitoring, backups,
            support, and margin. Generated{" "}
            <time dateTime={result.estimates.generatedAt}>{result.estimates.generatedAt}</time>.
          </p>
        </>
      ) : (
        <div className={styles.error} role="alert">
          <strong>Infrastructure cost estimates could not be loaded.</strong>
          <span>Agent and runner operations remain available. Try refreshing this view.</span>
        </div>
      )}
    </section>
  );
}

function CostWindow({ window }: { window: CostEstimateWindowDto }) {
  const isDaily = window.key === "daily";
  const titleId = `dashboard-${window.key}-cost-title`;

  return (
    <section className={styles.window} aria-labelledby={titleId}>
      <div className={styles.windowHeading}>
        <div>
          <p className={styles.windowIndex}>{isDaily ? "24H" : "30D"}</p>
          <h3 id={titleId}>{isDaily ? "Daily estimate" : "Monthly estimate"}</h3>
        </div>
        <span>{formatCount(window.runnerCount, "runner")} included</span>
      </div>
      <dl className={styles.metrics}>
        <CostMetric label="Estimated runner monthly cost" estimate={window.runnerMonthlyCost} />
        <CostMetric
          label={
            isDaily
              ? "Estimated daily infrastructure cost"
              : "Estimated monthly infrastructure cost"
          }
          estimate={window.estimatedInfrastructureCost}
        />
        <CostMetric
          detail="Based on agents active during this window."
          label="Estimated infrastructure cost per agent"
          estimate={window.estimatedInfrastructureCostPerAgent}
        />
        <div className={styles.metric}>
          <dt>Running agents now</dt>
          <dd>
            <span className={styles.value}>{window.runningAgentCount} running</span>
            <span className={styles.detail}>
              {window.windowActiveAgentCount === 0
                ? "No agents active"
                : `${formatCount(window.windowActiveAgentCount, "agent")} active in window`}
            </span>
          </dd>
        </div>
      </dl>
      <p className={styles.range}>
        <span>{isDaily ? "Trailing 24 hours" : "Trailing 30 days"}</span>
        <time dateTime={window.startsAt}>{window.startsAt}</time>
        <span aria-hidden="true">→</span>
        <time dateTime={window.endsAt}>{window.endsAt}</time>
      </p>
    </section>
  );
}

function CostMetric({
  detail,
  estimate,
  label,
}: {
  detail?: string;
  estimate: CostEstimate;
  label: string;
}) {
  return (
    <div className={styles.metric}>
      <dt>{label}</dt>
      <dd>
        {estimate.available ? (
          <>
            <span className={styles.value}>{formatUsdCents(estimate.cents)}</span>
            <span className={styles.detail}>{detail ?? "USD estimate"}</span>
          </>
        ) : (
          <>
            <span className={`${styles.value} ${styles.unavailable}`}>{estimate.label}</span>
            <span className={styles.detail}>{estimate.explanation}</span>
          </>
        )}
      </dd>
    </div>
  );
}

function formatUsdCents(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(cents / 100);
}

function formatCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
