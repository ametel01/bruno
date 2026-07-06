import { CreateCloudRunnerControls } from "@/app/settings/_components/runner-management-controls";
import type { CloudRunnerProvisioningSummary } from "@/src/server/runners/cloud-runner-provisioning";

type CloudRunnerProvisioningResult =
  | {
      ok: true;
      runners: CloudRunnerProvisioningSummary[];
    }
  | {
      ok: false;
    };

type CloudRunnerProvisioningPanelProps = {
  result: CloudRunnerProvisioningResult;
  title: string;
  titleId: string;
  showCreateAction?: boolean;
};

export function CloudRunnerProvisioningPanel({
  result,
  showCreateAction = false,
  title,
  titleId,
}: CloudRunnerProvisioningPanelProps) {
  return (
    <section className="manual-runner-panel cloud-runner-panel" aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>{title}</h2>
        {result.ok ? <span>{result.runners.length > 0 ? "tracked" : "not started"}</span> : null}
      </div>
      {showCreateAction ? <CreateCloudRunnerControls disabled={!result.ok} /> : null}
      {result.ok ? (
        result.runners.length > 0 ? (
          <ol className="manual-runner-list" aria-label="Cloud runner provisioning status">
            {result.runners.map((runner) => (
              <CloudRunnerProvisioningItem key={runner.id} runner={runner} />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No cloud runners</h3>
            <p>Create a runner to track provisioning, readiness, and safe failures here.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Cloud runner provisioning could not be loaded.
        </div>
      )}
    </section>
  );
}

function CloudRunnerProvisioningItem({ runner }: { runner: CloudRunnerProvisioningSummary }) {
  return (
    <li className="manual-runner-item cloud-runner-item" data-status={runner.readinessStatus}>
      <div className="manual-runner-header">
        <div>
          <h3>{runner.name}</h3>
          <p>{readinessCopy(runner)}</p>
        </div>
        <span className="status-pill">{runner.readinessStatus}</span>
      </div>
      <dl className="definition-list compact-definition-list">
        <div>
          <dt>Provider</dt>
          <dd>{runner.provider}</dd>
        </div>
        <div>
          <dt>Region</dt>
          <dd>{runner.region}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{runner.sizeSlug}</dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd>{runner.image}</dd>
        </div>
        <div>
          <dt>Phase</dt>
          <dd>{runner.provisioning.status}</dd>
        </div>
        <div>
          <dt>Provider resource</dt>
          <dd>{runner.providerResourceId ?? "Not assigned yet"}</dd>
        </div>
        <div>
          <dt>Started</dt>
          <dd>
            {runner.provisioning.startedAt ? (
              <time dateTime={runner.provisioning.startedAt}>{runner.provisioning.startedAt}</time>
            ) : (
              "Not started"
            )}
          </dd>
        </div>
        <div>
          <dt>Completed</dt>
          <dd>
            {runner.provisioning.completedAt ? (
              <time dateTime={runner.provisioning.completedAt}>
                {runner.provisioning.completedAt}
              </time>
            ) : (
              "In progress"
            )}
          </dd>
        </div>
        <div>
          <dt>Latest heartbeat</dt>
          <dd>
            {runner.latestHeartbeatAt ? (
              <time dateTime={runner.latestHeartbeatAt}>{runner.latestHeartbeatAt}</time>
            ) : (
              "No heartbeat yet"
            )}
          </dd>
        </div>
      </dl>
      <ol className="provisioning-phase-list" aria-label={`${runner.name} provisioning phases`}>
        {runner.provisioning.phases.map((phase) => (
          <li key={phase.name} data-phase-status={phase.status}>
            <span aria-hidden="true" />
            {phase.name}
          </li>
        ))}
      </ol>
      {runner.provisioning.error ? (
        <p className="manual-runner-alert safe-error" role="alert">
          {runner.provisioning.error} Next step: check the provider configuration and create a new
          runner when the issue is fixed.
        </p>
      ) : null}
    </li>
  );
}

function readinessCopy(runner: CloudRunnerProvisioningSummary): string {
  if (runner.readinessStatus === "online") {
    return "Runner heartbeat is online and ready for work.";
  }

  if (runner.readinessStatus === "failed") {
    return "Provisioning needs operator attention before this runner can accept work.";
  }

  if (runner.readinessStatus === "provisioning") {
    return "Provisioning is in progress; refresh to load the latest persisted phase.";
  }

  return "Runner readiness is read from persisted server state.";
}
