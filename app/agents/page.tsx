import Link from "next/link";
import { CloudRunnerProvisioningPanel } from "@/app/_components/cloud-runner-provisioning-panel";
import { EmptyState, ProductShell } from "@/app/_components/product-shell";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { listedAgentStartDisabledReason } from "@/app/agents/_components/agent-start-readiness";
import { CreateAgentForm } from "@/app/agents/_components/create-agent-form";
import { DeploymentStatusLabel } from "@/app/agents/_components/deployment-status-label";
import { MobileAgentList } from "@/app/agents/_components/mobile-agent-list";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import {
  AgentListPersistenceError,
  listActiveAgentsForUser,
} from "@/src/server/agents/list-agents";
import {
  listModelConnectionsForUser,
  ModelConnectionPersistenceError,
} from "@/src/server/agents/model-connections";
import { AGENT_TEMPLATE_OPTIONS } from "@/src/server/agents/templates";
import { readReadyAgentCreationFlag } from "@/src/server/env";
import {
  CloudRunnerProvisioningPersistenceError,
  listCloudRunnerProvisioningSummariesForUser,
} from "@/src/server/runners/cloud-runner-provisioning";
import {
  listAssignableRunnersForUser,
  RunnerAssignmentPersistenceError,
} from "@/src/server/runners/runner-assignment";
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

  const [listResult, runnerResult, cloudRunnersResult, modelConnectionResult] = await Promise.all([
    loadAgents(applicationUser.userId),
    loadAssignableRunners(applicationUser.userId),
    loadCloudRunnerProvisioning(applicationUser.userId),
    loadModelConnections(applicationUser.userId),
  ]);
  const agentCount = listResult.ok ? listResult.agents.length : null;
  const assignableRunnerCount = runnerResult.ok ? runnerResult.runners.length : null;
  const cloudRunnerCount = cloudRunnersResult.ok ? cloudRunnersResult.runners.length : null;
  const readyCloudRunnerCount = cloudRunnersResult.ok
    ? cloudRunnersResult.runners.filter((runner) => runner.readinessStatus === "online").length
    : null;
  const automaticRecoveryCount = listResult.ok
    ? listResult.agents.filter(
        (agent) => agent.latestDeployment?.recovery?.state === "preparing_capacity",
      ).length
    : 0;
  const readyFlag = readReadyAgentCreationFlag();
  const readyModeEnabled = readyFlag.ok && readyFlag.enabled;

  return (
    <ProductShell
      active="agents"
      eyebrow="Agents"
      title="Your AI agents"
      description="Choose ChatGPT or Claude. We securely configure, launch, and monitor the agent for you."
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
                automaticRecoveryCount > 0
                  ? "active"
                  : cloudRunnerCount !== null && cloudRunnerCount > 0 && readyCloudRunnerCount === 0
                    ? "attention"
                    : "clear"
              }
            >
              <dt>{automaticRecoveryCount > 0 ? "Recovery" : "Cloud ready"}</dt>
              {automaticRecoveryCount > 0 ? (
                <dd>
                  <strong>{automaticRecoveryCount}</strong>
                  <span>preparing replacement capacity</span>
                </dd>
              ) : (
                <dd>
                  <strong>
                    {readyCloudRunnerCount ?? "—"}/{cloudRunnerCount ?? "—"}
                  </strong>
                  <span>online and tracked</span>
                </dd>
              )}
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
                title="No agents yet"
                description="Create your first agent below. Setup usually takes only a few minutes."
                action={{ href: "#create-agent-title", label: "Create your first agent" }}
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
              <p>Guided setup</p>
              <h2 id="create-agent-title">Create a new agent</h2>
            </div>
            <span>We handle the technical setup</span>
          </div>
          <div className="agent-creation-body">
            <CreateAgentForm
              maxNameLength={AGENT_NAME_MAX_LENGTH}
              modelConnections={modelConnectionResult.ok ? modelConnectionResult.connections : []}
              readyModeEnabled={readyModeEnabled && modelConnectionResult.ok}
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

async function loadModelConnections(userId: string) {
  try {
    return {
      ok: true as const,
      connections: await listModelConnectionsForUser(userId),
    };
  } catch (error) {
    if (error instanceof ModelConnectionPersistenceError) {
      return { ok: false as const };
    }

    throw error;
  }
}
