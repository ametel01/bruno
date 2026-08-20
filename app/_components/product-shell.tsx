import Link from "next/link";
import { BrunoLogo } from "@/app/_components/bruno-logo";
import { AccountControls } from "@/app/_components/clerk-auth-surfaces";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";

type ProductShellProps = {
  active: "dashboard" | "agents" | "settings" | "now" | "needs-you" | "connections" | "privacy";
  eyebrow: string;
  title: string;
  description: string;
  children?: React.ReactNode;
  showHealthLink?: boolean;
};

const navigationItems = [
  { href: "/operator", label: "Now", key: "now" },
  { href: "/operator#needs-you", label: "Needs you", key: "needs-you" },
  { href: "/operator#connections", label: "Connections", key: "connections" },
  { href: "/operator/privacy", label: "Privacy Center", key: "privacy" },
] as const;

export function ProductShell({
  active,
  eyebrow,
  title,
  description,
  children,
  showHealthLink = false,
}: ProductShellProps) {
  const clerkEnabled = resolveAuthMode(process.env).mode === "clerk";
  // Internal compatibility components can still render this shell, but retired Founder routes
  // never expose a legacy current item.
  const activeFounderKey =
    active === "dashboard" ? "now" : active === "agents" || active === "settings" ? null : active;

  return (
    <div className="app-shell" data-active={active} data-impeccable-authenticated-seed="b32744ed">
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="brand-block">
          <Link className="brand-mark" href="/operator" aria-label="Bruno.Ai Founder workspace">
            <BrunoLogo className="product-bruno-logo" />
          </Link>
        </div>
        <nav className="nav-list" aria-label="Product routes">
          {navigationItems.map((item) => (
            <Link
              aria-current={activeFounderKey === item.key ? "page" : undefined}
              className="nav-link"
              href={item.href}
              key={item.key}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-agent-state">
          <span className="agent-state-orbit" aria-hidden="true">
            <span />
          </span>
          <span>
            <strong>Working 24/7</strong>
            <small>Learns from every decision</small>
          </span>
        </div>
        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <span>Private Founder workspace</span>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            <span className="topbar-presence">
              <span aria-hidden="true" />
              Bruno.Ai is on
            </span>
            {clerkEnabled ? <AccountControls /> : null}
            {showHealthLink ? (
              <Link className="health-link" href="/health">
                System health
              </Link>
            ) : null}
          </div>
        </header>
        <p className="page-description">{description}</p>
        {children}
      </div>
    </div>
  );
}

type EmptyStateProps = {
  title: string;
  description: string;
  action?: {
    href: string;
    label: string;
  };
};

export function EmptyState({ title, description, action }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      {!action ? <div className="empty-state-rule" aria-hidden="true" /> : null}
      <div>
        <h2 id="empty-state-title">{title}</h2>
        <p>{description}</p>
      </div>
      {action ? (
        <Link className="primary-button empty-state-action" href={action.href}>
          {action.label}
        </Link>
      ) : null}
    </section>
  );
}

type PlaceholderPanelProps = {
  title: string;
  children: React.ReactNode;
};

export function PlaceholderPanel({ title, children }: PlaceholderPanelProps) {
  return (
    <section className="placeholder-panel" aria-labelledby={`${slugify(title)}-title`}>
      <h2 id={`${slugify(title)}-title`}>{title}</h2>
      <div>{children}</div>
    </section>
  );
}

function slugify(value: string) {
  return value.toLowerCase().replaceAll(" ", "-");
}
