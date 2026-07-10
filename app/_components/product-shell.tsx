import Link from "next/link";
import { AccountControls } from "@/app/_components/clerk-auth-surfaces";
import { resolveAuthMode } from "@/src/auth/server-auth-mode";

type ProductShellProps = {
  active: "dashboard" | "agents" | "settings";
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
};

const navigationItems = [
  { href: "/dashboard", label: "Dashboard", key: "dashboard" },
  { href: "/agents", label: "Agents", key: "agents" },
  { href: "/settings", label: "Settings", key: "settings" },
] as const;

export function ProductShell({ active, eyebrow, title, description, children }: ProductShellProps) {
  const clerkEnabled = resolveAuthMode(process.env).mode === "clerk";

  return (
    <div className="app-shell">
      <aside className="app-sidebar" aria-label="Primary navigation">
        <div className="brand-block">
          <Link className="brand-mark" href="/dashboard" aria-label="AgentBay dashboard">
            AB
          </Link>
          <div>
            <p className="brand-name">AgentBay</p>
            <p className="brand-subtitle">Milestone 6</p>
          </div>
        </div>
        <nav className="nav-list" aria-label="Product routes">
          {navigationItems.map((item) => (
            <Link
              aria-current={active === item.key ? "page" : undefined}
              className="nav-link"
              href={item.href}
              key={item.key}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" aria-hidden="true" />
          <span>Database health route active</span>
        </div>
      </aside>
      <div className="shell-main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{eyebrow}</p>
            <h1>{title}</h1>
          </div>
          <div className="topbar-actions">
            {clerkEnabled ? <AccountControls /> : null}
            <a className="health-link" href="/health">
              Health JSON
            </a>
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
  actionLabel?: string;
};

export function EmptyState({ title, description, actionLabel }: EmptyStateProps) {
  return (
    <section className="empty-state" aria-labelledby="empty-state-title">
      <div className="empty-state-rule" aria-hidden="true" />
      <div>
        <h2 id="empty-state-title">{title}</h2>
        <p>{description}</p>
      </div>
      {actionLabel ? (
        <button className="disabled-button" type="button" disabled>
          {actionLabel}
        </button>
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
