"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import { PrototypeSwitcher, type PrototypeVariant } from "@/app/_components/prototype-switcher";
import styles from "./founder-operator-prototype.module.css";

// Three variants of the founder command center, switchable via ?variant= on /dashboard.
// HITL VERDICT (2026-08-18): Variant B — Conversation canvas. Conversation leads while the
// Morning Brief and the canonical Proposed Action remain visible in the context pane.
// THESIS: One proposed action stays legible and synchronized across the brief, conversation, and inbox.
// OWN-WORLD: Bruno.Ai's ivory, warm-white, charcoal, espresso, mint, and lime operating system.
// STORY: Orient in the morning, understand one evidence-backed risk, then decide or ask Bruno about it.
// FIRST VIEWPORT: Each variant gives a different surface primacy while keeping the same work and state.
// FORM: Dealt structures 5, 7, and 4; surface seed 4c5073ea.
// FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md

type DecisionState = "pending" | "approved" | "changes" | "declined";

type ConversationItem = {
  id: string;
  author: "Bruno" | "You";
  body: string;
};

const morningItems = [
  {
    title: "A warm lead may go quiet",
    detail: "Maya Chen opened your proposal twice. There has been no reply for 3 days.",
    source: "Gmail · checked 7:58 AM",
    kind: "decision",
  },
  {
    title: "Your 2 PM client meeting is ready",
    detail: "Bruno prepared the agenda from the last email thread and your calendar notes.",
    source: "Calendar + Gmail · checked 7:59 AM",
    kind: "ready",
  },
  {
    title: "The morning is clear for focused work",
    detail: "No conflicts or urgent client replies before noon.",
    source: "Calendar + Gmail · checked 8:00 AM",
    kind: "clear",
  },
] as const;

const proposedAction = {
  recipient: "Maya Chen · maya@northstar.studio",
  subject: "Anything I can clarify about the proposal?",
  body: "Hi Maya, I wanted to check whether anything in the proposal needs clarification. I’m happy to talk through scope or timing if that would help. — Alex",
  evidence: [
    "Proposal sent Friday at 10:14 AM",
    "Opened Friday and Monday",
    "No reply in 3 days",
    "No meeting currently scheduled",
  ],
};

const stateLabels: Record<DecisionState, string> = {
  approved: "Approved — ready to send",
  changes: "Changes requested",
  declined: "Declined — will not send",
  pending: "Waiting for you",
};

export function FounderOperatorPrototype({ initialVariant }: { initialVariant: PrototypeVariant }) {
  const router = useRouter();
  const [variant, setVariant] = useState(initialVariant);
  const [decision, setDecision] = useState<DecisionState>("pending");
  const [draftMessage, setDraftMessage] = useState("");
  const [conversation, setConversation] = useState<ConversationItem[]>([
    { id: "founder-opening", author: "You", body: "Anything at risk today?" },
    {
      id: "bruno-opening",
      author: "Bruno",
      body: "One warm lead may go quiet. I drafted a short follow-up to Maya and held it for your approval. Your 2 PM client meeting is prepared, and the rest of the morning is clear.",
    },
  ]);

  const changeVariant = (next: PrototypeVariant) => {
    setVariant(next);
    router.replace(`/dashboard?variant=${next}`, { scroll: false });
  };

  const updateDecision = (next: DecisionState) => {
    setDecision(next);
    const response: Record<DecisionState, string> = {
      approved:
        "Approved. I’ll send the exact draft shown here and attach a receipt when it is sent.",
      changes:
        "Understood. Tell me what you want changed and I’ll return a revised draft for approval.",
      declined: "Declined. I won’t send this follow-up, and the decision is recorded.",
      pending: "The follow-up is waiting for your decision again.",
    };
    setConversation((items) => [
      ...items,
      { id: crypto.randomUUID(), author: "Bruno", body: response[next] },
    ]);
  };

  const submitMessage = () => {
    const message = draftMessage.trim();
    if (!message) return;
    setConversation((items) => [
      ...items,
      { id: crypto.randomUUID(), author: "You", body: message },
      {
        id: crypto.randomUUID(),
        author: "Bruno",
        body: "I’ve kept your note with this proposed follow-up. In the real product, I would use it to revise the action or answer from the linked evidence.",
      },
    ]);
    setDraftMessage("");
  };

  const shared = {
    conversation,
    decision,
    draftMessage,
    onDecision: updateDecision,
    onDraftMessage: setDraftMessage,
    onSubmitMessage: submitMessage,
  };

  return (
    <main className={styles.prototype} data-variant={variant}>
      {variant === "A" ? <BriefingDesk {...shared} /> : null}
      {variant === "B" ? <ConversationCanvas {...shared} /> : null}
      {variant === "C" ? <DecisionQueue {...shared} /> : null}
      <PrototypeSwitcher current={variant} onChange={changeVariant} />
    </main>
  );
}

type VariantProps = {
  conversation: ConversationItem[];
  decision: DecisionState;
  draftMessage: string;
  onDecision: (state: DecisionState) => void;
  onDraftMessage: (value: string) => void;
  onSubmitMessage: () => void;
};

export function BriefingDesk(props: VariantProps) {
  return (
    <div className={styles.briefingDesk}>
      <SideNavigation active="Now" decision={props.decision} />
      <div className={styles.briefingMain}>
        <PageHeader title="Good morning, Alex." subtitle="Tuesday, August 18 · Updated 8:05 AM" />
        <section className={styles.briefHero} aria-labelledby="brief-a-title">
          <div className={styles.briefHeroIntro}>
            <div>
              <p className={styles.statusLine}>
                <span /> Bruno is up to date
              </p>
              <h1 id="brief-a-title">Three things matter today.</h1>
            </div>
            <p>
              One decision needs you. Everything else is prepared or quiet, so you can start with
              the lead most likely to slip.
            </p>
          </div>
          <MorningRows decision={props.decision} />
        </section>
        <section className={styles.briefAction} aria-labelledby="action-a-title">
          <ActionDetail id="action-a-title" {...props} />
        </section>
      </div>
      <aside className={styles.conversationRail} aria-label="Bruno Conversation">
        <Conversation title="Ask Bruno" compact {...props} />
      </aside>
    </div>
  );
}

export function ConversationCanvas(props: VariantProps) {
  return (
    <div className={styles.conversationCanvas}>
      <header className={styles.canvasHeader}>
        <Brand />
        <nav aria-label="Primary navigation">
          <a href="#conversation-b" aria-current="page">
            Conversation
          </a>
          <a href="#brief-b">Morning brief</a>
          <a href="#action-b">Needs you · {props.decision === "pending" ? "1" : "0"}</a>
        </nav>
        <span className={styles.connectionState}>Mail + Calendar connected</span>
      </header>
      <div className={styles.canvasBody}>
        <section id="conversation-b" className={styles.canvasConversation}>
          <div className={styles.canvasIntro}>
            <p>Tuesday, August 18</p>
            <h1>What should we handle today?</h1>
          </div>
          <Conversation title="Conversation" {...props} />
        </section>
        <aside className={styles.canvasContext}>
          <section id="brief-b" className={styles.pinnedBrief} aria-labelledby="brief-b-title">
            <div className={styles.sectionTitleRow}>
              <div>
                <p>Morning brief · 8:05 AM</p>
                <h2 id="brief-b-title">Your day, in three lines</h2>
              </div>
              <span>Live</span>
            </div>
            <MorningRows decision={props.decision} compact />
          </section>
          <section id="action-b" className={styles.canvasAction} aria-labelledby="action-b-title">
            <ActionDetail id="action-b-title" condensed {...props} />
          </section>
        </aside>
      </div>
    </div>
  );
}

export function DecisionQueue(props: VariantProps) {
  return (
    <div className={styles.decisionQueue}>
      <header className={styles.queueHeader}>
        <Brand />
        <div>
          <span className={styles.statusLine}>
            <span /> Bruno is up to date
          </span>
          <button type="button">Connections</button>
        </div>
      </header>
      <div className={styles.queueTitle}>
        <div>
          <p>Tuesday, August 18 · 8:05 AM</p>
          <h1>One decision. Then your day is clear.</h1>
        </div>
        <p>
          Bruno has already prepared the context. Review the exact action, decide, or ask a question
          without leaving this screen.
        </p>
      </div>
      <div className={styles.queueWorkspace}>
        <aside className={styles.queueList} aria-label="Action Inbox">
          <div className={styles.queueListHeader}>
            <h2>Needs you</h2>
            <strong>{props.decision === "pending" ? "1" : "0"}</strong>
          </div>
          <button className={styles.queueItem} type="button" aria-current="true">
            <span className={styles.queueItemIcon}>
              <MailIcon />
            </span>
            <span>
              <strong>Follow up with Maya</strong>
              <small>Northstar Studio · existing lead</small>
            </span>
            <DecisionBadge state={props.decision} />
          </button>
          <div className={styles.queueQuiet}>
            <span>
              <CheckIcon />
            </span>
            <p>
              <strong>Everything else is covered.</strong>
              Meeting prep is ready and there are no urgent replies.
            </p>
          </div>
        </aside>
        <section className={styles.queueDetail} aria-labelledby="action-c-title">
          <ActionDetail id="action-c-title" {...props} />
        </section>
        <aside className={styles.queueConversation}>
          <Conversation title="Ask about this" compact {...props} />
        </aside>
      </div>
      <footer className={styles.queueFooter}>
        <span>Morning brief</span>
        <p>Maya may go quiet · 2 PM meeting prepared · Morning clear</p>
        <button type="button">Open full brief</button>
      </footer>
    </div>
  );
}

function SideNavigation({ active, decision }: { active: string; decision: DecisionState }) {
  return (
    <aside className={styles.sideNavigation} aria-label="Primary navigation">
      <Brand />
      <nav>
        {[
          { label: "Now", count: "" },
          { label: "Needs you", count: decision === "pending" ? "1" : "" },
          { label: "Connections", count: "" },
        ].map(({ label, count }) => (
          <a
            key={label}
            href={`#${label.toLowerCase().replace(" ", "-")}`}
            aria-current={label === active ? "page" : undefined}
          >
            <span>{label}</span>
            {count ? <strong className={styles.navCount}>{count}</strong> : null}
          </a>
        ))}
      </nav>
      <div className={styles.sideConnection}>
        <span>
          <MailIcon />
        </span>
        <p>
          <strong>Google connected</strong>
          Gmail + Calendar are current
        </p>
      </div>
    </aside>
  );
}

function Brand() {
  return <BrunoLogo className={styles.brand} />;
}

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header className={styles.pageHeader}>
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <button type="button" aria-label="Open account menu">
        AM
      </button>
    </header>
  );
}

function MorningRows({
  decision,
  compact = false,
}: {
  decision: DecisionState;
  compact?: boolean;
}) {
  return (
    <ol className={compact ? styles.morningRowsCompact : styles.morningRows}>
      {morningItems.map((item, index) => (
        <li key={item.title} data-kind={item.kind}>
          <span className={styles.morningNumber}>{index + 1}</span>
          <div>
            <div className={styles.morningTitleLine}>
              <strong>{item.title}</strong>
              {index === 0 ? <DecisionBadge state={decision} /> : null}
            </div>
            {!compact ? <p>{item.detail}</p> : null}
            <small>{item.source}</small>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ActionDetail({
  id,
  decision,
  onDecision,
  condensed = false,
}: VariantProps & { id: string; condensed?: boolean }) {
  return (
    <div className={styles.actionDetail} data-condensed={condensed || undefined}>
      <header>
        <div>
          <p>Proposed action · Email</p>
          <h2 id={id}>Follow up with Maya</h2>
        </div>
        <DecisionBadge state={decision} />
      </header>
      <p className={styles.actionReason}>
        Bruno noticed the proposal was opened twice but has not received a reply. This short
        follow-up keeps the opportunity moving without adding pressure.
      </p>
      <dl className={styles.messagePreview}>
        <div>
          <dt>To</dt>
          <dd>{proposedAction.recipient}</dd>
        </div>
        <div>
          <dt>Subject</dt>
          <dd>{proposedAction.subject}</dd>
        </div>
        <div>
          <dt>Message</dt>
          <dd>{proposedAction.body}</dd>
        </div>
      </dl>
      <details className={styles.evidence} open={!condensed}>
        <summary>
          Why Bruno is suggesting this <span>{proposedAction.evidence.length} signals</span>
        </summary>
        <ul>
          {proposedAction.evidence.map((item) => (
            <li key={item}>
              <CheckIcon /> {item}
            </li>
          ))}
        </ul>
      </details>
      <div className={styles.authorityNote}>
        <ShieldIcon />
        <p>
          <strong>You approve every one-to-one sales email.</strong>
          Only this exact draft will be sent. You can change this policy later.
        </p>
      </div>
      <DecisionControls state={decision} onDecision={onDecision} />
    </div>
  );
}

function DecisionControls({
  state,
  onDecision,
}: {
  state: DecisionState;
  onDecision: (state: DecisionState) => void;
}) {
  if (state !== "pending") {
    return (
      <div className={styles.resolvedState} data-state={state}>
        <div>
          <CheckIcon />
          <p>
            <strong>{stateLabels[state]}</strong>
            This status is reflected in the brief, conversation, and inbox.
          </p>
        </div>
        <button type="button" onClick={() => onDecision("pending")}>
          Reset prototype
        </button>
      </div>
    );
  }

  return (
    <div className={styles.decisionControls}>
      <button type="button" className={styles.approveButton} onClick={() => onDecision("approved")}>
        Approve exact email
      </button>
      <button type="button" onClick={() => onDecision("changes")}>
        Request changes
      </button>
      <button type="button" onClick={() => onDecision("declined")}>
        Decline
      </button>
    </div>
  );
}

function Conversation({
  title,
  compact = false,
  conversation,
  decision,
  draftMessage,
  onDraftMessage,
  onSubmitMessage,
}: VariantProps & { title: string; compact?: boolean }) {
  return (
    <div className={styles.conversation} data-compact={compact || undefined}>
      <header>
        <div>
          <span className={styles.brunoPulse} />
          <h2>{title}</h2>
        </div>
        <small>{stateLabels[decision]}</small>
      </header>
      <div className={styles.messages} aria-live="polite">
        {conversation.map((item) => (
          <article key={item.id} data-author={item.author}>
            <strong>{item.author}</strong>
            <p>{item.body}</p>
          </article>
        ))}
      </div>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmitMessage();
        }}
      >
        <label htmlFor={`message-${title.replaceAll(" ", "-")}`} className={styles.visuallyHidden}>
          Message Bruno
        </label>
        <textarea
          id={`message-${title.replaceAll(" ", "-")}`}
          value={draftMessage}
          onChange={(event) => onDraftMessage(event.target.value)}
          placeholder="Ask Bruno or describe a change…"
          rows={compact ? 2 : 3}
        />
        <button type="submit" disabled={!draftMessage.trim()} aria-label="Send message">
          <SendIcon />
        </button>
      </form>
      <p className={styles.composerNote}>
        Messages stay in Bruno. No Telegram or WhatsApp required.
      </p>
    </div>
  );
}

function DecisionBadge({ state }: { state: DecisionState }) {
  return (
    <span className={styles.decisionBadge} data-state={state}>
      {stateLabels[state]}
    </span>
  );
}

function MailIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m4.5 7 7.5 5.5L19.5 7" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="m4.5 10.4 3.3 3.3 7.7-8" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M12 3.5 19 6v5.2c0 4.4-2.8 7.5-7 9.3-4.2-1.8-7-4.9-7-9.3V6l7-2.5Z" />
      <path d="m9 11.8 2 2 4-4" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="m4 11 15-7-6.5 16-2-7L4 11Z" />
      <path d="m10.5 13 4-4" />
    </svg>
  );
}
