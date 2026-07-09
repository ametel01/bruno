import Link from "next/link";
import { ActivityFeedPanel } from "@/app/_components/activity-feed";
import { ApprovalDecisionControls } from "@/app/_components/approval-decision-controls";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { RunnerCapacityDefinitionItems } from "@/app/_components/runner-capacity-details";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "@/app/agents/_components/agent-start-readiness";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import {
  AgentListPersistenceError,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";
import {
  AgentApprovalPersistenceError,
  listPendingApprovalsForDevelopmentUser,
  type PendingApprovalDto,
} from "@/src/server/approvals/agent-approvals";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listLatestAgentActivity } from "@/src/server/events/agent-events";
import {
  listLatestActiveAgentProcessLogs,
  type LatestAgentProcessLogDto,
} from "@/src/server/logs/agent-logs";
import {
  listManualRunnerStatusSummariesForDevelopmentUser,
  ManualRunnerStatusPersistenceError,
  type ManualRunnerStatusSummary,
} from "@/src/server/runners/manual-runner-status";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForDevelopmentUser,
} from "@/src/server/runners/cloud-runner-provisioning";

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
  const listResult = await loadDashboardAgents();
  const activityResult = await loadDashboardActivity();
  const approvalsResult = await loadDashboardApprovals();
  const processLogsResult = await loadDashboardProcessLogs();
  const manualRunnersResult = await loadDashboardManualRunners();
  const cloudRunnersResult = await loadDashboardCloudRunners();

  return (
    <DashboardContent
      activityResult={activityResult}
      approvalsResult={approvalsResult}
      cloudRunnersResult={cloudRunnersResult}
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
  manualRunnersResult = { ok: true, runners: [] },
  processLogsResult = { ok: true, logs: [] },
  routeLabel = "Dashboard",
  listResult = { ok: true, agents: [] },
}: DashboardContentProps & {
  activityResult?: DashboardActivityResult;
  approvalsResult?: DashboardApprovalsResult;
  cloudRunnersResult?: DashboardCloudRunnersResult;
  manualRunnersResult?: DashboardManualRunnersResult;
  processLogsResult?: DashboardProcessLogsResult;
  listResult?: DashboardAgentResult;
}) {
  return (
    <ProductShell
      active="dashboard"
      eyebrow={routeLabel}
      title="Operational dashboard"
      description="A control surface for persisted agent records, pending approval requests, local runner lifecycle status, and local development activity."
    >
      <div className="content-grid">
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
                            <span className="status-pill">{agent.status}</span>
                          </td>
                          <td>
                            <AgentLifecycleControls
                              agentId={agent.id}
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
        <PendingApprovalsPanel result={approvalsResult} />
        <DashboardManualRunnerPanel result={manualRunnersResult} />
        <CloudRunnerProvisioningPanel
          result={cloudRunnersResult}
          title="Cloud provisioning"
          titleId="dashboard-cloud-runner-title"
        />
        <DashboardProcessLogsPanel result={processLogsResult} />
        <PlaceholderPanel title="Readiness">
          <dl className="definition-list">
            <div>
              <dt>Product routes</dt>
              <dd>Dashboard, agents, settings, and health routes are present.</dd>
            </div>
            <div>
              <dt>Database check</dt>
              <dd>The `/health` endpoint remains the operator source for database reachability.</dd>
            </div>
            <div>
              <dt>Agent data</dt>
              <dd>Active persisted records are read from the database.</dd>
            </div>
          </dl>
        </PlaceholderPanel>
        <PlaceholderPanel title="Upcoming surfaces">
          <ul className="plain-list">
            <li>Start, Stop, and Restart use the Docker runner adapter and existing controls.</li>
            <li>
              Full per-agent log streams and local-development config editing are present on agent
              detail pages.
            </li>
            <li>Cloud runner provisioning status is visible from persisted runner records.</li>
            <li>
              Approval decisions are available from the queue; production runners, billing, and
              secret storage wait for later milestones.
            </li>
          </ul>
        </PlaceholderPanel>
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

async function loadDashboardAgents() {
  try {
    return {
      ok: true as const,
      agents: await listActiveAgentsForDevelopmentUser(),
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
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await listLatestAgentActivity({
      db: connection.db,
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

async function loadDashboardApprovals() {
  try {
    return {
      ok: true as const,
      approvals: await listPendingApprovalsForDevelopmentUser(),
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
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return {
      ok: true as const,
      logs: await listLatestActiveAgentProcessLogs({
        db: connection.db,
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

async function loadDashboardManualRunners() {
  try {
    return {
      ok: true as const,
      runners: await listManualRunnerStatusSummariesForDevelopmentUser(),
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

async function loadDashboardCloudRunners() {
  try {
    return {
      ok: true as const,
      runners: await listCloudRunnerProvisioningSummariesForDevelopmentUser(),
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
