import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderExternalBeta } from "@/app/operator/_components/founder-external-beta";

describe("External Beta Founder surface", () => {
  it("shows the complete Compact before invitation acceptance", () => {
    const html = renderToStaticMarkup(
      <FounderExternalBeta
        initialStatus={{ state: "unavailable" }}
        invitationToken={"I".repeat(43)}
        workspaceReference="workspace-378"
      />,
    );
    for (const copy of [
      "Beta Compact",
      "exactly 14 days",
      "no card, renewal, extension, or paid conversion",
      "self-serve",
      "reactive",
      "withdraw",
      "exportable or deletable",
      "not Founder Acceptance Evidence",
    ]) {
      expect(html).toContain(copy);
    }
    expect(html).toContain("Accept External Beta invitation");
  });

  it("shows stage, time, capabilities, support, payment, withdrawal, export, and deletion", () => {
    const html = renderToStaticMarkup(
      <FounderExternalBeta
        initialStatus={{
          state: "active",
          stage: "External Beta",
          admittedAt: "2026-08-23T00:00:00.000Z",
          accessExpiresAt: "2026-09-06T00:00:00.000Z",
          workStoppedAt: null,
          remainingSeconds: 13 * 86_400,
          support: "Self-serve onboarding and ordinary use, with reactive support",
          payment: "Free, no card, no renewal, and no automatic paid conversion",
          evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
          availableCapabilities: ["openai", "anthropic", "calendar_reading"],
          unavailableCapabilities: ["gmail_reading", "gmail_sending"],
          withdrawalAvailable: true,
          exportAvailable: true,
          deletionAvailable: true,
          retirementDueAt: "2026-09-06T01:00:00.000Z",
        }}
      />,
    );
    for (const copy of [
      "External Beta",
      "13d 0h remaining",
      "OpenAI",
      "Anthropic",
      "Gmail reading",
      "one-to-one Gmail sending",
      "Available",
      "Paused",
      "Self-serve",
      "Free, no card",
      "Withdraw from External Beta",
      "Create Founder Data Export",
      "Request Bruno Data Deletion",
    ]) {
      expect(html).toContain(copy);
    }
    expect(html).not.toContain("runtime-");
    expect(html).not.toContain("sha256:");
  });
});
