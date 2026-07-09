import Link from "next/link";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "@/app/agents/_components/agent-start-readiness";
import { CreateAgentForm } from "@/app/agents/_components/create-agent-form";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import { AGENT_TEMPLATE_OPTIONS } from "@/src/server/agents/templates";
import {
  AgentListPersistenceError,
  listActiveAgentsForDevelopmentUser,
} from "@/src/server/agents/list-agents";
import {
  listAssignableRunnersForDevelopmentUser,
  RunnerAssignmentPersistenceError,
} from "@/src/server/runners/runner-assignment";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForDevelopmentUser,
} from "@/src/server/runners/cloud-runner-provisioning";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const listResult = await loadAgents();
  const runnerResult = await loadAssignableRunners();
  const cloudRunnersResult = await loadCloudRunnerProvisioning();

  return (
    <ProductShell
      active="agents"
      eyebrow="Agents"
      title="Agent inventory"
      description="Create persistent agents, exercise local runner lifecycle controls, and confirm active records remain visible after refresh."
    >
      <div className="content-grid">
        <section className="agent-list-panel" aria-labelledby="agent-list-title">
          <div className="section-heading">
            <h2 id="agent-list-title">Agents</h2>
            {listResult.ok ? <span>{listResult.agents.length} persisted</span> : null}
          </div>
          {listResult.ok ? (
            listResult.agents.length > 0 ? (
              <>
                <div className="agent-table-wrap">
                  <table className="agent-table">
                    <thead>
                      <tr>
                        <th scope="col">Name</th>
                        <th scope="col">Template</th>
                        <th scope="col">Status</th>
                        <th scope="col">Action</th>
                        <th scope="col">Config</th>
                        <th scope="col">Identity</th>
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
                            <Link
                              className="secondary-button agent-config-link"
                              href={`${agent.href}#configuration-title`}
                            >
                              Configure
                            </Link>
                          </td>
                          <td>
                            <code>{agent.id}</code>
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
                description="Create an agent to store a stopped persistent record in the database."
              />
            )
          ) : (
            <div className="safe-error" role="alert">
              Agent records could not be loaded.
            </div>
          )}
        </section>
        <div className="create-agent-stack">
          <PlaceholderPanel title="Create agent">
            <CreateAgentForm
              maxNameLength={AGENT_NAME_MAX_LENGTH}
              runners={runnerResult.ok ? runnerResult.runners : []}
              templates={AGENT_TEMPLATE_OPTIONS}
            />
          </PlaceholderPanel>
          <CloudRunnerProvisioningPanel
            result={cloudRunnersResult}
            title="Cloud setup status"
            titleId="agents-cloud-runner-title"
          />
        </div>
      </div>
    </ProductShell>
  );
}

async function loadAssignableRunners() {
  try {
    return {
      ok: true as const,
      runners: await listAssignableRunnersForDevelopmentUser(),
    };
  } catch (error) {
    if (error instanceof RunnerAssignmentPersistenceError) {
      return {
        ok: false as const,
      };
    }

    throw error;
  }
}

async function loadCloudRunnerProvisioning() {
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
