"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { summarizeOperationalText } from "@/src/server/alerts/operational-summaries";
import type { AgentLifecycleStatus } from "@/src/server/agents/lifecycle";

type AgentRuntimeLogPanelProps = {
  agentId: string;
  status: AgentLifecycleStatus;
};

type RuntimeLog = {
  id: string;
  createdAt: string;
  stream: string;
  level: string;
  sequence: number;
  message: string;
};

type RuntimeLogPage = {
  logs: RuntimeLog[];
  nextAfter: number | null;
};

type LoadState = "loading" | "loaded" | "error";

const POLLABLE_LOG_STATUSES = new Set<AgentLifecycleStatus>(["running"]);
const RUNTIME_LOG_POLL_INTERVAL_MS = 1_500;
const LATEST_LOG_SUMMARY_LIMIT = 6;

export function AgentRuntimeLogPanel({ agentId, status }: AgentRuntimeLogPanelProps) {
  const [logs, setLogs] = useState<RuntimeLog[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const nextAfterRef = useRef<number | null>(null);
  const inFlightRef = useRef(false);

  const loadLogs = useCallback(
    async ({ after, replace }: { after: number | null; replace: boolean }) => {
      if (inFlightRef.current) {
        return;
      }

      inFlightRef.current = true;

      if (replace) {
        setLoadState("loading");
      }

      try {
        const requestUrl = new URL(
          `/api/agents/${encodeURIComponent(agentId)}/logs`,
          location.href,
        );
        requestUrl.searchParams.set("limit", "100");

        if (after !== null) {
          requestUrl.searchParams.set("after", String(after));
        }

        const response = await fetch(requestUrl, {
          headers: {
            Accept: "application/json",
          },
        });

        if (!response.ok) {
          setLoadState("error");
          return;
        }

        const page = parseRuntimeLogPage(await response.json());
        nextAfterRef.current = page.nextAfter;
        setLogs((currentLogs) => {
          if (replace) {
            return page.logs;
          }

          if (page.logs.length === 0) {
            return currentLogs;
          }

          const seenLogIds = new Set(currentLogs.map((log) => log.id));
          const newLogs = page.logs.filter((log) => !seenLogIds.has(log.id));

          return [...currentLogs, ...newLogs];
        });
        setLoadState("loaded");
      } catch {
        setLoadState("error");
      } finally {
        inFlightRef.current = false;
      }
    },
    [agentId],
  );

  useEffect(() => {
    setLogs([]);
    nextAfterRef.current = null;
    void loadLogs({ after: null, replace: true });
  }, [loadLogs]);

  useEffect(() => {
    if (!POLLABLE_LOG_STATUSES.has(status)) {
      return;
    }

    void loadLogs({ after: nextAfterRef.current, replace: false });

    const intervalId = window.setInterval(() => {
      void loadLogs({ after: nextAfterRef.current, replace: false });
    }, RUNTIME_LOG_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadLogs, status]);

  const latestLogSummaries = logs.slice(-LATEST_LOG_SUMMARY_LIMIT).reverse();

  return (
    <section className="runtime-log-panel" aria-labelledby="agent-runtime-log-title">
      <div className="section-heading">
        <h2 id="agent-runtime-log-title">Latest log summaries</h2>
        {loadState !== "error" ? (
          <span>
            {latestLogSummaries.length}
            {logs.length > latestLogSummaries.length ? ` of ${logs.length}` : ""} shown
          </span>
        ) : null}
      </div>
      {loadState === "loading" ? (
        <div className="activity-loading-state" role="status">
          <p>Loading runtime logs.</p>
        </div>
      ) : null}
      {loadState === "error" ? (
        <div className="safe-error" role="alert">
          Runtime logs could not be loaded.
        </div>
      ) : null}
      {loadState !== "loading" && logs.length === 0 && loadState !== "error" ? (
        <div className="activity-empty-state">
          <h3>No runtime logs yet</h3>
          <p>Start this agent to show the local simulator output.</p>
        </div>
      ) : null}
      {logs.length > 0 ? (
        <ol className="runtime-log-list" aria-label="Latest runtime log summaries">
          {latestLogSummaries.map((log) => (
            <li className="runtime-log-item" key={log.id}>
              <div className="runtime-log-header">
                <time dateTime={log.createdAt}>{log.createdAt}</time>
                <span>#{log.sequence}</span>
              </div>
              <p>{summarizeOperationalText(log.message, "Log details omitted.")}</p>
              <dl className="runtime-log-metadata">
                <div>
                  <dt>Stream</dt>
                  <dd>{log.stream}</dd>
                </div>
                <div>
                  <dt>Level</dt>
                  <dd>{log.level}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function parseRuntimeLogPage(value: unknown): RuntimeLogPage {
  if (!isRecord(value) || !Array.isArray(value.logs)) {
    throw new Error("Invalid runtime log page.");
  }

  const nextAfter = value.nextAfter;

  if (nextAfter !== null && !isSafeSequence(nextAfter)) {
    throw new Error("Invalid runtime log cursor.");
  }

  return {
    logs: value.logs.map(parseRuntimeLog),
    nextAfter,
  };
}

function parseRuntimeLog(value: unknown): RuntimeLog {
  if (!isRecord(value)) {
    throw new Error("Invalid runtime log.");
  }

  const { id, createdAt, stream, level, sequence, message } = value;

  if (
    typeof id !== "string" ||
    typeof createdAt !== "string" ||
    typeof stream !== "string" ||
    typeof level !== "string" ||
    typeof message !== "string" ||
    !isSafeSequence(sequence)
  ) {
    throw new Error("Invalid runtime log fields.");
  }

  return {
    id,
    createdAt,
    stream,
    level,
    sequence,
    message,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeSequence(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
