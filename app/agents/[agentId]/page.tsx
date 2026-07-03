import { notFound } from "next/navigation";
import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import {
  AgentDetailPersistenceError,
  getActiveAgentForDevelopmentUser,
} from "@/src/server/agents/list-agents";

type AgentDetailPageProps = {
  params: Promise<{
    agentId: string;
  }>;
};

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: AgentDetailPageProps) {
  const { agentId } = await params;
  const decodedAgentId = decodeURIComponent(agentId);
  const loadResult = await loadAgentDetail(decodedAgentId);

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

  return (
    <ProductShell
      active="agents"
      eyebrow="Agent detail"
      title={agent.name}
      description="This Milestone 1 detail view reads a persisted active agent record without lifecycle controls, logs, approvals, or runner state."
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
              <dt>Template</dt>
              <dd>
                {agent.templateLabel} <code>{agent.templateKey}</code>
              </dd>
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
                <dd>{agent.statusReason}</dd>
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
      </div>
    </ProductShell>
  );
}

async function loadAgentDetail(agentId: string) {
  try {
    return {
      ok: true as const,
      agent: await getActiveAgentForDevelopmentUser(agentId),
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
