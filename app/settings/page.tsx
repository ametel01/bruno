import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import {
  RunnerCredentialControls,
  RunnerRegistrationTokenControls,
} from "@/app/settings/_components/runner-management-controls";
import {
  listSettingsRunnerManagementSummariesForDevelopmentUser,
  ManualRunnerStatusPersistenceError,
  type SettingsRunnerManagementSummary,
} from "@/src/server/runners/manual-runner-status";

type SettingsRunnerHealthResult = Awaited<ReturnType<typeof loadSettingsRunnerHealth>>;

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const runnerHealthResult = await loadSettingsRunnerHealth();

  return (
    <ProductShell
      active="settings"
      eyebrow="Settings"
      title="Workspace settings"
      description="Configuration categories are visible while registered runner health is read from the current development workspace."
    >
      <div className="settings-grid">
        <PlaceholderPanel title="Application">
          <p>Workspace naming, ownership, and environment policy will be defined later.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Environment">
          <p>Runtime environment controls are not implemented in this milestone.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Billing">
          <p>Plans, invoices, usage, and subscription state are not connected.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Integrations">
          <p>Hermes, Telegram, provider integrations, and webhooks are not configured here.</p>
        </PlaceholderPanel>
        <SettingsRunnerHealthPanel result={runnerHealthResult} />
        <PlaceholderPanel title="Secrets">
          <p>Secret values and credential storage are not accepted by the current app.</p>
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}

function SettingsRunnerHealthPanel({ result }: { result: SettingsRunnerHealthResult }) {
  return (
    <section className="manual-runner-panel" aria-labelledby="settings-runner-health-title">
      <div className="section-heading">
        <h2 id="settings-runner-health-title">Registered runners</h2>
        {result.ok ? <span>{result.runners.length} listed</span> : null}
      </div>
      <RunnerRegistrationTokenControls disabled={!result.ok} />
      {result.ok ? (
        result.runners.length > 0 ? (
          <ol className="manual-runner-list" aria-label="Registered runner health">
            {result.runners.map((runner) => (
              <SettingsRunnerHealthItem key={runner.managementId} runner={runner} />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No runners registered</h3>
            <p>Create a registration token, then exchange it from a runner host.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Registered runners could not be loaded.
        </div>
      )}
    </section>
  );
}

function SettingsRunnerHealthItem({ runner }: { runner: SettingsRunnerManagementSummary }) {
  return (
    <li className="manual-runner-item" data-status={runner.status}>
      <div className="manual-runner-header">
        <h3>{runner.name}</h3>
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
      <RunnerCredentialControls runnerId={runner.managementId} runnerName={runner.name} />
    </li>
  );
}

async function loadSettingsRunnerHealth() {
  try {
    return {
      ok: true as const,
      runners: await listSettingsRunnerManagementSummariesForDevelopmentUser(),
    };
  } catch (error) {
    if (error instanceof ManualRunnerStatusPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}
