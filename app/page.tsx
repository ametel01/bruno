/*
THESIS: Bruno.Ai is the always-on AI agent that keeps a one-person company in motion, learns from the founder, and improves through one calm operating loop.
OWN-WORLD: Ivory and stone fields, deep-charcoal Satoshi, warm espresso rules, mint and lime signals, orbital linework, and softly precise product panels.
STORY: Understand Bruno.Ai’s 24/7 role and learning loop, see the Action Inbox and Business Graph at work, then enter the shipped dashboard or create an agent.
FIRST VIEWPORT: A quiet navigation bar leads into an always-on promise and two clear actions beside a high-fidelity illustrative Action Inbox crossed by Bruno.Ai’s circular signal pattern.
FORM: Calm Operations Brandboard, the user-pinned hard reference; seed b32744ed.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
*/

import Link from "next/link";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import styles from "./landing.module.css";

const inboxItems = [
  {
    kind: "mail",
    title: "Follow up with churned trial user",
    detail: "High intent · Trial ended 2 days ago",
    tag: "CRM outreach",
    timing: "Due today",
  },
  {
    kind: "chart",
    title: "Review MRR dip — May",
    detail: "−3.1% vs April · Trend requires attention",
    tag: "Analytics",
    timing: "Due today",
  },
  {
    kind: "message",
    title: "Approve the customer recovery draft",
    detail: "Cancellation followed two latency reports",
    tag: "Needs judgment",
    timing: "Ask first",
  },
] as const;

const operatingLoops = [
  [
    "Morning brief",
    "What changed overnight, what matters today, and where your judgment is needed.",
  ],
  [
    "Lead follow-up",
    "Unanswered prospects stay open until the opportunity closes or is abandoned.",
  ],
  [
    "Customer risk",
    "Payment, support, sentiment, and usage signals become a prepared intervention.",
  ],
  [
    "Product intelligence",
    "Conversations, analytics, and engineering work become evidence-backed tasks.",
  ],
  [
    "Launch operator",
    "A release triggers communication, observation, and a verified outcome report.",
  ],
  [
    "Weekly CEO review",
    "Revenue, product, customers, and commitments resolve into concrete next actions.",
  ],
] as const;

const policyRows = [
  ["Read connected business systems", "Always allow"],
  ["Prepare a customer reply", "Always allow"],
  ["Send to an existing customer", "Ask me"],
  ["Delete a company record", "Never"],
] as const;

const impactMeasures = [
  "Founder time returned",
  "Revenue influenced",
  "Churn recovered",
  "Leads followed up",
  "Customer issues resolved",
  "Product insights found",
] as const;

function ArrowIcon() {
  return (
    <svg aria-hidden="true" className={styles.arrowIcon} viewBox="0 0 20 20">
      <path d="M3 10h13M11 5l5 5-5 5" />
    </svg>
  );
}

function FeatureIcon({ name }: { name: "calm" | "proactive" | "trust" | "operate" }) {
  if (name === "calm") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 7c3-2 5 2 9 0s6 2 9 0M3 12c3-2 5 2 9 0s6 2 9 0M3 17c3-2 5 2 9 0s6 2 9 0" />
      </svg>
    );
  }

  if (name === "proactive") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M4 12h15M14 6l6 6-6 6" />
      </svg>
    );
  }

  if (name === "trust") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M12 3 20 7v5c0 5-3 8-8 10-5-2-8-5-8-10V7l8-4Z" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  );
}

function InboxIcon({ kind }: { kind: (typeof inboxItems)[number]["kind"] }) {
  if (kind === "mail") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m4 7 8 6 8-6" />
      </svg>
    );
  }

  if (kind === "chart") {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M5 19V9M10 19V5M15 19v-7M20 19V3" />
        <path d="m4 13 5-3 5 2 6-5" />
      </svg>
    );
  }

  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M4 5h16v11H9l-5 4V5Z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  );
}

export default function Home() {
  return (
    <main className={styles.page} id="top">
      <header className={styles.siteHeader}>
        <Link className={styles.brandLink} href="#top" aria-label="Bruno.Ai home">
          <BrunoLogo className={styles.brandLockup} />
        </Link>
        <nav className={styles.siteNav} aria-label="Landing page navigation">
          <Link href="#how-it-works">How it works</Link>
          <Link href="#operating-loops">Operating loops</Link>
          <Link href="#trust-model">Trust</Link>
        </nav>
        <div className={styles.headerActions}>
          <Link className={styles.signInLink} href="/sign-in">
            Sign in
          </Link>
          <Link className={styles.headerCta} href="/dashboard">
            Open dashboard
            <ArrowIcon />
          </Link>
        </div>
      </header>

      <section className={styles.hero} aria-labelledby="landing-title">
        <div className={styles.heroPattern} aria-hidden="true">
          <span className={styles.patternArcA} />
          <span className={styles.patternArcB} />
          <span className={styles.patternArcC} />
          <span className={styles.patternNodeA} />
          <span className={styles.patternNodeB} />
          <span className={styles.patternNodeC} />
        </div>

        <div className={styles.heroCopyBlock}>
          <h1 id="landing-title">Bruno.Ai runs your business with you. 24/7.</h1>
          <p className={styles.heroCopy}>
            Your always-on AI agent for a one-person company. It learns from every interaction,
            correction, approval, and outcome—then gets better at the work you trust it to handle.
          </p>
          <div className={styles.heroActions}>
            <Link className={styles.primaryAction} href="/dashboard">
              Open dashboard
              <ArrowIcon />
            </Link>
            <Link className={styles.secondaryAction} href="/agents#create-agent-title">
              Create an agent
            </Link>
          </div>
          <a
            className={styles.buildLink}
            href="https://github.com/ametel01/bruno"
            rel="noreferrer"
            target="_blank"
          >
            Follow the build
            <ArrowIcon />
          </a>
        </div>

        <div className={styles.productProof}>
          <div className={styles.proofTopbar}>
            <BrunoLogo className={styles.proofBrand} />
            <span>Today</span>
            <span className={styles.addButton} aria-hidden="true">
              +
            </span>
          </div>
          <div className={styles.proofHeading}>
            <div>
              <h2>Action Inbox</h2>
              <p>Founder decisions, prepared before they reach you.</p>
            </div>
            <span>Illustrative data</span>
          </div>
          <div className={styles.proofStatus}>
            <div>
              <span>Needs you</span>
              <strong>3 decisions</strong>
            </div>
            <div>
              <span>Always on</span>
              <strong>24/7 agent</strong>
            </div>
            <div>
              <span>Learning</span>
              <strong>Every interaction</strong>
            </div>
          </div>
          <ol className={styles.inboxList}>
            {inboxItems.map((item, index) => (
              <li key={item.title}>
                <span className={styles.inboxIcon} data-tone={index === 1 ? "lime" : "mint"}>
                  <InboxIcon kind={item.kind} />
                </span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.detail}</p>
                  <span className={styles.itemTag} data-tone={index === 1 ? "lime" : "mint"}>
                    {item.tag}
                  </span>
                </div>
                <div className={styles.itemState}>
                  <span>{item.timing}</span>
                  <CheckIcon />
                </div>
              </li>
            ))}
          </ol>
        </div>

        <p className={styles.truthNote}>
          Available today: create and operate persistent agents in Bruno.Ai’s dashboard. The
          Business Graph and operating loops shown here are the approved direction—not a claim that
          they are already shipped.
        </p>
      </section>

      <section className={styles.attributes} aria-label="Bruno.Ai brand principles">
        <div>
          <span className={styles.attributeIcon} data-tone="mint">
            <FeatureIcon name="calm" />
          </span>
          <strong>Calm</strong>
          <p>Watches continuously, surfaces only what matters.</p>
        </div>
        <div>
          <span className={styles.attributeIcon} data-tone="stone">
            <FeatureIcon name="proactive" />
          </span>
          <strong>Proactive</strong>
          <p>Runs 24/7, finding work instead of waiting for prompts.</p>
        </div>
        <div>
          <span className={styles.attributeIcon} data-tone="stone">
            <FeatureIcon name="trust" />
          </span>
          <strong>Trustworthy</strong>
          <p>Learns from corrections without expanding its own authority.</p>
        </div>
        <div>
          <span className={styles.attributeIcon} data-tone="lime">
            <FeatureIcon name="operate" />
          </span>
          <strong>Operational</strong>
          <p>Acts, verifies the result, and improves the next attempt.</p>
        </div>
      </section>

      <section className={styles.mechanismSection} id="how-it-works" aria-labelledby="graph-title">
        <div className={styles.mechanismCopy}>
          <h2 id="graph-title">One company. One agent that keeps learning.</h2>
          <p>
            Bruno.Ai’s persistent Business Graph connects customers, conversations, revenue,
            product, releases, commitments, and open loops. Every interaction, correction, approval,
            and verified outcome makes that working model more useful.
          </p>
          <Link className={styles.inlineAction} href="/dashboard">
            See the operating surface
            <ArrowIcon />
          </Link>
        </div>

        <figure className={styles.graphModel}>
          <figcaption className="visually-hidden">Business Graph operating cycle</figcaption>
          <div className={styles.graphSources}>
            <span>Gmail</span>
            <span>Stripe</span>
            <span>GitHub</span>
            <span>Analytics</span>
          </div>
          <div className={styles.graphOrbit}>
            <div className={styles.graphCore}>
              <BrunoLogo className={styles.graphMark} compact />
              <span>Business Graph</span>
              <strong>What changed, what it learned, and why it matters</strong>
            </div>
            <span className={styles.orbitNode} data-position="top">
              Observe
            </span>
            <span className={styles.orbitNode} data-position="right">
              Learn
            </span>
            <span className={styles.orbitNode} data-position="bottom">
              Act
            </span>
            <span className={styles.orbitNode} data-position="left">
              Verify
            </span>
            <span className={styles.orbitSignal} aria-hidden="true" />
          </div>
          <div className={styles.graphOutcome}>
            <span>Decision</span>
            <span>Action</span>
            <span>Verified outcome</span>
          </div>
        </figure>
      </section>

      <section className={styles.loopsSection} id="operating-loops" aria-labelledby="loops-title">
        <div className={styles.loopsHeading}>
          <h2 id="loops-title">The work that keeps a small company alive.</h2>
          <p>
            Bruno.Ai runs six essential operating loops continuously, carrying what it learns from
            one interaction into the next instead of waiting for another prompt.
          </p>
        </div>
        <ol className={styles.loopList}>
          {operatingLoops.map(([title, description], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{description}</p>
              <ArrowIcon />
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.trustSection} id="trust-model" aria-labelledby="trust-title">
        <div className={styles.policyPanel}>
          <h2 id="trust-title">Autonomy you can read.</h2>
          <p>
            Learning improves how Bruno.Ai works, never what it is allowed to do. Authority stays an
            explicit business policy: always allow, ask, or never allow.
          </p>
          <table className={styles.policyTable}>
            <caption className="visually-hidden">
              Illustrative customer communication policy
            </caption>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Policy</th>
              </tr>
            </thead>
            <tbody>
              {policyRows.map(([action, policy]) => (
                <tr key={action}>
                  <td>{action}</td>
                  <td>
                    <strong data-policy={policy}>{policy}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className={styles.exampleLabel}>Illustrative policy model</span>
        </div>

        <div className={styles.impactPanel}>
          <h2>Measured like an employee.</h2>
          <p>
            Bruno.Ai reports business outcomes instead of making model usage the headline. No figure
            appears until the product can support it with evidence.
          </p>
          <ul>
            {impactMeasures.map((measure) => (
              <li key={measure}>
                <CheckIcon />
                <span>{measure}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className={styles.closingSection} aria-labelledby="closing-title">
        <div className={styles.closingPattern} aria-hidden="true" />
        <BrunoLogo className={styles.closingMark} compact />
        <div>
          <h2 id="closing-title">Always working. Always learning.</h2>
          <p>Your goals and policies stay in charge. Bruno.Ai keeps improving within them.</p>
        </div>
        <div className={styles.closingActions}>
          <Link className={styles.darkAction} href="/dashboard">
            Open dashboard
            <ArrowIcon />
          </Link>
          <Link href="/agents#create-agent-title">Create an agent</Link>
        </div>
      </section>

      <footer className={styles.siteFooter}>
        <BrunoLogo className={styles.footerBrand} />
        <p>The always-on AI agent for a one-person company.</p>
        <span>24/7 · Built to operate.</span>
      </footer>
    </main>
  );
}
