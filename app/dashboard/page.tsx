import Link from "next/link";
import { ActivityFeedPanel } from "@/app/_components/activity-feed";
import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import {
  AgentListPersistenceError,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listLatestAgentActivity } from "@/src/server/events/agent-events";

type DashboardContentProps = {
  routeLabel?: string;
};

type DashboardAgentResult = Awaited<ReturnType<typeof loadDashboardAgents>>;
type DashboardActivityResult = Awaited<ReturnType<typeof loadDashboardActivity>>;

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const listResult = await loadDashboardAgents();
  const activityResult = await loadDashboardActivity();

  return <DashboardContent activityResult={activityResult} listResult={listResult} />;
}

export function DashboardContent({
  activityResult = { ok: true, events: [] },
  routeLabel = "Dashboard",
  listResult = { ok: true, agents: [] },
}: DashboardContentProps & {
  activityResult?: DashboardActivityResult;
  listResult?: DashboardAgentResult;
}) {
  return (
    <ProductShell
      active="dashboard"
      eyebrow={routeLabel}
      title="Operational dashboard"
      description="A control surface for persisted agent records with deterministic fake lifecycle status and without real runner processes or approvals."
    >
      <div className="content-grid">
        <section className="agent-list-panel" aria-labelledby="dashboard-agents-title">
          <div className="section-heading">
            <h2 id="dashboard-agents-title">Persisted agents</h2>
            {listResult.ok ? <span>{listResult.agents.length} active</span> : null}
          </div>
          {listResult.ok ? (
            listResult.agents.length > 0 ? (
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
                          <AgentLifecycleControls agentId={agent.id} status={agent.status} />
                        </td>
                        <td>
                          <time dateTime={agent.createdAt}>{agent.createdAt}</time>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
            <li>Start, Stop, Restart, and Delete use deterministic fake lifecycle controls.</li>
            <li>Approvals, logs, config editing, and runner work wait for later milestones.</li>
            <li>Runner provisioning and external integrations are placeholders only.</li>
          </ul>
        </PlaceholderPanel>
      </div>
    </ProductShell>
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
