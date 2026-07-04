import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityFeedPanel } from "@/app/_components/activity-feed";
import { ApprovalDecisionControls } from "@/app/_components/approval-decision-controls";
import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";
import { AgentConfigEditor } from "@/app/agents/_components/agent-config-editor";
import { AgentLifecycleControls } from "@/app/agents/_components/agent-lifecycle-controls";
import { AgentRuntimeLogPanel } from "@/app/agents/_components/agent-runtime-log-panel";
import { AGENT_NAME_MAX_LENGTH } from "@/src/server/agents/create-agent";
import {
  AgentDetailPersistenceError,
  getActiveAgentForDevelopmentUser,
} from "@/src/server/agents/list-agents";
import {
  AgentApprovalPersistenceError,
  listPendingApprovalsForDevelopmentUserAgent,
  type PendingApprovalDto,
} from "@/src/server/approvals/agent-approvals";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { listAgentEventFeed } from "@/src/server/events/agent-events";

type AgentDetailPageProps = {
  params: Promise<{
    agentId: string;
  }>;
  searchParams?: Promise<{
    activityCursor?: string | string[];
  }>;
};

type AgentApprovalsResult = Awaited<ReturnType<typeof loadAgentApprovals>>;

export const dynamic = "force-dynamic";

const DETAIL_ACTIVITY_PAGE_SIZE = 10;

export default async function AgentDetailPage({ params, searchParams }: AgentDetailPageProps) {
  const { agentId } = await params;
  const resolvedSearchParams = await searchParams;
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

  const activityCursor = parseActivityCursor(resolvedSearchParams?.activityCursor);
  const activityResult =
    activityCursor === false
      ? {
          ok: false as const,
        }
      : await loadAgentActivity(agent.id, activityCursor);
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
  const approvalsResult = await loadAgentApprovals(agent.id);

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
                <AgentLifecycleControls agentId={agent.id} status={agent.status} />
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

async function loadAgentActivity(
  agentId: string,
  cursor: string | null,
  dependencies: { createConnection?: () => DatabaseConnection } = {},
) {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const result = await listAgentEventFeed({
      db: connection.db,
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

async function loadAgentApprovals(agentId: string) {
  try {
    return {
      ok: true as const,
      approvals: await listPendingApprovalsForDevelopmentUserAgent(agentId),
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

function parseActivityCursor(cursor: string | string[] | undefined): string | null | false {
  if (cursor === undefined) {
    return null;
  }

  if (Array.isArray(cursor)) {
    return false;
  }

  return cursor;
}
