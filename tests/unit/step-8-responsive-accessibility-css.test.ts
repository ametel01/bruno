import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let css = "";

beforeAll(async () => {
  css = await readFile("app/globals.css", "utf8");
});

describe("Step 8 responsive and accessibility CSS", () => {
  it("lets creation and progress children shrink and wrap without horizontal overflow", () => {
    const shellMobileCss = cssBlock(css, "@media (max-width: 860px)");

    expect(shellMobileCss).toMatch(
      /\.app-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    expect(shellMobileCss).toMatch(/\.app-sidebar\s*\{[^}]*min-width:\s*0;/);
    expect(shellMobileCss).toMatch(/\.shell-main\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(
      /\.agent-create-mode-fieldset,\s*\.ready-credential-fieldset\s*\{[^}]*min-width:\s*0;/,
    );
    expect(css).toMatch(/\.agent-deployment-progress-card\s*\{[^}]*min-width:\s*0;[^}]*\}/);
    expect(css).toMatch(/\.agent-deployment-progress-header\s*\{[^}]*flex-wrap:\s*wrap;[^}]*\}/);
    expect(css).toMatch(/\.agent-deployment-progress-header > \*\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.deployment-stage-list\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.deployment-stage-list li\s*\{[^}]*min-width:\s*0;/);
    expect(css).toMatch(/\.deployment-stage-list li strong\s*\{[^}]*overflow-wrap:\s*anywhere;/);
  });

  it("collapses credentials and exposes the persisted status card at the mobile breakpoint", () => {
    const mobileCss = cssBlock(css, "@media (max-width: 720px)", true);

    expect(mobileCss).toMatch(
      /\.ready-credential-fieldset\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/,
    );
    expect(mobileCss).toMatch(
      /\.mobile-agent-card > \.deployment-status-summary\s*\{[^}]*display:\s*flex;[^}]*width:\s*100%;/,
    );
    expect(css).toMatch(/\.mobile-agent-list\s*\{[^}]*display:\s*grid;/);
  });

  it("uses full-width narrow controls with the repository touch and focus treatment", () => {
    const narrowCss = cssBlock(css, "@media (max-width: 460px)");

    expect(css).toMatch(/\.segmented-control button\s*\{[^}]*min-height:\s*42px;/);
    expect(css).toMatch(/\.deployment-status-link\s*\{[^}]*min-height:\s*42px;/);
    expect(css).toMatch(
      /\.advanced-runner-select summary,\s*\.advanced-hermes-recovery summary\s*\{[^}]*min-height:\s*42px;/,
    );
    expect(css).toMatch(
      /\.advanced-runner-select summary:focus-visible,\s*\.advanced-hermes-recovery summary:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--accent\);/,
    );
    expect(narrowCss).toMatch(
      /\.agent-creation-actions > \.primary-button,\s*\.agent-creation-actions > \.secondary-button,\s*\.deployment-progress-actions > button\s*\{[^}]*width:\s*100%;/,
    );
    expect(narrowCss).toMatch(/\.mobile-agent-card-header\s*\{[^}]*flex-wrap:\s*wrap;/);
  });

  it("does not use decorative motion for creation or persisted progress", () => {
    const stepEightCss = css.slice(css.indexOf(".agent-create-mode-fieldset"));

    expect(stepEightCss).not.toMatch(/\banimation(?:-[\w-]+)?\s*:/i);
    expect(stepEightCss).not.toMatch(/\btransition(?:-[\w-]+)?\s*:/i);
  });
});

function cssBlock(source: string, marker: string, last = false): string {
  const start = last ? source.lastIndexOf(marker) : source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);

  const openingBrace = source.indexOf("{", start);
  let depth = 0;

  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") {
      depth += 1;
    } else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Unclosed CSS block: ${marker}`);
}
