import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductShell } from "@/app/_components/product-shell";
import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import type { FounderOnboardingDto } from "@/src/server/operators/founder-onboarding";
import type { FounderOperatorDto } from "@/src/server/operators/founder-operator";

const OPERATOR: FounderOperatorDto = {
  id: "00000000-0000-4000-8000-000000003391",
  userId: "00000000-0000-4000-8000-000000003381",
  status: "active",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  preparation: {
    id: "00000000-0000-4000-8000-000000003392",
    status: "awaiting_timezone",
    timezone: null,
    timezoneConfirmedAt: null,
    startedAt: null,
    completedAt: null,
    recoveryMessage: null,
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
  },
};

describe("Founder Operator preparation shell", () => {
  it("asks the Founder to begin preparation without creating state on page load", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, { initialOperator: null }),
    );

    expect(html).toContain("Create my Operator");
    expect(html).toContain("Opening this page alone does not create one.");
    expect(html).not.toContain("Confirm timezone");
  });

  it("moves the legacy shell navigation to Founder outcomes", () => {
    const html = renderToStaticMarkup(
      createElement(
        ProductShell,
        {
          active: "dashboard",
          eyebrow: "",
          title: "Legacy compatibility",
          description: "",
        },
        createElement("p", null, "legacy content"),
      ),
    );

    expect(html).toContain('href="/operator"');
    expect(html).toContain('href="/operator#needs-you"');
    expect(html).toContain('href="/operator#connections"');
    expect(html).toContain('href="/operator/privacy"');
    expect(html).not.toContain('href="/agents"');
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain("System health");
  });

  it("uses Founder outcomes as the ordinary navigation contract", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorShell, null, createElement("p", null, "workspace")),
    );

    expect(html).toContain('href="/operator#conversation"');
    expect(html).toContain('href="/operator#needs-you"');
    expect(html).toContain('href="/operator#connections"');
    expect(html).toContain('href="/operator/privacy"');
    expect(html).not.toContain("Agents");
    expect(html).not.toContain("Settings");
    expect(html).not.toContain("Troubleshooting");
  });

  it("keeps the first-run surface in Founder language and out of legacy mechanics", () => {
    const html = renderToStaticMarkup(
      createElement(
        FounderOperatorShell,
        null,
        createElement(FounderOperatorPreparation, { initialOperator: OPERATOR }),
      ),
    );

    expect(html).toContain("Bruno.Ai Operator");
    expect(html).toContain("Confirm timezone");
    expect(html).toContain('id="onboarding-timezone"');
    expect(html).toContain("Manila (Asia)");
    expect(html).not.toContain("IANA");
    expect(html).toContain("Safe to resume");
    for (const excluded of [
      "agent template",
      "model choice",
      "API key",
      "messaging bot",
      "runner",
      "deployment stage",
    ]) {
      expect(html.toLowerCase()).not.toContain(excluded.toLowerCase());
    }
  });

  it("shows the saved timezone and resumable preparation state after confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "preparing",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
            startedAt: "2026-08-18T01:00:00.000Z",
          },
        },
      }),
    );

    expect(html).toContain("Your Operator is being prepared.");
    expect(html).toContain('value="Asia/Manila"');
    expect(html).toContain("Confirmed");
    expect(html).toContain("Your progress is saved");
  });

  it("shows restore verification without exposing archive mechanics or credentials", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: OPERATOR,
        initialRecoveryArchive: {
          state: "current",
          lastVerifiedAt: "2026-08-22T00:00:00.000Z",
          restoreVerifiedAt: "2026-08-22T00:00:00.000Z",
          nextArchiveDueAt: "2026-08-23T00:00:00.000Z",
          retentionEndsAt: "2026-09-21T00:00:00.000Z",
          latestAttempt: {
            status: "failed",
            observedAt: "2026-08-22T22:00:00.000Z",
          },
          deletion: {
            status: "completed",
            attemptedAt: "2026-08-22T00:00:00.000Z",
            completedAt: "2026-08-22T00:00:01.000Z",
          },
        },
      }),
    );

    expect(html).toContain("Protected recovery");
    expect(html).toContain("Recovery Archive verified");
    expect(html).toContain("provider access is never copied");
    expect(html).toContain("Current protection remains verified");
    expect(html).toContain("latest daily refresh needs another try");
    expect(html).toContain("were safely deleted");
    expect(html).not.toMatch(/object key|ciphertext|credential digest|storage bucket/i);
  });

  it("distinguishes unavailable protection and a failed expiry deletion", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: OPERATOR,
        initialRecoveryArchive: {
          state: "unavailable",
          lastVerifiedAt: null,
          restoreVerifiedAt: null,
          nextArchiveDueAt: null,
          retentionEndsAt: null,
          latestAttempt: null,
          deletion: {
            status: "failed",
            attemptedAt: "2026-08-22T00:00:00.000Z",
            completedAt: null,
          },
        },
      }),
    );

    expect(html).toContain("Recovery Archive unavailable");
    expect(html).toContain("Unavailable");
    expect(html).toContain("deletion needs attention");
    expect(html).not.toContain("Recovery Archive is being prepared");
  });

  it("never presents a delete request as completed Infrastructure Retirement", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: OPERATOR,
        initialInfrastructureRetirement: {
          state: "in_progress",
          receiptId: "retirement-374",
          attemptCount: 2,
          hardDestructionDueAt: "2026-08-22T00:00:00.000Z",
          workStoppedAt: "2026-08-22T00:00:00.000Z",
          credentialsDisabledAt: "2026-08-22T00:00:00.000Z",
          archive: { outcome: "failed", criticalFailure: true },
          exactResource: {
            provider: "digitalocean",
            dropletId: "droplet-374",
            firewallId: "firewall-374",
          },
          provider: {
            droplet: "absent",
            firewall: "unknown",
            lastCheckedAt: "2026-08-22T00:00:01.000Z",
            absenceVerifiedAt: null,
          },
          billableRuntime: {
            startedAt: "2026-08-20T00:00:00.000Z",
            endedAt: null,
            seconds: null,
          },
          needsAttention: true,
        },
      }),
    );

    expect(html).toContain("Runtime removal is still being verified");
    expect(html).toContain("In progress");
    expect(html).toContain("not complete until DigitalOcean independently confirms");
    expect(html).toContain("critical preservation failure");
    expect(html).toContain("same exact resource");
    expect(html).not.toContain("Runtime cost stopped");
  });

  it("anchors the next incomplete onboarding step in the Founder workspace", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        initialOnboarding: {
          nextStep: "calendar",
          defaultRoute: "/operator#onboarding-calendar",
          activated: false,
          operation: "none",
          capabilities: {
            ai: "ready",
            calendar: "missing",
            mail: "not_offered",
            core: "missing",
          },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: true,
            processingConsent: false,
            firstBriefReady: false,
            primarySuiteIdentity: null,
          },
        } satisfies FounderOnboardingDto,
      }),
    );

    expect(html).toContain('id="onboarding-calendar"');
    expect(html).toContain("Next step: Connect your Ready Calendar Connection");
    expect(html).toContain("Needs you");
  });

  it("keeps the built-in Conversation in Bruno and out of external channel setup", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
            startedAt: "2026-08-18T01:00:00.000Z",
            completedAt: "2026-08-18T01:00:01.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        ownerPreviewAdmitted: true,
      }),
    );

    expect(html).toContain("Bruno Conversation");
    expect(html).toContain("What should we handle today?");
    expect(html).toContain("Conversation is saved across reloads and devices.");
    expect(html).toContain('id="needs-you"');
    expect(html).not.toContain("Telegram");
    expect(html).not.toContain("WhatsApp");
  });

  it("keeps a ready runtime outside the Founder workspace until Owner Preview is admitted", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        initialOnboarding: {
          nextStep: "conversation",
          defaultRoute: "/operator#conversation",
          activated: true,
          operation: "calendar_limited",
          capabilities: { ai: "ready", calendar: "ready", mail: "not_offered", core: "missing" },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: true,
            processingConsent: true,
            firstBriefReady: true,
            primarySuiteIdentity: "google-owner-preview",
          },
        } satisfies FounderOnboardingDto,
        ownerPreviewAdmitted: false,
      }),
    );

    expect(html).toContain("Owner Preview is waiting for current protection");
    expect(html).not.toContain('aria-label="Current Founder workspace"');
    expect(html).not.toContain("What should we handle today?");
  });

  it("preserves the safe Founder workspace while new work is held", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        initialOnboarding: {
          nextStep: "conversation",
          defaultRoute: "/operator#conversation",
          activated: true,
          operation: "calendar_limited",
          capabilities: { ai: "ready", calendar: "ready", mail: "not_offered", core: "missing" },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: true,
            processingConsent: true,
            firstBriefReady: true,
            primarySuiteIdentity: "google-owner-preview",
          },
        } satisfies FounderOnboardingDto,
        ownerPreviewAdmitted: true,
        ownerPreviewWorkAllowed: false,
      }),
    );

    expect(html).toContain("Some new work is paused");
    expect(html).toContain('aria-label="Current Founder workspace"');
    expect(html).toContain("What should we handle today?");
  });

  it("shows the attended Trusted Preview Learning Round without hidden capabilities", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        ownerPreviewAdmitted: true,
        ownerPreviewWorkAllowed: true,
        ownerPreview: {
          stage: "Trusted Preview",
          state: "active",
          availableCapabilities: ["OpenAI", "Calendar reading"],
          supportBoundary: "Attended onboarding and observation",
          evidenceClassification: "Learning Round",
          automaticPromotion: false,
          founderAcceptanceEligible: false,
          cohortSlot: 2,
        },
        openAiReleased: true,
        calendarReadingReleased: true,
        mailReadingReleased: true,
        mailSendingReleased: true,
      }),
    );

    expect(html).toContain("Trusted Preview");
    expect(html).toContain("Available now: OpenAI and Calendar reading.");
    expect(html).toContain("attended onboarding and observation");
    expect(html).toContain("cannot become Founder Acceptance Evidence");
    expect(html).not.toMatch(/Gmail|Anthropic|Core Operation/);
  });

  it("presents an identity-bound Trusted Preview invitation instead of open admission", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        trustedPreviewInvitationToken: "A".repeat(43),
      }),
    );

    expect(html).toContain("Trusted Preview is waiting for current protection");
    expect(html).toContain("Accept Trusted Preview invitation");
    expect(html).not.toContain("Enter Owner Preview");
  });

  it("preserves safe workspace checkpoints when the admitted runtime needs attention", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
          },
          runtime: {
            status: "needs_attention",
            recoveryMessage: "Runtime recovery is required.",
          },
        },
        initialOnboarding: {
          nextStep: "conversation",
          defaultRoute: "/operator#conversation",
          activated: true,
          operation: "calendar_limited",
          capabilities: { ai: "ready", calendar: "ready", mail: "not_offered", core: "missing" },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: false,
            processingConsent: true,
            firstBriefReady: true,
            primarySuiteIdentity: "google-owner-preview",
          },
        } satisfies FounderOnboardingDto,
        ownerPreviewAdmitted: true,
        ownerPreviewWorkAllowed: false,
      }),
    );

    expect(html).toContain("Some new work is paused");
    expect(html).toContain('aria-label="Current Founder workspace"');
    expect(html).toContain("What should we handle today?");
  });

  it("keeps OpenAI hidden until current Connected Acceptance releases it", () => {
    const readyOperator: FounderOperatorDto = {
      ...OPERATOR,
      preparation: {
        ...OPERATOR.preparation,
        status: "ready",
        timezone: "Asia/Manila",
        timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
      },
      runtime: { status: "ready", recoveryMessage: null },
    };
    const hidden = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
      }),
    );
    const released = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
        openAiReleased: true,
      }),
    );

    expect(hidden).not.toContain("Your AI Connection");
    expect(released).toContain("Your AI Connection");
  });

  it("opens an activated workspace on Conversation and Needs you before setup", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
            startedAt: "2026-08-18T01:00:00.000Z",
            completedAt: "2026-08-18T01:00:01.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        initialOnboarding: {
          nextStep: "conversation",
          defaultRoute: "/operator#conversation",
          activated: true,
          operation: "core",
          capabilities: {
            ai: "ready",
            calendar: "ready",
            mail: "ready",
            core: "ready",
          },
          facts: {
            timezoneConfirmed: true,
            runtimeReady: true,
            processingConsent: true,
            firstBriefReady: true,
            primarySuiteIdentity: "founder@example.com",
          },
        } satisfies FounderOnboardingDto,
        ownerPreviewAdmitted: true,
      }),
    );

    expect(html).toContain('id="conversation"');
    expect(html).toContain('id="needs-you"');
    expect(html.indexOf('id="conversation"')).toBeLessThan(
      html.indexOf('id="onboarding-timezone"'),
    );
    expect(html.indexOf('id="needs-you"')).toBeLessThan(html.indexOf('id="onboarding-timezone"'));
  });

  it("presents Calendar access as a reviewed, founder-selected connection", () => {
    const html = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: {
          ...OPERATOR,
          preparation: {
            ...OPERATOR.preparation,
            status: "ready",
            timezone: "Asia/Manila",
            timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
            startedAt: "2026-08-18T01:00:00.000Z",
            completedAt: "2026-08-18T01:00:01.000Z",
          },
          runtime: { status: "ready", recoveryMessage: null },
        },
        ownerPreviewAdmitted: true,
        calendarReadingReleased: true,
      }),
    );

    expect(html).toContain("Your Calendar Connection");
    expect(html).toContain("read-only Calendar access");
    expect(html).toContain("Google Calendar data remains in Google");
    expect(html).not.toContain("Telegram");
    expect(html).not.toContain("WhatsApp");
  });

  it("keeps Gmail reading hidden throughout Calendar-only Owner Preview", () => {
    const readyOperator: FounderOperatorDto = {
      ...OPERATOR,
      preparation: {
        ...OPERATOR.preparation,
        status: "ready",
        timezone: "Asia/Manila",
        timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
      },
      runtime: { status: "ready", recoveryMessage: null },
    };
    const hidden = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
      }),
    );
    const calendarOnly = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
        calendarReadingReleased: true,
      }),
    );
    const mailOnly = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
        mailReadingReleased: true,
        mailReleaseControls: {
          qualified: true,
          requiredScope: "https://www.googleapis.com/auth/gmail.readonly",
          disclosure: "bounded",
          retentionDays: 90,
          deletion: "staged",
          aiLimitedUse: "bounded",
        },
      }),
    );

    expect(hidden).not.toContain("Your Calendar Connection");
    expect(hidden).not.toContain("Your Mail Connection");
    expect(calendarOnly).toContain("Your Calendar Connection");
    expect(calendarOnly).not.toContain("Your Mail Connection");
    expect(mailOnly).not.toContain("Your Calendar Connection");
    expect(mailOnly).not.toContain("Your Mail Connection");
    expect(mailOnly).not.toMatch(/Gmail|Anthropic|Core Operation/);
    expect(mailOnly).toContain("Support is fully attended");
  });

  it("keeps Gmail sending hidden even when its separate release evidence passes", () => {
    const readyOperator: FounderOperatorDto = {
      ...OPERATOR,
      preparation: {
        ...OPERATOR.preparation,
        status: "ready",
        timezone: "Asia/Manila",
        timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
      },
      runtime: { status: "ready", recoveryMessage: null },
    };
    const hidden = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
      }),
    );
    const released = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        ownerPreviewAdmitted: true,
        mailSendingReleased: true,
      }),
    );

    expect(hidden).not.toContain("Optional Mail Sending Connection");
    expect(released).not.toContain("Optional Mail Sending Connection");
    expect(released).not.toContain("Review send-only Gmail");
  });
});
