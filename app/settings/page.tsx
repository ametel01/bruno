import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";

export default function SettingsPage() {
  return (
    <ProductShell
      active="settings"
      eyebrow="Settings"
      title="Workspace settings"
      description="Configuration categories are visible as placeholders while integrations, billing, runners, and secret storage remain out of scope."
    >
      <div className="settings-grid">
        <PlaceholderPanel title="Application">
          <p>Workspace naming, ownership, and environment policy will be defined later.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Environment">
          <p>Runtime environment controls are not implemented in this milestone.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Billing">
          <p>Plans, invoices, usage, and subscription state are not connected.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Integrations">
          <p>Hermes, Telegram, provider integrations, and webhooks are not configured here.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Runners">
          <p>Provisioning, capacity, and execution policies wait for future runner work.</p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Secrets">
          <p>Secret values and credential storage are not accepted by the Milestone 0 shell.</p>
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}
