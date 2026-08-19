import Link from "next/link";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import styles from "./founder-operator-shell.module.css";

export function FounderOperatorShell({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar} aria-label="Founder navigation">
        <Link className={styles.brand} href="/operator" aria-label="Bruno.Ai Operator">
          <BrunoLogo className="product-bruno-logo" />
          <span>Bruno.Ai</span>
        </Link>
        <nav className={styles.nav} aria-label="Founder workspace">
          <Link className={styles.navLink} href="/operator" aria-current="page">
            <span>Now</span>
          </Link>
          <Link className={styles.navLink} href="/operator#needs-you">
            <span>Needs you</span>
          </Link>
          <Link className={styles.navLink} href="/operator#connections">
            <span>Connections</span>
          </Link>
          <Link className={styles.navLink} href="/operator/privacy" aria-current="page">
            <span>Privacy Center</span>
          </Link>
        </nav>
        <div className={styles.sidebarNote}>
          <span className={styles.statusDot} aria-hidden="true" />
          <span>Private Founder workspace</span>
        </div>
      </aside>
      <main className={styles.main}>
        <header className={styles.header}>
          <div>
            <p className={styles.eyebrow}>Founder workspace</p>
            <h1>Bruno.Ai Operator</h1>
          </div>
          <span className={styles.presence}>
            <span aria-hidden="true" /> Bruno is here
          </span>
        </header>
        {children}
      </main>
    </div>
  );
}
