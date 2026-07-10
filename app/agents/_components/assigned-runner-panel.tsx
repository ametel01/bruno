import { RunnerCapacityDefinitionItems } from "@/app/_components/runner-capacity-details";
import {
  RunnerCostContext,
  type RunnerCostContextResult,
} from "@/app/_components/runner-cost-context";
import type { AssignedManualRunnerStatusSummary } from "@/src/server/runners/manual-runner-status";

export type AssignedRunnerStatusResult =
  | { ok: true; runner: AssignedManualRunnerStatusSummary | null }
  | { ok: false };

export function AssignedRunnerPanel({
  costResult,
  result,
}: {
  costResult: RunnerCostContextResult;
  result: AssignedRunnerStatusResult;
}) {
  return (
    <section className="manual-runner-panel" aria-labelledby="agent-assigned-runner-title">
      <div className="section-heading">
        <h2 id="agent-assigned-runner-title">Assigned runner</h2>
        {result.ok ? <span>{result.runner ? result.runner.status : "none"}</span> : null}
      </div>
      {result.ok ? (
        result.runner ? (
          <AssignedRunnerStatus costResult={costResult} runner={result.runner} />
        ) : (
          <div className="activity-empty-state">
            <h3>No runner assigned</h3>
            <p>This agent is not assigned to a runner.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Assigned runner status could not be loaded.
        </div>
      )}
    </section>
  );
}

function AssignedRunnerStatus({
  costResult,
  runner,
}: {
  costResult: RunnerCostContextResult;
  runner: AssignedManualRunnerStatusSummary;
}) {
  return (
    <div className="manual-runner-item" data-status={runner.status}>
      <div className="manual-runner-header">
        <div>
          <h3>{runner.name}</h3>
          <p>{runner.assignmentNotice}</p>
        </div>
        <span className="status-pill">{runner.status}</span>
      </div>
      <dl className="definition-list compact-definition-list">
        <div>
          <dt>Kind</dt>
          <dd>{runner.kind}</dd>
        </div>
        <div>
          <dt>Endpoint host</dt>
          <dd>{runner.endpointHost}</dd>
        </div>
        <RunnerCapacityDefinitionItems capacity={runner.capacity} />
        <div>
          <dt>Version</dt>
          <dd>{runner.version ?? "Not reported"}</dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>
            {runner.lastSeenAt ? (
              <time dateTime={runner.lastSeenAt}>{runner.lastSeenAt}</time>
            ) : (
              "No heartbeat yet"
            )}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>
            <time dateTime={runner.updatedAt}>{runner.updatedAt}</time>
          </dd>
        </div>
      </dl>
      <RunnerCostContext result={costResult} />
      {runner.alertMessage ? (
        <div className="safe-error manual-runner-alert" role="alert">
          {runner.alertMessage}
        </div>
      ) : null}
    </div>
  );
}
