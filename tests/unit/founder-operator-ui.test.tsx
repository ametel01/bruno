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
      }),
    );

    expect(html).toContain("Bruno Conversation");
    expect(html).toContain("What should we handle today?");
    expect(html).toContain("Conversation is saved across reloads and devices.");
    expect(html).toContain('id="needs-you"');
    expect(html).not.toContain("Telegram");
    expect(html).not.toContain("WhatsApp");
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
      createElement(FounderOperatorPreparation, { initialOperator: readyOperator }),
    );
    const released = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
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
        calendarReadingReleased: true,
      }),
    );

    expect(html).toContain("Your Calendar Connection");
    expect(html).toContain("read-only Calendar access");
    expect(html).toContain("Google Calendar data remains in Google");
    expect(html).not.toContain("Telegram");
    expect(html).not.toContain("WhatsApp");
  });

  it("keeps Calendar and Gmail reading independently hidden until each acceptance passes", () => {
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
      createElement(FounderOperatorPreparation, { initialOperator: readyOperator }),
    );
    const calendarOnly = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
        calendarReadingReleased: true,
      }),
    );
    const mailOnly = renderToStaticMarkup(
      createElement(FounderOperatorPreparation, {
        initialOperator: readyOperator,
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
    expect(mailOnly).toContain("Your Mail Connection");
  });
});
