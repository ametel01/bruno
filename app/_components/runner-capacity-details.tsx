import type { ManualRunnerCapacitySummary } from "@/src/server/runners/manual-runner-status";

const WHOLE_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

export function RunnerCapacityDefinitionItems({
  capacity,
}: {
  capacity: ManualRunnerCapacitySummary;
}) {
  return (
    <>
      <div>
        <dt>Capacity</dt>
        <dd>{formatAgentCapacity(capacity)}</dd>
      </div>
      <div>
        <dt>CPU</dt>
        <dd>{formatPercent(capacity.cpuUsedPercent)}</dd>
      </div>
      <div>
        <dt>Memory</dt>
        <dd>{formatMegabytes(capacity.memoryUsedMb, capacity.memoryTotalMb)}</dd>
      </div>
      <div>
        <dt>Disk</dt>
        <dd>{formatMegabytes(capacity.diskUsedMb, capacity.diskTotalMb)}</dd>
      </div>
      <div>
        <dt>Start blocker</dt>
        <dd>
          {capacity.blocker === "runner_capacity_reached"
            ? "Runner capacity reached"
            : "No runner capacity blocker"}
        </dd>
      </div>
    </>
  );
}

function formatAgentCapacity(capacity: ManualRunnerCapacitySummary): string {
  const noun = capacity.maxAgents === 1 ? "agent" : "agents";

  return `${capacity.runningAgents} / ${capacity.maxAgents} ${noun} running`;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return "Not reported";
  }

  return `${Math.round(value)}%`;
}

function formatMegabytes(used: number | null, total: number | null): string {
  if (used === null || total === null || total <= 0) {
    return "Not reported";
  }

  return `${formatNumber(used)} / ${formatNumber(total)} MB`;
}

function formatNumber(value: number): string {
  return WHOLE_NUMBER_FORMATTER.format(Math.round(value));
}
