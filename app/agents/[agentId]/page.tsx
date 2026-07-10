import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityFeedPanel } from "@/app/_components/activity-feed";
import { ApprovalDecisionControls } from "@/app/_components/approval-decision-controls";
import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { AgentBackupControls } from "@/app/agents/_components/agent-backup-controls";
import { AgentConfigEditor } from "@/app/agents/_components/agent-config-editor";
import { AssignedRunnerPanel } from "@/app/agents/_components/assigned-runner-panel";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { AgentRuntimeLogPanel } from "@/app/agents/_components/agent-runtime-log-panel";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import {
  buildAgentOperationalAlerts,
  type OperationalAlert,
  summarizeOperationalText,
} from "@/src/server/alerts/operational-summaries";
import {
  AgentDetailPersistenceError,
  getActiveAgentForUser,
} from "@/src/server/agents/list-agents";
import {
  AgentApprovalPersistenceError,
  listPendingApprovalsForUserAgent,
  type PendingApprovalDto,
} from "@/src/server/approvals/agent-approvals";
import {
  AgentBackupListPersistenceError,
  listAgentBackupsForUser,
} from "@/src/server/backups/list-backups";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listAgentEventFeedForUser } from "@/src/server/events/agent-events";
import {
  getMonthlyRunnerCostForUserAgent,
  RunnerCostContextPersistenceError,
} from "@/src/server/costs/runner-cost-context";
import {
  getAssignedManualRunnerStatusForUserAgent,
  ManualRunnerStatusPersistenceError,
  type AssignedManualRunnerStatusSummary,
} from "@/src/server/runners/manual-runner-status";
import { requireOperationalApplicationUser } from "@/src/server/users/operational-application-user";

type AgentDetailPageProps = {
  params: Promise<{
    agentId: string;
  }>;
  searchParams?: Promise<{
    activityCursor?: string | string[];
  }>;
};

type AgentApprovalsResult = Awaited<ReturnType<typeof loadAgentApprovals>>;
type AgentBackupsResult = Awaited<ReturnType<typeof loadAgentBackups>>;

export const dynamic = "force-dynamic";

const DETAIL_ACTIVITY_PAGE_SIZE = 10;

export default async function AgentDetailPage({ params, searchParams }: AgentDetailPageProps) {
  const { agentId } = await params;
  const resolvedSearchParams = await searchParams;
  const decodedAgentId = decodeURIComponent(agentId);
  const applicationUser = await requireOperationalApplicationUser();

  if (!applicationUser.ok) {
    return (
      <ProductShell
        active="agents"
        eyebrow="Agent detail"
        title="Authentication required"
        description="Sign in to load user-scoped operational data."
      >
        <div className="safe-error" role="alert">
          Authentication is required.
        </div>
      </ProductShell>
    );
  }

  const loadResult = await loadAgentDetail(applicationUser.userId, decodedAgentId);

  if (!loadResult.ok) {
    return (
      <ProductShell
        active="agents"
        eyebrow="Agent detail"
        title="Agent unavailable"
        description="The requested persisted agent record could not be loaded."
      >
        <div className="safe-error" role="alert">
          Agent record could not be loaded.
        </div>
      </ProductShell>
    );
  }

  const agent = loadResult.agent;

  if (!agent) {
    return notFound();
  }

  const activityCursor = parseActivityCursor(resolvedSearchParams?.activityCursor);
  const activityPromise =
    activityCursor === false
      ? Promise.resolve({
          ok: false as const,
        })
      : loadAgentActivity(applicationUser.userId, agent.id, activityCursor);
  const [
    activityResult,
    approvalsResult,
    backupsResult,
    assignedRunnerResult,
    assignedRunnerCostResult,
  ] = await Promise.all([
    activityPromise,
    loadAgentApprovals(applicationUser.userId, agent.id),
    loadAgentBackups(applicationUser.userId, agent.id),
    loadAssignedManualRunner(applicationUser.userId, agent.id),
    loadAssignedRunnerCost(applicationUser.userId, agent.id),
  ]);
  const activityEvents = activityResult.ok ? activityResult.events : [];
  const olderActivityHref =
    activityResult.ok && activityResult.nextCursor
      ? `${agent.href}?activityCursor=${encodeURIComponent(activityResult.nextCursor)}`
      : undefined;
  const newestActivityHref = activityCursor ? agent.href : undefined;
  const emptyActivityTitle = activityCursor ? "No older activity" : "No activity yet";
  const emptyActivityDescription = activityCursor
    ? "There are no older persisted events for this agent."
    : "Create or update this agent to show persisted activity here.";
  const assignedRunner = assignedRunnerResult.ok ? assignedRunnerResult.runner : null;
  const operationalAlerts = buildAgentOperationalAlerts({
    agent,
    approvals: approvalsResult.ok ? approvalsResult.approvals : [],
    events: activityEvents,
    runnerState:
      assignedRunner?.alertState === null
        ? {
            status: "online",
            message: null,
            updatedAt: assignedRunner.lastSeenAt ?? assignedRunner.updatedAt,
          }
        : assignedRunner?.alertState
          ? {
              status: assignedRunner.alertState,
              message: assignedRunner.alertMessage,
              updatedAt: assignedRunner.lastSeenAt ?? assignedRunner.updatedAt,
            }
          : null,
  });

  return (
    <ProductShell
      active="agents"
      eyebrow="Agent detail"
      title={agent.name}
      description="This detail view reads the current persisted lifecycle status, editable local-development config, scoped runtime logs, and audit activity for an active agent."
    >
      <div className="content-grid">
        <PlaceholderPanel title="Agent record">
          <dl className="definition-list">
            <div>
              <dt>Status</dt>
              <dd>
                <span className="status-pill">{agent.status}</span>
              </dd>
            </div>
            <div>
              <dt>Actions</dt>
              <dd>
                <AgentLifecycleControls
                  agentId={agent.id}
                  startDisabledReason={startDisabledReason(assignedRunner)}
                  status={agent.status}
                />
              </dd>
            </div>
            <div>
              <dt>Template</dt>
              <dd>
                {agent.templateSnapshot.name} <code>{agent.templateKey}</code>
              </dd>
            </div>
            <div>
              <dt>Template version</dt>
              <dd>{agent.templateVersion}</dd>
            </div>
            <div>
              <dt>Created</dt>
              <dd>
                <time dateTime={agent.createdAt}>{agent.createdAt}</time>
              </dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>
                <time dateTime={agent.updatedAt}>{agent.updatedAt}</time>
              </dd>
            </div>
            {agent.statusReason ? (
              <div>
                <dt>Status reason</dt>
                <dd>
                  {summarizeOperationalText(agent.statusReason, "Status reason unavailable.")}
                </dd>
              </div>
            ) : null}
          </dl>
        </PlaceholderPanel>
        <PlaceholderPanel title="Identity">
          <dl className="definition-list">
            <div>
              <dt>Agent ID</dt>
              <dd>
                <code>{agent.id}</code>
              </dd>
            </div>
          </dl>
        </PlaceholderPanel>
        <PlaceholderPanel title="Template settings">
          <dl className="definition-list">
            <div>
              <dt>Description</dt>
              <dd>{agent.templateSnapshot.description}</dd>
            </div>
            <div>
              <dt>Default tools</dt>
              <dd>{agent.templateSnapshot.defaultTools.join(", ")}</dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>{agent.templateSnapshot.defaultSchedule}</dd>
            </div>
            <div>
              <dt>Required integrations</dt>
              <dd>
                {agent.templateSnapshot.requiredIntegrations.length > 0
                  ? agent.templateSnapshot.requiredIntegrations.join(", ")
                  : "None"}
              </dd>
            </div>
            <div>
              <dt>Default prompt</dt>
              <dd className="template-default-prompt">
                <p>{agent.templateSnapshot.defaultSystemPrompt}</p>
              </dd>
            </div>
          </dl>
        </PlaceholderPanel>
        <PlaceholderPanel title="Configuration">
          <AgentConfigEditor
            agentId={agent.id}
            maxNameLength={AGENT_NAME_MAX_LENGTH}
            persisted={{
              name: agent.name,
              config: agent.config,
            }}
          />
        </PlaceholderPanel>
        <AgentBackupsPanel agentId={agent.id} result={backupsResult} />
        <AgentOperationalAlertsPanel
          alerts={operationalAlerts.alerts}
          runnerStateNotice={operationalAlerts.runnerStateNotice}
        />
        <AssignedRunnerPanel costResult={assignedRunnerCostResult} result={assignedRunnerResult} />
        <AgentRuntimeLogPanel agentId={agent.id} status={agent.status} />
        <AgentApprovalsPanel result={approvalsResult} />
        <ActivityFeedPanel
          context={{ kind: "detail", agentLabel: agent.name }}
          countLabel={
            activityCursor
              ? `${activityEvents.length} older shown`
              : `${activityEvents.length} shown`
          }
          emptyDescription={emptyActivityDescription}
          emptyTitle={emptyActivityTitle}
          errorMessage="Agent activity could not be loaded."
          events={activityEvents}
          hasError={!activityResult.ok}
          newerHref={newestActivityHref}
          olderHref={olderActivityHref}
          title="Activity"
          titleId="agent-activity-title"
        />
      </div>
    </ProductShell>
  );
}

function AgentBackupsPanel({ agentId, result }: { agentId: string; result: AgentBackupsResult }) {
  return (
    <section className="backup-panel" aria-labelledby="agent-backups-title">
      <div className="section-heading">
        <h2 id="agent-backups-title">Backups</h2>
        {result.ok ? <span>{result.backups.length} listed</span> : null}
      </div>
      {result.ok ? (
        <AgentBackupControls agentId={agentId} backups={result.backups} />
      ) : (
        <div className="safe-error" role="alert">
          Backup status could not be loaded.
        </div>
      )}
    </section>
  );
}

function AgentOperationalAlertsPanel({
  alerts,
  runnerStateNotice,
}: {
  alerts: OperationalAlert[];
  runnerStateNotice: string | null;
}) {
  return (
    <section className="operational-alert-panel" aria-labelledby="agent-alerts-title">
      <div className="section-heading">
        <h2 id="agent-alerts-title">Operational alerts</h2>
        <span>{alerts.length} active</span>
      </div>
      {alerts.length > 0 ? (
        <ol className="operational-alert-list" aria-label="Operational alerts">
          {alerts.map((alert) => (
            <li className="operational-alert-item" data-severity={alert.severity} key={alert.id}>
              <div className="operational-alert-header">
                <span className="operational-alert-severity">{alert.severity}</span>
                {alert.createdAt ? <time dateTime={alert.createdAt}>{alert.createdAt}</time> : null}
              </div>
              <h3>{alert.title}</h3>
              <p>{alert.message}</p>
              <span className="operational-alert-source">{alert.source}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="activity-empty-state">
          <h3>No active alerts</h3>
          <p>Agent errors, approval blockers, and alert-relevant activity will appear here.</p>
        </div>
      )}
      {runnerStateNotice ? <p className="operational-alert-note">{runnerStateNotice}</p> : null}
    </section>
  );
}

function AgentApprovalsPanel({ result }: { result: AgentApprovalsResult }) {
  return (
    <section className="approval-panel" aria-labelledby="agent-approvals-title">
      <div className="section-heading">
        <h2 id="agent-approvals-title">Pending approvals</h2>
        {result.ok ? <span>{result.approvals.length} pending</span> : null}
      </div>
      {result.ok ? (
        result.approvals.length > 0 ? (
          <ol className="approval-list">
            {result.approvals.map((approval) => (
              <AgentApprovalItem approval={approval} key={approval.id} />
            ))}
          </ol>
        ) : (
          <div className="activity-empty-state">
            <h3>No pending approvals</h3>
            <p>Persisted approval requests for this agent will appear here.</p>
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

function AgentApprovalItem({ approval }: { approval: PendingApprovalDto }) {
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

async function loadAgentDetail(userId: string, agentId: string) {
  try {
    return {
      ok: true as const,
      agent: await getActiveAgentForUser(userId, agentId),
    };
  } catch (error) {
    if (error instanceof AgentDetailPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadAgentActivity(
  userId: string,
  agentId: string,
  cursor: string | null,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await listAgentEventFeedForUser({
      db: connection.db,
      userId,
      agentId,
      cursor,
      limit: DETAIL_ACTIVITY_PAGE_SIZE,
    });

    if (!result.ok) {
      return {
        ok: false as const,
      };
    }

    return {
      ok: true as const,
      events: result.page.events,
      nextCursor: result.page.nextCursor,
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

async function loadAgentApprovals(userId: string, agentId: string) {
  try {
    return {
      ok: true as const,
      approvals: await listPendingApprovalsForUserAgent(userId, agentId),
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

async function loadAgentBackups(userId: string, agentId: string) {
  try {
    return {
      ok: true as const,
      backups: await listAgentBackupsForUser(userId, agentId),
    };
  } catch (error) {
    if (error instanceof AgentBackupListPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadAssignedManualRunner(userId: string, agentId: string) {
  try {
    return {
      ok: true as const,
      runner: await getAssignedManualRunnerStatusForUserAgent(userId, agentId),
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

async function loadAssignedRunnerCost(userId: string, agentId: string) {
  try {
    return {
      ok: true as const,
      estimate: await getMonthlyRunnerCostForUserAgent(userId, agentId),
    };
  } catch (error) {
    if (error instanceof RunnerCostContextPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

function startDisabledReason(runner: AssignedManualRunnerStatusSummary | null): string | null {
  if (!runner) {
    return null;
  }

  if (
    runner.status === "online" &&
    (runner.kind !== "digitalocean" || runner.provisioningStatus === "ready")
  ) {
    return null;
  }

  return "Assigned runner is not fully ready yet.";
}

function parseActivityCursor(cursor: string | string[] | undefined): string | null | false {
  if (cursor === undefined) {
    return null;
  }

  if (Array.isArray(cursor)) {
    return false;
  }

  return cursor;
}
