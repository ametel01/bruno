import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { ProductShell } from "@/app/_components/product-shell";
import { RunnerCapacityDefinitionItems } from "@/app/_components/runner-capacity-details";
import {
  RunnerCredentialControls,
  RunnerRegistrationTokenControls,
} from "@/app/settings/_components/runner-management-controls";
import {
  CostEstimatePersistenceError,
  getCostEstimatesForUser,
  type RunnerCostEstimateDto,
} from "@/src/server/costs/cost-estimates";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForUser,
} from "@/src/server/runners/cloud-runner-provisioning";
import {
  listSettingsRunnerManagementSummariesForUser,
  ManualRunnerStatusPersistenceError,
  type SettingsRunnerManagementSummary,
} from "@/src/server/runners/manual-runner-status";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type SettingsRunnerHealthResult = Awaited<ReturnType<typeof loadSettingsRunnerHealth>>;
type SettingsRunnerCostResult = { ok: true; runners: RunnerCostEstimateDto[] } | { ok: false };

const SETTINGS_CATEGORIES = [
  {
    description: "Workspace naming, ownership, and environment policy will be defined later.",
    title: "Application",
  },
  {
    description: "Runtime environment controls are not implemented in this milestone.",
    title: "Environment",
  },
  {
    description: "Plans, invoices, usage, and subscription state are not connected.",
    title: "Billing",
  },
  {
    description: "Hermes, Telegram, provider integrations, and webhooks are not configured here.",
    title: "Integrations",
  },
  {
    description: "Secret values and credential storage are not accepted by the current app.",
    title: "Secrets",
  },
] as const;

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const applicationUser = await requireConfiguredApplicationUser();

  if (!applicationUser.ok) {
    return (
      <ProductShell
        active="settings"
        eyebrow="Settings"
        title="Authentication required"
        description="Sign in to load user-scoped workspace settings."
      >
        <div className="safe-error" role="alert">
          Authentication is required.
        </div>
      </ProductShell>
    );
  }

  const [runnerHealthResult, cloudRunnersResult, runnerCostResult] = await Promise.all([
    loadSettingsRunnerHealth(applicationUser.userId),
    loadSettingsCloudRunners(applicationUser.userId),
    loadSettingsRunnerCosts(applicationUser.userId),
  ]);

  return (
    <ProductShell
      active="settings"
      eyebrow="Settings"
      title="Workspace settings"
      description="Manage runner capacity, provisioning, registration, and credentials from one workspace."
    >
      <div className="settings-page">
        <SettingsFleetOverview
          cloudRunnersResult={cloudRunnersResult}
          runnerHealthResult={runnerHealthResult}
        />

        <section className="settings-runner-workspace" aria-labelledby="settings-runners-title">
          <div className="settings-section-heading">
            <div>
              <p>Provisioning and access</p>
              <h2 id="settings-runners-title">Runner management</h2>
            </div>
            <span>Live workspace state</span>
          </div>
          <div className="settings-runner-inventory">
            <CloudRunnerProvisioningPanel
              costResult={runnerCostResult}
              result={cloudRunnersResult}
              showCreateAction
              title="Cloud runners"
              titleId="settings-cloud-runner-title"
            />
            <SettingsRunnerHealthPanel result={runnerHealthResult} />
          </div>
        </section>

        <SettingsConfigurationNotes />
      </div>
    </ProductShell>
  );
}

function SettingsFleetOverview({
  cloudRunnersResult,
  runnerHealthResult,
}: {
  cloudRunnersResult: Awaited<ReturnType<typeof loadSettingsCloudRunners>>;
  runnerHealthResult: SettingsRunnerHealthResult;
}) {
  const registeredCount = runnerHealthResult.ok ? runnerHealthResult.runners.length : null;
  const registeredReadyCount = runnerHealthResult.ok
    ? runnerHealthResult.runners.filter((runner) => runner.status === "online").length
    : null;
  const cloudCount = cloudRunnersResult.ok ? cloudRunnersResult.runners.length : null;
  const cloudReadyCount = cloudRunnersResult.ok
    ? cloudRunnersResult.runners.filter((runner) => runner.readinessStatus === "online").length
    : null;
  const readyCount =
    registeredReadyCount !== null && cloudReadyCount !== null
      ? registeredReadyCount + cloudReadyCount
      : null;
  const attentionCount =
    runnerHealthResult.ok && cloudRunnersResult.ok
      ? runnerHealthResult.runners.filter((runner) => runner.status !== "online").length +
        cloudRunnersResult.runners.filter((runner) => runner.readinessStatus === "failed").length
      : null;

  return (
    <section className="settings-fleet-overview" aria-labelledby="settings-fleet-title">
      <div className="settings-fleet-heading">
        <div>
          <p>Operational control plane</p>
          <h2 id="settings-fleet-title">Runner fleet</h2>
        </div>
        <span>Persisted state</span>
      </div>
      <dl>
        <div data-state={registeredCount !== null ? "active" : "neutral"}>
          <dt>Registered</dt>
          <dd>
            <strong>{registeredCount ?? "—"}</strong>
            <span>manual and managed runners</span>
          </dd>
        </div>
        <div data-state={cloudCount !== null ? "active" : "neutral"}>
          <dt>Cloud</dt>
          <dd>
            <strong>{cloudCount ?? "—"}</strong>
            <span>provisioning records</span>
          </dd>
        </div>
        <div data-state={readyCount !== null && readyCount > 0 ? "clear" : "neutral"}>
          <dt>Ready</dt>
          <dd>
            <strong>{readyCount ?? "—"}</strong>
            <span>online runners</span>
          </dd>
        </div>
        <div data-state={attentionCount !== null && attentionCount > 0 ? "attention" : "clear"}>
          <dt>Needs attention</dt>
          <dd>
            <strong>{attentionCount ?? "—"}</strong>
            <span>offline, degraded, or failed</span>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function SettingsConfigurationNotes() {
  return (
    <details className="settings-configuration-notes">
      <summary>
        <span>
          <strong>Workspace configuration</strong>
          <small>Application, environment, billing, integrations, and secrets</small>
        </span>
        <span>{SETTINGS_CATEGORIES.length} planned areas</span>
      </summary>
      <div className="settings-configuration-grid">
        {SETTINGS_CATEGORIES.map((category) => (
          <section key={category.title}>
            <span>Planned</span>
            <h3>{category.title}</h3>
            <p>{category.description}</p>
          </section>
        ))}
      </div>
    </details>
  );
}

function SettingsRunnerHealthPanel({ result }: { result: SettingsRunnerHealthResult }) {
  return (
    <section
      className="manual-runner-panel settings-registered-runner-panel"
      aria-labelledby="settings-runner-health-title"
    >
      <div className="section-heading">
        <h2 id="settings-runner-health-title">Registered runners</h2>
        {result.ok ? <span>{result.runners.length} listed</span> : null}
      </div>
      <RunnerRegistrationTokenControls disabled={!result.ok} />
      {result.ok ? (
        result.runners.length > 0 ? (
          <ol
            className="manual-runner-list settings-registered-runner-list"
            aria-label="Registered runner health"
          >
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
      <RunnerCredentialControls runnerId={runner.managementId} runnerName={runner.name} />
    </li>
  );
}

async function loadSettingsRunnerHealth(userId: string) {
  try {
    return {
      ok: true as const,
      runners: await listSettingsRunnerManagementSummariesForUser(userId),
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

async function loadSettingsCloudRunners(userId: string) {
  try {
    return {
      ok: true as const,
      runners: await listCloudRunnerProvisioningSummariesForUser(userId),
    };
  } catch (error) {
    if (error instanceof CloudRunnerProvisioningPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadSettingsRunnerCosts(userId: string): Promise<SettingsRunnerCostResult> {
  try {
    const estimates = await getCostEstimatesForUser(userId);

    return {
      ok: true,
      runners: estimates.monthly.runners,
    };
  } catch (error) {
    if (error instanceof CostEstimatePersistenceError) {
      return {
        ok: false,
      };
    }

    throw error;
  }
}
