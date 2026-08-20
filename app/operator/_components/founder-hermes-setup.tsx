"use client";

import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

type SetupState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "connecting" }
  | { status: "running" }
  | { status: "completed" }
  | { status: "error"; message: string };

type SetupSession = {
  id: string;
  websocketUrl: string;
  websocketProtocol: string;
  expiresAt: string;
};

export function FounderHermesSetup() {
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const inFlightRef = useRef(false);
  const [state, setState] = useState<SetupState>({ status: "idle" });
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  const sessionActive = ["creating", "connecting", "running"].includes(state.status);
  const desktopReady = viewportWidth !== null && viewportWidth >= 1024;

  useEffect(() => {
    const updateViewport = () => setViewportWidth(window.innerWidth);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => {
      window.removeEventListener("resize", updateViewport);
      socketRef.current?.close(1000, "Troubleshooting view closed.");
      terminalRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!sessionActive || !terminalHostRef.current || !fitAddonRef.current) return;
    const resize = () => {
      fitAddonRef.current?.fit();
      const terminal = terminalRef.current;
      const socket = socketRef.current;
      if (terminal && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(terminalHostRef.current);
    resize();
    return () => observer.disconnect();
  }, [sessionActive]);

  async function openSetup() {
    if (inFlightRef.current || !desktopReady) return;
    inFlightRef.current = true;
    closeCurrentSession();
    setState({ status: "creating" });
    try {
      const response = await fetch("/api/operator/troubleshooting/hermes-setup-session", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "X-Bruno-Viewport-Width": String(window.innerWidth),
        },
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setState({ status: "error", message: safeFailureMessage(body) });
        return;
      }
      if (!isSetupSession(body)) {
        setState({ status: "error", message: "Full Hermes Setup returned an invalid response." });
        return;
      }
      setState({ status: "connecting" });
      await connectTerminal(body);
    } catch {
      setState({ status: "error", message: "Full Hermes Setup could not be opened." });
    } finally {
      inFlightRef.current = false;
    }
  }

  async function connectTerminal(session: SetupSession) {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const host = terminalHostRef.current;
    if (!host) throw new Error("Terminal host is unavailable.");
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 4_000,
      theme: { background: "#111310", foreground: "#f0f2ed", cursor: "#e5ff6f" },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    const socket = new WebSocket(session.websocketUrl, [session.websocketProtocol]);
    socketRef.current = socket;
    terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "input", data }));
    });
    socket.addEventListener("open", () => {
      setState({ status: "running" });
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
    });
    socket.addEventListener("message", (event) => {
      const message = parseSocketMessage(event.data);
      if (message?.type === "output") {
        terminal.write(Uint8Array.from(atob(message.data), (character) => character.charCodeAt(0)));
      } else if (message?.type === "status" && message.status === "completed") {
        setState({ status: "completed" });
      } else if (message?.type === "status" && message.status === "failed") {
        setState({ status: "error", message: "Full Hermes Setup did not complete." });
      }
    });
    socket.addEventListener("error", () =>
      setState({ status: "error", message: "The Full Hermes Setup connection failed." }),
    );
    socket.addEventListener("close", (event) => {
      if (event.code !== 1000 && state.status !== "completed") {
        setState({ status: "error", message: "The Full Hermes Setup session closed early." });
      }
    });
  }

  function closeCurrentSession() {
    socketRef.current?.close(1000, "Setup restarted.");
    socketRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;
    terminalHostRef.current?.replaceChildren();
  }

  return (
    <section className="hermes-setup-panel" aria-labelledby="founder-hermes-setup-title">
      <div className="section-heading">
        <h3 id="founder-hermes-setup-title">Full Hermes Setup</h3>
        <span>{desktopReady ? "Desktop ready" : "Desktop required"}</span>
      </div>
      <p className="form-helper">
        Exceptional Founder troubleshooting only. The Operator must be stopped and you must sign in
        again before opening this 15-minute session. Support access never includes this terminal.
      </p>
      <div className="hermes-native-setup-toolbar">
        <button
          className="secondary-button"
          type="button"
          disabled={!desktopReady || sessionActive}
          onClick={() => void openSetup()}
        >
          {sessionActive ? "Setup active" : "Open Full Hermes Setup"}
        </button>
        {!desktopReady ? (
          <span className="form-helper">Resize to a desktop window to continue.</span>
        ) : null}
        {state.status === "completed" ? (
          <span className="form-message success">Setup completed.</span>
        ) : null}
        {state.status === "error" ? (
          <span className="form-message error" role="alert">
            {state.message}
          </span>
        ) : null}
      </div>
      {sessionActive || state.status === "completed" || state.status === "error" ? (
        <div
          className="hermes-setup-terminal"
          ref={terminalHostRef}
          role="application"
          aria-label="Full Hermes setup terminal"
        />
      ) : null}
    </section>
  );
}

function isSetupSession(value: unknown): value is SetupSession {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.session)) return false;
  return (
    typeof value.session.id === "string" &&
    typeof value.session.websocketUrl === "string" &&
    /^wss?:\/\//.test(value.session.websocketUrl) &&
    typeof value.session.websocketProtocol === "string" &&
    value.session.websocketProtocol.startsWith("bruno.hermes.setup.") &&
    typeof value.session.expiresAt === "string"
  );
}

function parseSocketMessage(
  value: unknown,
): { type: "output"; data: string } | { type: "status"; status: string } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
    if (parsed.type === "output" && typeof parsed.data === "string")
      return { type: "output", data: parsed.data };
    if (parsed.type === "status" && typeof parsed.status === "string")
      return { type: "status", status: parsed.status };
  } catch {
    return null;
  }
  return null;
}

function safeFailureMessage(value: unknown): string {
  if (isRecord(value) && isRecord(value.error) && typeof value.error.message === "string") {
    const message = value.error.message;
    if (!/(sk-|token=|authorization|bearer|bruno\.hermes\.setup\.)/i.test(message)) return message;
  }
  return "Full Hermes Setup could not be opened.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
