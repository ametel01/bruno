"use client";

import type { FitAddon as XtermFitAddon } from "@xterm/addon-fit";
import type { Terminal as XtermTerminal } from "@xterm/xterm";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { HermesSetupReadiness } from "@/src/shared/hermes-readiness-types";

type AgentHermesSetupProps = {
  agentId: string;
  readiness: HermesSetupReadiness;
};

type SetupState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "connecting" }
  | { status: "running" }
  | { status: "completed" }
  | { status: "error"; message: string };

type SetupSessionResponse = {
  ok: true;
  session: {
    websocketUrl: string;
    websocketProtocol: string;
    expiresAt: string;
  };
};

export function AgentHermesSetup({ agentId, readiness }: AgentHermesSetupProps) {
  const router = useRouter();
  const terminalHostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<XtermTerminal | null>(null);
  const fitAddonRef = useRef<XtermFitAddon | null>(null);
  const setupInFlightRef = useRef(false);
  const socketRef = useRef<WebSocket | null>(null);
  const [state, setState] = useState<SetupState>({ status: "idle" });
  const sessionActive = ["creating", "connecting", "running"].includes(state.status);

  useEffect(() => {
    return () => {
      socketRef.current?.close(1000, "Setup view closed.");
      terminalRef.current?.dispose();
    };
  }, []);

  useEffect(() => {
    if (!sessionActive || !terminalHostRef.current || !fitAddonRef.current) {
      return;
    }

    const resizeTerminal = () => {
      fitAddonRef.current?.fit();
      const terminal = terminalRef.current;
      const socket = socketRef.current;

      if (terminal && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    };
    const observer = new ResizeObserver(resizeTerminal);
    observer.observe(terminalHostRef.current);
    resizeTerminal();

    return () => observer.disconnect();
  }, [sessionActive]);

  async function openSetup() {
    if (setupInFlightRef.current) {
      return;
    }

    setupInFlightRef.current = true;
    closeCurrentSession();
    setState({ status: "creating" });

    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/hermes-setup-session`,
        { method: "POST", headers: { Accept: "application/json" } },
      );

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      const body: unknown = await response.json();

      if (!isSetupSessionResponse(body)) {
        setState({ status: "error", message: "Hermes setup returned an invalid response." });
        return;
      }

      setState({ status: "connecting" });
      await connectTerminal(body.session);
    } catch {
      setState({ status: "error", message: "Hermes setup could not be opened." });
    } finally {
      setupInFlightRef.current = false;
    }
  }

  async function connectTerminal(session: SetupSessionResponse["session"]) {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ]);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const host = terminalHostRef.current;

    if (!host) {
      throw new Error("Terminal host is unavailable.");
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      scrollback: 4_000,
      theme: {
        background: "#111310",
        foreground: "#f0f2ed",
        cursor: "#e5ff6f",
        selectionBackground: "#495141",
      },
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
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data }));
      }
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
        router.refresh();
      } else if (message?.type === "status" && message.status === "failed") {
        setState({ status: "error", message: "Hermes setup did not complete." });
      }
    });
    socket.addEventListener("error", () => {
      setState({ status: "error", message: "The Hermes setup connection failed." });
    });
    socket.addEventListener("close", (event) => {
      if (event.code !== 1000 && state.status !== "completed") {
        setState({ status: "error", message: "The Hermes setup session closed early." });
      }
    });
  }

  function closeCurrentSession() {
    socketRef.current?.close(1000, "Setup restarted.");
    socketRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitAddonRef.current = null;

    if (terminalHostRef.current) {
      terminalHostRef.current.replaceChildren();
    }
  }

  return (
    <section className="hermes-setup-panel" aria-labelledby="hermes-setup-title">
      <div className="section-heading">
        <h2 id="hermes-setup-title">Advanced Hermes setup</h2>
        <span>{readiness.runnerReady ? "Runner ready" : "Runner unavailable"}</span>
      </div>
      <div className="hermes-native-setup">
        <div className="hermes-native-setup-toolbar">
          <button
            className="secondary-button"
            disabled={!readiness.runnerReady || sessionActive}
            type="button"
            onClick={openSetup}
          >
            {sessionActive ? "Setup active" : "Open advanced setup"}
          </button>
          {state.status === "completed" ? (
            <span className="form-message success" role="status">
              Advanced setup completed.
            </span>
          ) : null}
          {state.status === "error" ? (
            <span className="form-message error" role="alert">
              {state.message}
            </span>
          ) : null}
        </div>
        <p className="form-helper">
          Managed provider, model, API server, Telegram access, terminal, browser, safety, and
          managed environment settings are reapplied on the next Start or Restart. Unrelated
          advanced Hermes settings are preserved.
        </p>
        {sessionActive || state.status === "completed" || state.status === "error" ? (
          <div
            className="hermes-setup-terminal"
            ref={terminalHostRef}
            role="application"
            aria-label="Hermes setup terminal"
          />
        ) : null}
      </div>
    </section>
  );
}

function isSetupSessionResponse(value: unknown): value is SetupSessionResponse {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.session)) {
    return false;
  }

  return (
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
  if (typeof value !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(value);

    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    if (parsed.type === "output" && typeof parsed.data === "string") {
      return { type: "output", data: parsed.data };
    }

    if (parsed.type === "status" && typeof parsed.status === "string") {
      return { type: "status", status: parsed.status };
    }
  } catch {
    return null;
  }

  return null;
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string" &&
      !looksUnsafe(body.error.message)
    ) {
      return body.error.message;
    }
  } catch {
    // Keep malformed or unsafe failures generic.
  }

  return "Hermes setup could not be opened.";
}

function looksUnsafe(message: string): boolean {
  return /(sk-|token=|authorization|bearer|bruno\.hermes\.setup\.)/i.test(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
