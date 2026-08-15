/*
THESIS: Bruno edits a founder's scattered company into one daily operating page, refusing the AI-category hero plus floating chat screenshot.
OWN-WORLD: Grid-ruled stock, dark ledger ink, electric editorial blue, citron tabs, square rules, and compressed display lettering.
STORY: See today's decisions, understand the Business Graph behind them, trust explicit policies and verification, then follow the build.
FIRST VIEWPORT: A dated two-page spread pairs Bruno's promise with three illustrative decisions; the primary action sits under the promise and a graph route crosses the fold.
FORM: The Company Daybook, grounded direction 1; seed 2b573c57.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
*/

import Link from "next/link";
import styles from "./landing.module.css";

const inboxItems = [
  {
    signal: "Potential sale",
    detail: "A promising lead has been waiting five days for a reply.",
    action: "Follow-up prepared",
    policy: "Needs your approval",
  },
  {
    signal: "Customer risk",
    detail: "A cancellation followed two messages about API latency.",
    action: "Context gathered",
    policy: "Needs your judgment",
  },
  {
    signal: "Growth opportunity",
    detail: "High-intent traffic is reaching a page that rarely converts.",
    action: "Likely cause found",
    policy: "Investigation ready",
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
    "A release triggers coordinated communication, observation, and an outcome report.",
  ],
  [
    "Weekly CEO review",
    "Revenue, product, customers, experiments, and commitments resolve into next actions.",
  ],
] as const;

const policyRows = [
  ["Read business systems", "Always allowed"],
  ["Prepare a customer reply", "Always allowed"],
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
      <path d="M4 10h11M10 5l5 5-5 5" />
    </svg>
  );
}

function LoopMark() {
  return (
    <svg aria-hidden="true" className={styles.loopMark} viewBox="0 0 44 44">
      <path d="M33 14a14 14 0 1 0 2.5 12" />
      <path d="m28 8 6 6-7 4" />
      <circle cx="22" cy="22" r="3" />
    </svg>
  );
}

export default function Home() {
  return (
    <main className={styles.page} id="top">
      <header className={styles.siteHeader}>
        <Link className={styles.wordmark} href="#top" aria-label="Bruno home">
          Bruno<span aria-hidden="true">.</span>
        </Link>
        <nav className={styles.siteNav} aria-label="Landing page navigation">
          <Link href="#how-it-works">How it works</Link>
          <Link href="#operating-loops">Operating loops</Link>
          <Link href="/sign-in">Sign in</Link>
        </nav>
      </header>

      <section className={styles.heroSpread} aria-labelledby="landing-title">
        <div className={styles.leftPage}>
          <div className={styles.daybookMeta}>
            <span>Founder daybook</span>
            <span className={styles.developmentNote}>Product direction · in development</span>
            <time dateTime="2026-08-16">16 · 08 · 26</time>
          </div>
          <h1 id="landing-title">Bruno runs your one-person business with you.</h1>
          <p className={styles.heroCopy}>
            The operating system for a one-person company. Bruno understands what is happening,
            finds the work that matters, closes the loops you permit, and brings you the decisions
            only you can make.
          </p>
          <div className={styles.heroActions}>
            <a
              className={styles.primaryAction}
              href="https://github.com/ametel01/bruno"
              rel="noreferrer"
              target="_blank"
            >
              Follow the build
              <ArrowIcon />
            </a>
            <Link className={styles.textAction} href="#how-it-works">
              See the operating model
            </Link>
          </div>
          <p className={styles.truthNote}>
            Bruno’s new command center and operating loops are the approved direction—not a claim
            that they are already shipped.
          </p>
        </div>

        <div className={styles.rightPage}>
          <div className={styles.inboxHeading}>
            <div>
              <h2>Good morning, Alex. Three things need you.</h2>
            </div>
            <span className={styles.syntheticStamp}>Illustrative data</span>
          </div>
          <ol className={styles.inboxList}>
            {inboxItems.map((item, index) => (
              <li key={item.signal}>
                <span className={styles.itemNumber}>{String(index + 1).padStart(2, "0")}</span>
                <div className={styles.inboxBody}>
                  <h3>{item.signal}</h3>
                  <p>{item.detail}</p>
                  <div className={styles.inboxOutcome}>
                    <span>{item.action}</span>
                    <strong>{item.policy}</strong>
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div className={styles.doneLine}>
            <span>Done by Bruno</span>
            <strong>Four routine loops closed</strong>
            <span>Illustrative</span>
          </div>
        </div>

        <div className={styles.graphRibbon}>
          <span>Stripe</span>
          <span>Gmail</span>
          <span>GitHub</span>
          <span>Analytics</span>
          <strong>One living company model</strong>
        </div>
      </section>

      <section className={styles.mechanismSection} id="how-it-works" aria-labelledby="graph-title">
        <Link className={styles.sectionTab} href="#operating-loops">
          Next · operating loops
          <ArrowIcon />
        </Link>
        <div className={styles.sectionHeading}>
          <h2 id="graph-title">Your company becomes a working model.</h2>
          <p>
            Not chat history. Not a bag of integrations. A persistent Business Graph that connects
            goals, customers, conversations, revenue, product, releases, metrics, commitments,
            experiments, and open loops.
          </p>
        </div>

        <div className={styles.graphField}>
          <div className={styles.graphSources}>
            <span>Conversations</span>
            <span>Revenue</span>
            <span>Product</span>
            <span>Commitments</span>
          </div>
          <div className={styles.graphCore}>
            <LoopMark />
            <span>Business Graph</span>
            <strong>What changed—and why it matters</strong>
          </div>
          <div className={styles.graphOutputs}>
            <span>Decision</span>
            <span>Action</span>
            <span>Verified outcome</span>
          </div>
          <div className={styles.graphRoute} aria-hidden="true" />
        </div>

        <ol className={styles.processLine} aria-label="Bruno operating cycle">
          <li>
            <span>Business changes</span>
          </li>
          <li>
            <span>Bruno understands</span>
          </li>
          <li>
            <span>Acts within policy</span>
          </li>
          <li>
            <span>Verifies the result</span>
          </li>
          <li>
            <span>Updates company state</span>
          </li>
        </ol>
      </section>

      <section className={styles.loopsSection} id="operating-loops" aria-labelledby="loops-title">
        <div className={styles.loopsIntro}>
          <h2 id="loops-title">Six loops. Run exceptionally well.</h2>
          <p>
            Bruno starts with the work solo SaaS founders repeat every week—not a marketplace of a
            hundred disconnected skills.
          </p>
          <Link className={styles.sectionTab} href="#trust-model">
            Next · policies &amp; impact
            <ArrowIcon />
          </Link>
        </div>
        <ol className={styles.loopLedger}>
          {operatingLoops.map(([title, description], index) => (
            <li key={title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.trustSpread} id="trust-model" aria-labelledby="trust-title">
        <div className={styles.policyPage}>
          <h2 id="trust-title">Autonomy you can read.</h2>
          <p>
            Authority is a business policy: always allow, ask, or never allow. Bruno can earn more
            autonomy, but it cannot silently take it.
          </p>
          <table className={styles.policyTable}>
            <caption className="visually-hidden">Example email policy</caption>
            <thead>
              <tr>
                <th scope="col">Email action</th>
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
          <p className={styles.exampleLabel}>Illustrative policy model</p>
        </div>

        <div className={styles.impactPage}>
          <h2>Measured like an employee.</h2>
          <p>
            Bruno reports the business outcomes it influenced instead of making model usage the
            headline.
          </p>
          <ul className={styles.impactList}>
            {impactMeasures.map((measure) => (
              <li key={measure}>
                <span>{measure}</span>
                <span aria-hidden="true" />
              </li>
            ))}
          </ul>
          <p className={styles.impactTruth}>
            No outcome figures are shown until Bruno can measure them with real product evidence.
          </p>
        </div>
      </section>

      <section className={styles.closingSection} aria-labelledby="closing-title">
        <div>
          <h2 id="closing-title">Stop prompting. Start managing.</h2>
          <p>The founder sets the goals, policies, and judgment. Bruno keeps the company moving.</p>
        </div>
        <div className={styles.closingActions}>
          <a
            className={styles.primaryAction}
            href="https://github.com/ametel01/bruno"
            rel="noreferrer"
            target="_blank"
          >
            Follow Bruno’s build
            <ArrowIcon />
          </a>
          <Link href="/sign-in">Existing user? Sign in</Link>
        </div>
      </section>

      <footer className={styles.siteFooter}>
        <Link className={styles.wordmark} href="#top">
          Bruno<span aria-hidden="true">.</span>
        </Link>
        <p>The operating system for a one-person company.</p>
        <span>Product direction · 2026</span>
      </footer>
    </main>
  );
}
