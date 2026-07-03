import Link from "next/link";
import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { CreateAgentForm } from "@/app/agents/_components/create-agent-form";
import {
  AGENT_NAME_MAX_LENGTH,
  SUPPORTED_AGENT_TEMPLATE_KEYS,
} from "@/src/server/agents/create-agent";
import {
  AgentListPersistenceError,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const listResult = await loadAgents();

  return (
    <ProductShell
      active="agents"
      eyebrow="Agents"
      title="Agent inventory"
      description="Create persistent Milestone 1 agent records and confirm they remain visible after refresh."
    >
      <div className="content-grid">
        <section className="agent-list-panel" aria-labelledby="agent-list-title">
          <div className="section-heading">
            <h2 id="agent-list-title">Agents</h2>
            {listResult.ok ? <span>{listResult.agents.length} persisted</span> : null}
          </div>
          {listResult.ok ? (
            listResult.agents.length > 0 ? (
              <div className="agent-table-wrap">
                <table className="agent-table">
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Template</th>
                      <th scope="col">Status</th>
                      <th scope="col">Identity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listResult.agents.map((agent) => (
                      <tr key={agent.id}>
                        <td>
                          <Link href={agent.href}>{agent.name}</Link>
                        </td>
                        <td>{agent.templateKey}</td>
                        <td>
                          <span className="status-pill">{agent.status}</span>
                        </td>
                        <td>
                          <code>{agent.id}</code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyState
                title="No agent records"
                description="Create an agent to store a stopped persistent record in the database."
              />
            )
          ) : (
            <div className="safe-error" role="alert">
              Agent records could not be loaded.
            </div>
          )}
        </section>
        <PlaceholderPanel title="Create agent">
          <CreateAgentForm
            maxNameLength={AGENT_NAME_MAX_LENGTH}
            templateKeys={[...SUPPORTED_AGENT_TEMPLATE_KEYS]}
          />
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}

async function loadAgents() {
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
