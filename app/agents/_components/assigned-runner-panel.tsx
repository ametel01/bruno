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
  suppressAlert = false,
}: {
  costResult: RunnerCostContextResult;
  result: AssignedRunnerStatusResult;
  suppressAlert?: boolean;
}) {
  return (
    <details className="manual-runner-panel assigned-runner-disclosure">
      <summary id="agent-assigned-runner-title">
        <span>
          <strong>Assigned runner details</strong>
          <small>Advanced operational evidence</small>
        </span>
        {result.ok ? (
          <span>
            {suppressAlert && result.runner ? "recovering" : (result.runner?.status ?? "none")}
          </span>
        ) : null}
      </summary>
      {result.ok ? (
        result.runner ? (
          <AssignedRunnerStatus
            costResult={costResult}
            runner={result.runner}
            suppressAlert={suppressAlert}
          />
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
    </details>
  );
}

function AssignedRunnerStatus({
  costResult,
  runner,
  suppressAlert,
}: {
  costResult: RunnerCostContextResult;
  runner: AssignedManualRunnerStatusSummary;
  suppressAlert: boolean;
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
      {runner.alertMessage && !suppressAlert ? (
        <div className="safe-error manual-runner-alert" role="alert">
          {runner.alertMessage}
        </div>
      ) : null}
    </div>
  );
}
