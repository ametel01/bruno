import Link from "next/link";
import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import {
  AgentListPersistenceError,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";

type DashboardContentProps = {
  routeLabel?: string;
};

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const listResult = await loadDashboardAgents();

  return <DashboardContent listResult={listResult} />;
}

export function DashboardContent({
  routeLabel = "Dashboard",
  listResult = { ok: true, agents: [] },
}: DashboardContentProps & {
  listResult?: Awaited<ReturnType<typeof loadDashboardAgents>>;
}) {
  return (
    <ProductShell
      active="dashboard"
      eyebrow={routeLabel}
      title="Operational dashboard"
      description="A Milestone 1 read surface for persisted agent records without lifecycle actions, runner state, logs, or approvals."
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
        <PlaceholderPanel title="Readiness">
          <dl className="definition-list">
            <div>
              <dt>Product routes</dt>
              <dd>Dashboard, agents, settings, and health skeletons are present.</dd>
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
            <li>Lifecycle controls wait for the next milestone.</li>
            <li>Approvals, logs, and activity feeds wait for later milestones.</li>
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
