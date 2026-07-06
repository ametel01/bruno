"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AgentBackupSummary } from "@/src/server/backups/list-backups";

type AgentBackupControlsProps = {
  agentId: string;
  backups: AgentBackupSummary[];
};

type BackupActionState =
  | { status: "idle" }
  | { status: "creating" }
  | { status: "restoring"; backupId: string }
  | { status: "success"; message: string; restoredAgent?: RestoredAgentLink }
  | { status: "error"; message: string };

type RestoredAgentLink = {
  id: string;
  name: string;
};

export function AgentBackupControls({ agentId, backups }: AgentBackupControlsProps) {
  const router = useRouter();
  const [state, setState] = useState<BackupActionState>({ status: "idle" });
  const creating = state.status === "creating";

  async function handleCreateBackup() {
    setState({ status: "creating" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/backups`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({
          status: "error",
          message: await safeBackupFailureMessage(response, "Manual backup could not be created."),
        });
        router.refresh();
        return;
      }

      setState({ status: "success", message: "Manual backup created." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Manual backup could not be created." });
    }
  }

  async function handleRestoreBackup(backupId: string) {
    setState({ status: "restoring", backupId });

    try {
      const response = await fetch(
        `/api/agents/${encodeURIComponent(agentId)}/backups/${encodeURIComponent(backupId)}/restore`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        setState({
          status: "error",
          message: await safeBackupFailureMessage(response, "Backup could not be restored."),
        });
        router.refresh();
        return;
      }

      const restoredAgent = await safeRestoredAgentLink(response);
      setState(
        restoredAgent
          ? {
              status: "success",
              message: `Restored ${restoredAgent.name}.`,
              restoredAgent,
            }
          : {
              status: "success",
              message: "Backup restored. Refresh the agent list to inspect the restored agent.",
            },
      );
      router.refresh();
    } catch {
      setState({ status: "error", message: "Backup could not be restored." });
    }
  }

  return (
    <div className="backup-controls">
      <button
        className="secondary-button"
        type="button"
        disabled={creating || state.status === "restoring"}
        onClick={handleCreateBackup}
      >
        {creating ? "Creating backup" : "Create backup"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <div className={`form-message ${state.status}`} role="status">
          <span>{state.message}</span>
          {state.status === "success" && state.restoredAgent ? (
            <Link href={`/agents/${state.restoredAgent.id}`}>Open restored agent</Link>
          ) : null}
        </div>
      ) : null}
      {backups.length > 0 ? (
        <ol className="backup-list">
          {backups.map((backup) => {
            const restoring = state.status === "restoring" && state.backupId === backup.id;

            return (
              <li className="backup-item" key={backup.id}>
                <div className="backup-item-header">
                  <span className="status-pill">{backup.status}</span>
                  {backup.canRestore ? (
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={state.status === "creating" || state.status === "restoring"}
                      onClick={() => handleRestoreBackup(backup.id)}
                    >
                      {restoring ? "Restoring" : "Restore backup"}
                    </button>
                  ) : null}
                </div>
                <dl className="definition-list compact-definition-list">
                  <div>
                    <dt>Created</dt>
                    <dd>
                      <time dateTime={backup.createdAt}>{backup.createdAt}</time>
                    </dd>
                  </div>
                  <div>
                    <dt>Restored</dt>
                    <dd>
                      {backup.restoredAt ? (
                        <time dateTime={backup.restoredAt}>{backup.restoredAt}</time>
                      ) : (
                        "Not restored"
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Backup ID</dt>
                    <dd>
                      <code>{backup.id}</code>
                    </dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="activity-empty-state">
          <h3>No backups yet</h3>
          <p>Create a manual backup to capture this agent's current safe configuration metadata.</p>
        </div>
      )}
    </div>
  );
}

async function safeBackupFailureMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "agent_not_found" || body.error?.code === "backup_not_found") {
      return "Agent or backup could not be found.";
    }

    if (body.error?.code === "backup_not_restorable") {
      return "Backup is not ready to restore.";
    }

    if (
      body.error?.code === "backup_storage_failed" ||
      body.error?.code === "backup_storage_not_configured"
    ) {
      return "Backup storage is unavailable. Check backup storage configuration.";
    }

    if (body.error?.code === "backup_artifact_invalid") {
      return "Backup artifact could not be validated. Create a new backup and retry.";
    }
  } catch {
    // Keep client-visible failures generic when the response is not safe JSON.
  }

  return fallback;
}

async function safeRestoredAgentLink(response: Response): Promise<RestoredAgentLink | undefined> {
  try {
    const body = (await response.json()) as {
      restoredAgent?: {
        id?: unknown;
        name?: unknown;
      };
    };

    if (typeof body.restoredAgent?.id !== "string" || typeof body.restoredAgent.name !== "string") {
      return undefined;
    }

    return {
      id: body.restoredAgent.id,
      name: body.restoredAgent.name,
    };
  } catch {
    return undefined;
  }
}
