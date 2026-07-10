import type { CostEstimate, RunnerCostEstimateDto } from "@/src/server/costs/cost-estimates";
import styles from "./runner-cost-context.module.css";

const RAW_COMPUTE_PLAN_CONTEXT =
  "Raw compute estimate only. A plan can cost more because it may also include orchestration, monitoring, backups, support, and margin.";

export type RunnerCostContextResult =
  | { ok: true; estimate: RunnerCostEstimateDto | null }
  | { ok: false };

export function RunnerCostContext({ result }: { result: RunnerCostContextResult }) {
  if (!result.ok) {
    return (
      <section className={styles.panel} data-availability="error" aria-label="Runner cost estimate">
        <p className={styles.kicker}>Raw compute · trailing 30 days</p>
        <div className={styles.unavailable} role="alert">
          <strong>Cost estimate could not be loaded</strong>
          <span>Health and capacity remain available above.</span>
        </div>
        <p className={styles.context}>{RAW_COMPUTE_PLAN_CONTEXT}</p>
      </section>
    );
  }

  if (!result.estimate) {
    return (
      <section
        className={styles.panel}
        data-availability="unavailable"
        aria-label="Runner cost estimate"
      >
        <p className={styles.kicker}>Raw compute · trailing 30 days</p>
        <div className={styles.unavailable}>
          <strong>Cost estimate unavailable</strong>
          <span>No matching runner estimate is available. This is not treated as zero cost.</span>
        </div>
        <p className={styles.context}>{RAW_COMPUTE_PLAN_CONTEXT}</p>
      </section>
    );
  }

  const estimate = result.estimate;
  const allMoneyAvailable =
    estimate.runnerMonthlyCost.available &&
    estimate.estimatedInfrastructureCost.available &&
    estimate.estimatedInfrastructureCostPerAgent.available;

  return (
    <section
      className={styles.panel}
      data-availability={allMoneyAvailable ? "available" : "unavailable"}
      aria-label="Runner cost estimate"
    >
      <div className={styles.header}>
        <p className={styles.kicker}>Raw compute · trailing 30 days</p>
        <span className={styles.signal}>{allMoneyAvailable ? "Estimated" : "Unavailable"}</span>
      </div>
      <dl className={styles.metrics}>
        <CostMetric label="Estimated monthly runner cost" estimate={estimate.runnerMonthlyCost} />
        <CostMetric
          label="Estimated 30-day infrastructure cost"
          estimate={estimate.estimatedInfrastructureCost}
        />
        <CostMetric
          label="Estimated 30-day cost per active agent"
          estimate={estimate.estimatedInfrastructureCostPerAgent}
        />
      </dl>
      <dl className={styles.allocation} aria-label="Runner cost allocation">
        <div>
          <dt>Running now</dt>
          <dd>{estimate.runningAgentCount}</dd>
        </div>
        <div>
          <dt>Active in window</dt>
          <dd>{estimate.windowActiveAgentCount}</dd>
        </div>
      </dl>
      {!estimate.runnerMonthlyCost.available ? (
        <p className={styles.reason}>{estimate.runnerMonthlyCost.explanation}</p>
      ) : null}
      <p className={styles.context}>{RAW_COMPUTE_PLAN_CONTEXT}</p>
    </section>
  );
}

function CostMetric({ label, estimate }: { label: string; estimate: CostEstimate }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{estimate.available ? `${formatUsdCents(estimate.cents)} estimated` : "Unavailable"}</dd>
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
