import Link from "next/link";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { EmptyState, ProductShell } from "@/app/_components/product-shell";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "@/app/agents/_components/agent-start-readiness";
import { CreateAgentForm } from "@/app/agents/_components/create-agent-form";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import { AGENT_TEMPLATE_OPTIONS } from "@/src/server/agents/templates";
import {
  AgentListPersistenceError,
  listActiveAgentsForUser,
} from "@/src/server/agents/list-agents";
import {
  listAssignableRunnersForUser,
  RunnerAssignmentPersistenceError,
} from "@/src/server/runners/runner-assignment";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForUser,
} from "@/src/server/runners/cloud-runner-provisioning";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const applicationUser = await requireConfiguredApplicationUser();

  if (!applicationUser.ok) {
    return (
      <ProductShell
        active="agents"
        eyebrow="Agents"
        title="Authentication required"
        description="Sign in to load user-scoped agent data."
      >
        <div className="safe-error" role="alert">
          Authentication is required.
        </div>
      </ProductShell>
    );
  }

  const [listResult, runnerResult, cloudRunnersResult] = await Promise.all([
    loadAgents(applicationUser.userId),
    loadAssignableRunners(applicationUser.userId),
    loadCloudRunnerProvisioning(applicationUser.userId),
  ]);
  const agentCount = listResult.ok ? listResult.agents.length : null;
  const assignableRunnerCount = runnerResult.ok ? runnerResult.runners.length : null;
  const cloudRunnerCount = cloudRunnersResult.ok ? cloudRunnersResult.runners.length : null;
  const readyCloudRunnerCount = cloudRunnersResult.ok
    ? cloudRunnersResult.runners.filter((runner) => runner.readinessStatus === "online").length
    : null;

  return (
    <ProductShell
      active="agents"
      eyebrow="Agents"
      title="Agent inventory"
      description="Create persistent agents, choose their operating template, and manage active records from one workspace."
    >
      <div className="agents-page">
        <section className="agents-workspace-overview" aria-labelledby="agents-workspace-title">
          <div className="agents-workspace-heading">
            <div>
              <p>Creation readiness</p>
              <h2 id="agents-workspace-title">Agent workspace</h2>
            </div>
            <span>Persisted state</span>
          </div>
          <dl>
            <div data-state={agentCount !== null && agentCount > 0 ? "active" : "neutral"}>
              <dt>Agents</dt>
              <dd>
                <strong>{agentCount ?? "—"}</strong>
                <span>persisted records</span>
              </dd>
            </div>
            <div data-state="active">
              <dt>Templates</dt>
              <dd>
                <strong>{AGENT_TEMPLATE_OPTIONS.length}</strong>
                <span>available profiles</span>
              </dd>
            </div>
            <div
              data-state={
                assignableRunnerCount !== null && assignableRunnerCount > 0 ? "clear" : "neutral"
              }
            >
              <dt>Assignable runners</dt>
              <dd>
                <strong>{assignableRunnerCount ?? "—"}</strong>
                <span>online now</span>
              </dd>
            </div>
            <div
              data-state={
                cloudRunnerCount !== null && cloudRunnerCount > 0 && readyCloudRunnerCount === 0
                  ? "attention"
                  : "clear"
              }
            >
              <dt>Cloud ready</dt>
              <dd>
                <strong>
                  {readyCloudRunnerCount ?? "—"}/{cloudRunnerCount ?? "—"}
                </strong>
                <span>online and tracked</span>
              </dd>
            </div>
          </dl>
        </section>

        <section className="agent-list-panel" aria-labelledby="agent-list-title">
          <div className="section-heading">
            <h2 id="agent-list-title">Existing agents</h2>
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

        <section className="agent-creation-panel" aria-labelledby="create-agent-title">
          <div className="agent-creation-heading">
            <div>
              <p>New persistent record</p>
              <h2 id="create-agent-title">Create agent</h2>
            </div>
            <span>Choose one template</span>
          </div>
          <div className="agent-creation-body">
            <CreateAgentForm
              maxNameLength={AGENT_NAME_MAX_LENGTH}
              runners={runnerResult.ok ? runnerResult.runners : []}
              templates={AGENT_TEMPLATE_OPTIONS}
            />
          </div>
        </section>

        <details className="agents-cloud-status">
          <summary>
            <span>
              <strong>Cloud setup status</strong>
              <small>Provisioning and runner readiness details</small>
            </span>
            <span>
              {cloudRunnerCount ?? "—"} tracked / {readyCloudRunnerCount ?? "—"} ready
            </span>
          </summary>
          <CloudRunnerProvisioningPanel
            result={cloudRunnersResult}
            title="Cloud setup status"
            titleId="agents-cloud-runner-title"
          />
        </details>
      </div>
    </ProductShell>
  );
}

async function loadAssignableRunners(userId: string) {
  try {
    return {
      ok: true as const,
      runners: await listAssignableRunnersForUser(userId),
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

async function loadCloudRunnerProvisioning(userId: string) {
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

async function loadAgents(userId: string) {
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
