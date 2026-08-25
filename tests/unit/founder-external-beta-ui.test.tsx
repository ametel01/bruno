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
        initialPrivacy={{
          state: "available",
          collection: {
            allowlistedFacts: [
              "Activation",
              "Journey completion",
              "Timing",
              "Capability state",
              "Safe failure category",
              "Support duration",
            ],
            neverCollected: [
              "Message bodies",
              "Calendar content",
              "Recipients",
              "Prompts",
              "Provider responses",
              "Credentials",
              "Unrestricted metadata",
            ],
            autocapture: false,
            sessionReplay: false,
            personProfiles: false,
          },
          consent: {
            measurement: "not_granted",
            feedback: "refused",
            recording: "refused",
            testimonial: "not_granted",
            identity: "not_granted",
            name: "not_granted",
            logo: "not_granted",
            quotation: "not_granted",
            case_study: "not_granted",
          },
          recordingRetentionDays: 30,
          exportAvailable: true,
          deletionAvailable: true,
          accessUnaffectedByRefusal: true,
          evidenceClassification: "Product-hardening only; never Founder Acceptance Evidence",
        }}
      />,
    );
    for (const copy of [
      "External Beta",
      "13d 0h remaining",
      "Sep 6, 2026, 12:00 AM UTC",
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
      "External Beta privacy",
      "Nothing is measured until you opt in",
      "Message bodies",
      "Research recording",
      "Beta feedback",
      "Testimonial use",
      "Identity use",
      "Name use",
      "Logo use",
      "Quotation use",
      "Case-study use",
      "within 30 days",
      "never reduces your 14-day access",
      "Export External Beta privacy data",
      "Delete External Beta measurements",
    ]) {
      expect(html).toContain(copy);
    }
    expect(html).not.toContain("runtime-");
    expect(html).not.toContain("sha256:");
  });
});
