import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderOperatorPreparation } from "@/app/operator/_components/founder-operator-preparation";
import { FounderOperatorShell } from "@/app/operator/_components/founder-operator-shell";
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
});
