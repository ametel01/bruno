import Link from "next/link";
import type { AgentEventDto } from "@/src/server/events/agent-events";

type ActivityFeedContext =
  | {
      kind: "dashboard";
    }
  | {
      kind: "detail";
      agentLabel: string;
    };

type ActivityFeedPanelProps = {
  title: string;
  titleId: string;
  events?: AgentEventDto[];
  countLabel?: string;
  context: ActivityFeedContext;
  emptyTitle: string;
  emptyDescription: string;
  errorMessage: string;
  hasError?: boolean;
  newerHref?: string | undefined;
  olderHref?: string | undefined;
};

type ActivityAgentContext = {
  label: string;
  href?: string | undefined;
  deleted: boolean;
};

export function ActivityFeedPanel({
  title,
  titleId,
  events = [],
  countLabel,
  context,
  emptyTitle,
  emptyDescription,
  errorMessage,
  hasError = false,
  newerHref,
  olderHref,
}: ActivityFeedPanelProps) {
  return (
    <section className="activity-feed-panel" aria-labelledby={titleId}>
      <div className="section-heading">
        <h2 id={titleId}>{title}</h2>
        {!hasError ? <span>{countLabel ?? `${events.length} shown`}</span> : null}
      </div>
      {hasError ? (
        <div className="safe-error" role="alert">
          {errorMessage}
        </div>
      ) : events.length > 0 ? (
        <>
          <ol className="activity-feed">
            {events.map((event) => (
              <ActivityFeedItem context={context} event={event} key={event.id} />
            ))}
          </ol>
          {newerHref || olderHref ? (
            <nav className="activity-pagination" aria-label="Activity pagination">
              {newerHref ? (
                <Link className="secondary-button" href={newerHref}>
                  Newest activity
                </Link>
              ) : null}
              {olderHref ? (
                <Link className="secondary-button" href={olderHref}>
                  Older activity
                </Link>
              ) : null}
            </nav>
          ) : null}
        </>
      ) : (
        <div className="activity-empty-state">
          <h3>{emptyTitle}</h3>
          <p>{emptyDescription}</p>
          {newerHref ? (
            <Link className="secondary-button" href={newerHref}>
              Newest activity
            </Link>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ActivityFeedItem({
  event,
  context,
}: {
  event: AgentEventDto;
  context: ActivityFeedContext;
}) {
  const agentContext = getActivityAgentContext(event, context);

  return (
    <li className="activity-feed-item">
      <div className="activity-feed-header">
        <div className="activity-agent-context">
          {agentContext.href ? <Link href={agentContext.href}>{agentContext.label}</Link> : null}
          {agentContext.href ? null : <span>{agentContext.label}</span>}
          {agentContext.deleted ? <span className="deleted-agent-pill">Deleted agent</span> : null}
        </div>
        <time dateTime={event.createdAt}>{event.createdAt}</time>
      </div>
      <p className="activity-message">{event.message}</p>
      <dl className="activity-metadata">
        <div>
          <dt>Type</dt>
          <dd>
            <code>{event.type}</code>
          </dd>
        </div>
        <div>
          <dt>Actor</dt>
          <dd>{event.actor.displayName}</dd>
        </div>
        {context.kind === "dashboard" && event.agent ? (
          <div>
            <dt>Agent</dt>
            <dd>
              {event.agent.templateKey} / {event.agent.status}
            </dd>
          </div>
        ) : null}
        {event.metadataSummary ? (
          <div>
            <dt>Metadata</dt>
            <dd>{event.metadataSummary}</dd>
          </div>
        ) : null}
      </dl>
    </li>
  );
}

function getActivityAgentContext(
  event: AgentEventDto,
  context: ActivityFeedContext,
): ActivityAgentContext {
  if (context.kind === "detail") {
    return {
      label: context.agentLabel,
      deleted: false,
    };
  }

  const agent = event.agent;
  const agentDeleted = Boolean(agent?.deletedAt);
  const agentLabel = agent?.name ?? event.agentId;

  if (agent && !agentDeleted) {
    return {
      label: agentLabel,
      href: `/agents/${agent.id}`,
      deleted: false,
    };
  }

  return {
    label: agentLabel,
    deleted: agentDeleted,
  };
}
