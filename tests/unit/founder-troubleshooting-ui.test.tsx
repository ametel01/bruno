import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
import { FounderTroubleshooting } from "@/app/operator/_components/founder-troubleshooting";
import type { FounderTroubleshootingDto } from "@/src/server/operators/founder-troubleshooting";

const TROUBLESHOOTING: FounderTroubleshootingDto = {
  help: {
    capability: "ai",
    state: "recovery_exhausted",
    title: "AI responses need troubleshooting",
    impact: "AI responses are paused after Bruno reached its safe recovery limit.",
    action: { label: "Review AI access", href: "/operator#connections" },
    technicalEvidenceAvailable: true,
    incidentId: "incident-1",
  },
  incidents: [
    {
      id: "incident-1",
      title: "AI responses troubleshooting",
      capability: "ai",
      impactSummary: "AI responses are paused after Bruno reached its safe recovery limit.",
      affectedCapabilities: ["AI responses"],
      unaffectedCapabilities: ["Calendar evidence", "Mail reading"],
      status: "open",
      openedAt: "2026-08-20T00:00:00.000Z",
      closedAt: null,
      evidenceExpiresAt: "2026-09-03T00:00:00.000Z",
      supportCase: "not_attached",
      evidence: [
        {
          kind: "recovery_summary",
          payload: {
            capability: "ai",
            state: "recovery_exhausted",
            attemptCount: 3,
            maxAttempts: 3,
            elapsedMs: 900_000,
            maxElapsedMs: 900_000,
          },
          capturedAt: "2026-08-20T00:00:00.000Z",
          expiresAt: "2026-09-03T00:00:00.000Z",
        },
      ],
    },
  ],
};

describe("Founder Troubleshooting surface", () => {
  it("keeps troubleshooting absent from ordinary navigation and renders a founder-readable incident", () => {
    function Surface() {
      return (
        <FounderOperatorShell activePage="troubleshooting">
          <FounderTroubleshooting initialTroubleshooting={TROUBLESHOOTING} />
        </FounderOperatorShell>
      );
    }
    const html = renderToStaticMarkup(createElement(Surface));
    expect(html).toContain("Keep the business moving");
    expect(html).toContain("Troubleshooting Evidence");
    expect(html).toContain("Affected");
    expect(html).toContain("Unaffected");
    expect(html).toContain("Approve support case");
    expect(html).not.toContain("Troubleshooting</span>");
    expect(html.toLowerCase()).not.toMatch(/provider|prompt|recipient|credential|endpoint/);
  });

  it("has a phone layout that stacks impact and incident actions", () => {
    const stylesheet = readFileSync(
      fileURLToPath(
        new URL(
          "../../app/operator/_components/founder-troubleshooting.module.css",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    expect(stylesheet).toContain("@media (max-width: 40rem)");
    expect(stylesheet).toContain("grid-template-columns: 1fr");
    expect(stylesheet).toContain(".actions button");
  });
});
