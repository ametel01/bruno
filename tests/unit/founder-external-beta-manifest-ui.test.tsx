import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderExternalBetaManifest } from "@/app/operator/_components/founder-external-beta-manifest";
import { projectFounderExternalBetaManifestStatus } from "@/src/server/founder-product-contract/external-beta-manifest";

describe("Founder External Beta manifest", () => {
  it("shows independent plain-language capability state without technical evidence", () => {
    const html = renderToStaticMarkup(
      <FounderExternalBetaManifest
        status={projectFounderExternalBetaManifestStatus({
          complete: false,
          qualifiedCapabilities: [
            "anthropic",
            "calendar_reading",
            "gmail_reading",
            "gmail_sending",
          ],
          unavailableCapabilities: ["openai"],
        })}
      />,
    );

    expect(html).toContain("External Beta");
    expect(html).toContain("OpenAI</dt><dd>Paused");
    expect(html).toContain("Anthropic</dt><dd>Available");
    expect(html).toContain("Gmail reading</dt><dd>Available");
    expect(html).toContain("one-to-one Gmail sending</dt><dd>Available");
    expect(html).toContain("Bruno uses only the provider accounts you connect");
    expect(html).toContain("Unaffected work stays available from a safe checkpoint");
    expect(html).not.toMatch(/model|credential|token|runner|hermes|digest|revision/i);
  });
});
