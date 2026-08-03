import Link from "next/link";
import { ActivityFeedPanel } from "@/app/_components/activity-feed";
import { ApprovalDecisionControls } from "@/app/_components/approval-decision-controls";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { EmptyState, ProductShell } from "@/app/_components/product-shell";
import { RunnerCapacityDefinitionItems } from "@/app/_components/runner-capacity-details";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "@/app/agents/_components/agent-start-readiness";
import { DeploymentStatusLabel } from "@/app/agents/_components/deployment-status-label";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import {
  DashboardCostSummary,
  type DashboardCostResult,
} from "@/app/dashboard/_components/cost-summary";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import {
  AgentListPersistenceError,
  listActiveAgentsForUser,
} from "@/src/server/agents/list-agents";
import {
  AgentApprovalPersistenceError,
  listPendingApprovalsForUser,
  type PendingApprovalDto,
} from "@/src/server/approvals/agent-approvals";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listLatestAgentActivityForUser } from "@/src/server/events/agent-events";
import {
  listLatestActiveAgentProcessLogsForUser,
  type LatestAgentProcessLogDto,
} from "@/src/server/logs/agent-logs";
import {
  listManualRunnerStatusSummariesForUser,
  ManualRunnerStatusPersistenceError,
  type ManualRunnerStatusSummary,
} from "@/src/server/runners/manual-runner-status";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForUser,
} from "@/src/server/runners/cloud-runner-provisioning";
import {
  CostEstimatePersistenceError,
  getCostEstimatesForUser,
} from "@/src/server/costs/cost-estimates";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

type DashboardContentProps = {
  routeLabel?: string;
};

type DashboardAgentResult = Awaited<ReturnType<typeof loadDashboardAgents>>;
type DashboardActivityResult = Awaited<ReturnType<typeof loadDashboardActivity>>;
type DashboardApprovalsResult = Awaited<ReturnType<typeof loadDashboardApprovals>>;
type DashboardProcessLogsResult = Awaited<ReturnType<typeof loadDashboardProcessLogs>>;
type DashboardManualRunnersResult = Awaited<ReturnType<typeof loadDashboardManualRunners>>;
type DashboardCloudRunnersResult = Awaited<ReturnType<typeof loadDashboardCloudRunners>>;

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const applicationUser = await requireConfiguredApplicationUser();

  if (!applicationUser.ok) {
    return (
      <ProductShell
        active="dashboard"
        eyebrow="Dashboard"
        title="Authentication required"
        description="Sign in to load user-scoped operational data."
      >
        <div className="safe-error" role="alert">
          Authentication is required.
        </div>
      </ProductShell>
    );
  }

  const [
    listResult,
    activityResult,
    approvalsResult,
    processLogsResult,
    manualRunnersResult,
    cloudRunnersResult,
    costResult,
  ] = await Promise.all([
    loadDashboardAgents(applicationUser.userId),
    loadDashboardActivity(applicationUser.userId),
    loadDashboardApprovals(applicationUser.userId),
    loadDashboardProcessLogs(applicationUser.userId),
    loadDashboardManualRunners(applicationUser.userId),
    loadDashboardCloudRunners(applicationUser.userId),
    loadDashboardCosts(applicationUser.userId),
  ]);

  return (
    <DashboardContent
      activityResult={activityResult}
      approvalsResult={approvalsResult}
      cloudRunnersResult={cloudRunnersResult}
      costResult={costResult}
      listResult={listResult}
      manualRunnersResult={manualRunnersResult}
      processLogsResult={processLogsResult}
    />
  );
}

export function DashboardContent({
  activityResult = { ok: true, events: [] },
  approvalsResult = { ok: true, approvals: [] },
  cloudRunnersResult = { ok: true, runners: [] },
  costResult,
  manualRunnersResult = { ok: true, runners: [] },
  processLogsResult = { ok: true, logs: [] },
  routeLabel = "Dashboard",
  listResult = { ok: true, agents: [] },
}: DashboardContentProps & {
  activityResult?: DashboardActivityResult;
  approvalsResult?: DashboardApprovalsResult;
  cloudRunnersResult?: DashboardCloudRunnersResult;
  costResult?: DashboardCostResult;
  manualRunnersResult?: DashboardManualRunnersResult;
  processLogsResult?: DashboardProcessLogsResult;
  listResult?: DashboardAgentResult;
}) {
  const activeAgentCount = listResult.ok ? listResult.agents.length : null;
  const runningAgentCount = listResult.ok
    ? listResult.agents.filter((agent) =>
        agent.runtime
          ? agent.runtime.kind === "healthy" || agent.runtime.kind === "recovering"
          : ["running", "starting", "restarting"].includes(agent.status),
      ).length
    : null;
  const pendingApprovalCount = approvalsResult.ok ? approvalsResult.approvals.length : null;
  const knownRunnerCount =
    manualRunnersResult.ok && cloudRunnersResult.ok
      ? manualRunnersResult.runners.length + cloudRunnersResult.runners.length
      : null;
  const onlineRunnerCount =
    manualRunnersResult.ok && cloudRunnersResult.ok
      ? manualRunnersResult.runners.filter((runner) => runner.status === "online").length +
        cloudRunnersResult.runners.filter((runner) => runner.readinessStatus === "online").length
      : null;
  const recentActivityCount = activityResult.ok ? activityResult.events.length : null;

  return (
    <ProductShell
      active="dashboard"
      eyebrow={routeLabel}
      title="Operational dashboard"
      description="Triage agent work, approvals, runner health, and recent changes from one workspace."
    >
      <div className="dashboard-page">
        <section className="dashboard-fleet-pulse" aria-labelledby="dashboard-fleet-pulse-title">
          <div className="dashboard-fleet-pulse-heading">
            <div>
              <p>Live operations</p>
              <h2 id="dashboard-fleet-pulse-title">Fleet pulse</h2>
            </div>
            <span>Persisted state</span>
          </div>
          <dl>
            <div data-state={runningAgentCount && runningAgentCount > 0 ? "active" : "neutral"}>
              <dt>Agents</dt>
              <dd>
                <strong>{activeAgentCount ?? "—"}</strong>
                <span>{runningAgentCount ?? "—"} running now</span>
              </dd>
            </div>
            <div
              data-state={pendingApprovalCount && pendingApprovalCount > 0 ? "attention" : "clear"}
            >
              <dt>Approvals</dt>
              <dd>
                <strong>{pendingApprovalCount ?? "—"}</strong>
                <span>{pendingApprovalCount === 1 ? "request waiting" : "requests waiting"}</span>
              </dd>
            </div>
            <div
              data-state={
                knownRunnerCount !== null && knownRunnerCount > 0 && onlineRunnerCount === 0
                  ? "attention"
                  : "clear"
              }
            >
              <dt>Runners</dt>
              <dd>
                <strong>
                  {onlineRunnerCount ?? "—"}/{knownRunnerCount ?? "—"}
                </strong>
                <span>online and known</span>
              </dd>
            </div>
            <div data-state={recentActivityCount && recentActivityCount > 0 ? "active" : "neutral"}>
              <dt>Recent changes</dt>
              <dd>
                <strong>{recentActivityCount ?? "—"}</strong>
                <span>events in view</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="agent-list-panel" aria-labelledby="dashboard-agents-title">
          <div className="section-heading">
            <h2 id="dashboard-agents-title">Persisted agents</h2>
            {listResult.ok ? <span>{listResult.agents.length} active</span> : null}
          </div>
          {listResult.ok ? (
            listResult.agents.length > 0 ? (
              <>
                <div className="agent-table-wrap">
                  <table className="agent-table compact-agent-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Template</th>
                        <th scope="col">Status</th>
                        <th scope="col">Action</th>
                        <th scope="col">Created</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listResult.agents.map((agent) => (
                        <tr key={agent.id}>
                          <td>
                            <Link href={agent.href}>{agent.name}</Link>
                          </td>
                          <td>{agent.templateLabel}</td>
                          <td>
                            <span className="status-pill">
                              {agent.runtime?.label ?? agent.status}
                            </span>
                            <DeploymentStatusLabel
                              deployment={agent.latestDeployment}
                              desiredStatus={agent.desiredStatus}
                              href={`${agent.href}#${agent.runtime ? "runtime-status-title" : "deployment-progress-title"}`}
                              observedStatus={agent.status}
                              runtime={agent.runtime}
                            />
                          </td>
                          <td>
                            <AgentLifecycleControls
                              agentId={agent.id}
                              deployment={agent.latestDeployment}
                              detailHref={`${agent.href}#${agent.runtime ? "runtime-status-title" : "deployment-progress-title"}`}
                              desiredStatus={agent.desiredStatus}
                              runtime={agent.runtime}
                              startDisabledReason={listedAgentStartDisabledReason(agent)}
                              status={agent.status}
                            />
                          </td>
                          <td>
                            <time dateTime={agent.createdAt}>{agent.createdAt}</time>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <MobileAgentList agents={listResult.agents} />
              </>
            ) : (
              <EmptyState
                title="No agent records"
                description="Create an agent from the Agents page to show a stopped persistent record here after refresh."
              />
            )
          ) : (
            <div className="safe-error" role="alert">
              Agent records could not be loaded.
            </div>
          )}
        </section>

        <div className="dashboard-workbench">
          <div className="dashboard-work-queue">
            <PendingApprovalsPanel result={approvalsResult} />
            <DashboardProcessLogsPanel result={processLogsResult} />
          </div>
          <div className="dashboard-activity-column">
            <ActivityFeedPanel
              context={{ kind: "dashboard" }}
              emptyDescription="Create or update an agent to show the newest persisted activity here."
              emptyTitle="No activity yet"
              errorMessage="Latest activity could not be loaded."
              events={activityResult.ok ? activityResult.events : []}
              hasError={!activityResult.ok}
              title="Latest activity"
              titleId="dashboard-activity-title"
            />
          </div>
        </div>

        <section
          className="dashboard-infrastructure"
          aria-labelledby="dashboard-infrastructure-title"
        >
          <div className="dashboard-section-heading">
            <div>
              <p>Capacity and provisioning</p>
              <h2 id="dashboard-infrastructure-title">Infrastructure</h2>
            </div>
            <span>{knownRunnerCount ?? "—"} tracked</span>
          </div>
          <div className="dashboard-infrastructure-grid">
            <DashboardManualRunnerPanel result={manualRunnersResult} />
            <CloudRunnerProvisioningPanel
              result={cloudRunnersResult}
              title="Cloud provisioning"
              titleId="dashboard-cloud-runner-title"
            />
          </div>
        </section>

        {costResult ? <DashboardCostSummary result={costResult} /> : null}

        <details className="dashboard-system-notes">
          <summary>
            <span>
              <strong>System notes</strong>
              <small>Routes, readiness, and implementation status</small>
            </span>
            <span aria-hidden="true">Details</span>
          </summary>
          <div className="dashboard-system-notes-grid">
            <section aria-labelledby="dashboard-readiness-title">
              <h3 id="dashboard-readiness-title">Readiness</h3>
              <dl className="definition-list">
                <div>
                  <dt>Product routes</dt>
                  <dd>Dashboard, agents, settings, and health routes are present.</dd>
                </div>
                <div>
                  <dt>Database check</dt>
                  <dd>
                    The `/health` endpoint remains the operator source for database reachability.
                  </dd>
                </div>
                <div>
                  <dt>Agent data</dt>
                  <dd>Active persisted records are read from the database.</dd>
                </div>
              </dl>
            </section>
            <section aria-labelledby="dashboard-upcoming-title">
              <h3 id="dashboard-upcoming-title">Upcoming surfaces</h3>
              <ul className="plain-list">
                <li>
                  Start, Stop, and Restart use the Docker runner adapter and existing controls.
                </li>
                <li>
                  Full per-agent log streams and local-development config editing are present on
                  agent detail pages.
                </li>
                <li>Cloud runner provisioning status is visible from persisted runner records.</li>
                <li>
                  Approval decisions are available from the queue; production runners, billing, and
                  secret storage wait for later milestones.
                </li>
              </ul>
            </section>
          </div>
        </details>
      </div>
    </ProductShell>
  );
}

function DashboardManualRunnerPanel({ result }: { result: DashboardManualRunnersResult }) {
  return (
    <section className="manual-runner-panel" aria-labelledby="dashboard-manual-runner-title">
      <div className="section-heading">
        <h2 id="dashboard-manual-runner-title">Runner health</h2>
        {result.ok ? <span>{result.runners.length > 0 ? "known" : "not configured"}</span> : null}
      </div>
      {result.ok ? (
        result.runners.length > 0 ? (
          <ol className="manual-runner-list" aria-label="Known runner health">
            {result.runners.map((runner) => (
              <ManualRunnerStatusItem
                key={`${runner.name}:${runner.endpointHost}`}
                runner={runner}
              />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No runner known</h3>
            <p>Register or seed a manual VPS runner to show runner health here.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Runner health could not be loaded.
        </div>
      )}
    </section>
  );
}

function ManualRunnerStatusItem({ runner }: { runner: ManualRunnerStatusSummary }) {
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
    </li>
  );
}

function DashboardProcessLogsPanel({ result }: { result: DashboardProcessLogsResult }) {
  return (
    <section
      className="runtime-log-panel dashboard-process-log-panel"
      aria-labelledby="dashboard-process-logs-title"
    >
      <div className="section-heading">
        <h2 id="dashboard-process-logs-title">Latest process logs</h2>
        {result.ok ? <span>{result.logs.length} shown</span> : null}
      </div>
      {result.ok ? (
        result.logs.length > 0 ? (
          <ol className="runtime-log-list" aria-label="Latest captured process logs">
            {result.logs.map((log) => (
              <DashboardProcessLogItem key={log.id} log={log} />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No process logs yet</h3>
            <p>Captured stdout and stderr lines for active agents will appear here.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Process logs could not be loaded.
        </div>
      )}
    </section>
  );
}

function DashboardProcessLogItem({ log }: { log: LatestAgentProcessLogDto }) {
  return (
    <li className="runtime-log-item">
      <div className="runtime-log-header">
        <time dateTime={log.createdAt}>{log.createdAt}</time>
        <span>#{log.sequence}</span>
      </div>
      <p>{summarizeOperationalText(log.message, "Log details omitted.")}</p>
      <dl className="runtime-log-metadata">
        <div>
          <dt>Agent</dt>
          <dd>
            <Link href={log.agentHref}>{log.agentName}</Link>
          </dd>
        </div>
        <div>
          <dt>Stream</dt>
          <dd>{log.stream}</dd>
        </div>
        <div>
          <dt>Level</dt>
          <dd>{log.level}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{log.source}</dd>
        </div>
      </dl>
    </li>
  );
}

function PendingApprovalsPanel({ result }: { result: DashboardApprovalsResult }) {
  return (
    <section className="approval-panel" aria-labelledby="dashboard-approvals-title">
      <div className="section-heading">
        <h2 id="dashboard-approvals-title">Pending approvals</h2>
        {result.ok ? <span>{result.approvals.length} pending</span> : null}
      </div>
      {result.ok ? (
        result.approvals.length > 0 ? (
          <ol className="approval-list">
            {result.approvals.map((approval) => (
              <PendingApprovalItem approval={approval} key={approval.id} />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No pending approvals</h3>
            <p>Persisted approval requests for active agents will appear here.</p>
          </div>
        )
      ) : (
        <div className="safe-error" role="alert">
          Pending approvals could not be loaded.
        </div>
      )}
    </section>
  );
}

function PendingApprovalItem({ approval }: { approval: PendingApprovalDto }) {
  return (
    <li className="approval-item">
      <div className="approval-item-header">
        <div>
          <Link href={approval.agentHref}>{approval.agentName}</Link>
          <h3>{approval.title}</h3>
        </div>
        <ApprovalDecisionControls approvalId={approval.id} initialStatus={approval.status} />
      </div>
      <p>{approval.description}</p>
      <dl className="approval-metadata">
        <div>
          <dt>Requested</dt>
          <dd>{approval.requestedBy}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time dateTime={approval.createdAt}>{approval.createdAt}</time>
          </dd>
        </div>
        {approval.expiresAt ? (
          <div>
            <dt>Expires</dt>
            <dd>
              <time dateTime={approval.expiresAt}>{approval.expiresAt}</time>
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="approval-payload-summary">
        <h4>Payload summary</h4>
        <p>{approval.payloadSummary}</p>
      </div>
    </li>
  );
}

async function loadDashboardAgents(userId: string) {
  try {
    return {
      ok: true as const,
      agents: await listActiveAgentsForUser(userId),
    };
  } catch (error) {
    if (error instanceof AgentListPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadDashboardActivity(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await listLatestAgentActivityForUser({
      db: connection.db,
      userId,
      limit: 8,
    });

    if (!result.ok) {
      return {
        ok: false as const,
      };
    }

    return {
      ok: true as const,
      events: result.page.events,
    };
  } catch {
    return {
      ok: false as const,
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function loadDashboardApprovals(userId: string) {
  try {
    return {
      ok: true as const,
      approvals: await listPendingApprovalsForUser(userId),
    };
  } catch (error) {
    if (error instanceof AgentApprovalPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadDashboardProcessLogs(
  userId: string,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return {
      ok: true as const,
      logs: await listLatestActiveAgentProcessLogsForUser({
        db: connection.db,
        userId,
        limit: 8,
      }),
    };
  } catch {
    return {
      ok: false as const,
    };
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

async function loadDashboardManualRunners(userId: string) {
  try {
    return {
      ok: true as const,
      runners: await listManualRunnerStatusSummariesForUser(userId),
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

async function loadDashboardCloudRunners(userId: string) {
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

async function loadDashboardCosts(userId: string): Promise<DashboardCostResult> {
  try {
    return {
      ok: true,
      estimates: await getCostEstimatesForUser(userId),
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
