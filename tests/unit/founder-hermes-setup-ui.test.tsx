import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FounderHermesSetup } from "@/app/operator/_components/founder-hermes-setup";

describe("Founder Full Hermes Setup UI", () => {
  it("starts desktop-gated and does not expose a terminal before a session exists", () => {
    const html = renderToStaticMarkup(createElement(FounderHermesSetup));

    expect(html).toContain("Full Hermes Setup");
    expect(html).toContain("Desktop required");
    expect(html).toContain("Resize to a desktop window to continue.");
    expect(html).not.toContain('class="hermes-setup-terminal"');
  });

  it("keeps the browser transport tied to the guarded session contract", async () => {
    const source = await readFile(
      resolve(process.cwd(), "app/operator/_components/founder-hermes-setup.tsx"),
      "utf8",
    );

    expect(source).toContain('fetch("/api/operator/troubleshooting/hermes-setup-session"');
    expect(source).toContain('"X-Bruno-Viewport-Width": String(window.innerWidth)');
    expect(source).toContain("new WebSocket(session.websocketUrl, [session.websocketProtocol])");
    expect(source).toContain('JSON.stringify({ type: "input", data })');
    expect(source).toContain('status: "completed"');
    expect(source).toContain('status: "error"');
  });
});
