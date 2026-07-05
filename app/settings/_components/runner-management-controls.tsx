"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RunnerRegistrationSecret = {
  token: string;
  expiresAt: string;
};

type RunnerCredentialSecret = {
  token: string;
  rotatedAt: string;
};

type RequestState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type RegistrationState = RequestState & {
  secret?: RunnerRegistrationSecret;
};

type CredentialState = RequestState & {
  secret?: RunnerCredentialSecret;
};

type RunnerRegistrationTokenControlsProps = {
  disabled?: boolean;
};

type RunnerCredentialControlsProps = {
  runnerId: string;
  runnerName: string;
};

export function RunnerRegistrationTokenControls({
  disabled = false,
}: RunnerRegistrationTokenControlsProps) {
  const [state, setState] = useState<RegistrationState>({ status: "idle" });

  async function handleCreateToken() {
    setState({ status: "loading" });

    try {
      const response = await fetch("/api/runners/registration-tokens", {
        method: "POST",
      });
      const body = (await safeJson(response)) as {
        registrationToken?: {
          token?: unknown;
          expiresAt?: unknown;
        };
        error?: {
          code?: unknown;
        };
      };

      if (!response.ok) {
        setState({
          status: "error",
          message: registrationFailureMessage(body.error?.code),
        });
        return;
      }

      const token =
        typeof body.registrationToken?.token === "string" ? body.registrationToken.token : "";
      const expiresAt =
        typeof body.registrationToken?.expiresAt === "string"
          ? body.registrationToken.expiresAt
          : "";

      if (!token.startsWith("agb_reg_") || !expiresAt) {
        setState({
          status: "error",
          message: "Registration token could not be displayed safely.",
        });
        return;
      }

      setState({
        status: "success",
        message: "Registration token created. Copy it now; it will not be shown again.",
        secret: {
          token,
          expiresAt,
        },
      });
    } catch {
      setState({
        status: "error",
        message: "Registration token could not be created.",
      });
    }
  }

  return (
    <div className="runner-management-block">
      <div className="runner-management-header">
        <div>
          <h3>Create Registration Token</h3>
          <p>Issue one token for a runner to exchange during registration.</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={disabled || state.status === "loading"}
          onClick={handleCreateToken}
        >
          {state.status === "loading" ? "Creating…" : "Create Token"}
        </button>
      </div>
      <RunnerActionMessage state={state} />
      {state.status === "success" && state.secret ? (
        <VisibleOnceSecret
          label="Registration token"
          value={state.secret.token}
          metadata={`Expires ${state.secret.expiresAt}`}
          onDismiss={() =>
            setState({
              status: "success",
              message: "Registration token dismissed. Create another token if needed.",
            })
          }
        />
      ) : null}
    </div>
  );
}

export function RunnerCredentialControls({ runnerId, runnerName }: RunnerCredentialControlsProps) {
  const router = useRouter();
  const [rotateState, setRotateState] = useState<CredentialState>({ status: "idle" });
  const [revokeState, setRevokeState] = useState<RequestState>({ status: "idle" });
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  async function handleRotateCredential() {
    setRotateState({ status: "loading" });
    setConfirmingRevoke(false);

    try {
      const response = await fetch(
        `/api/runners/${encodeURIComponent(runnerId)}/credentials/rotate`,
        {
          method: "POST",
        },
      );
      const body = (await safeJson(response)) as {
        credential?: {
          token?: unknown;
          rotatedAt?: unknown;
        };
        error?: {
          code?: unknown;
        };
      };

      if (!response.ok) {
        setRotateState({
          status: "error",
          message: credentialFailureMessage(body.error?.code, "rotated"),
        });
        return;
      }

      const token = typeof body.credential?.token === "string" ? body.credential.token : "";
      const rotatedAt =
        typeof body.credential?.rotatedAt === "string" ? body.credential.rotatedAt : "";

      if (!token.startsWith("agb_run_") || !rotatedAt) {
        setRotateState({
          status: "error",
          message: "Runner credential could not be displayed safely.",
        });
        return;
      }

      setRotateState({
        status: "success",
        message: "Runner credential rotated. Copy the replacement now.",
        secret: {
          token,
          rotatedAt,
        },
      });
      router.refresh();
    } catch {
      setRotateState({
        status: "error",
        message: "Runner credential could not be rotated.",
      });
    }
  }

  async function handleRevokeCredential() {
    setRevokeState({ status: "loading" });

    try {
      const response = await fetch(
        `/api/runners/${encodeURIComponent(runnerId)}/credentials/revoke`,
        {
          method: "POST",
        },
      );
      const body = (await safeJson(response)) as {
        credential?: {
          revokedAt?: unknown;
          revokedCredentialCount?: unknown;
        };
        error?: {
          code?: unknown;
        };
      };

      if (!response.ok) {
        setRevokeState({
          status: "error",
          message: credentialFailureMessage(body.error?.code, "revoked"),
        });
        return;
      }

      const revokedAt =
        typeof body.credential?.revokedAt === "string" ? body.credential.revokedAt : "";
      const revokedCredentialCount =
        typeof body.credential?.revokedCredentialCount === "number"
          ? body.credential.revokedCredentialCount
          : 0;

      setConfirmingRevoke(false);
      setRotateState({ status: "idle" });
      setRevokeState({
        status: "success",
        message: `Runner credential revoked at ${revokedAt || "the server time"}. ${revokedCredentialCount} active credential${revokedCredentialCount === 1 ? "" : "s"} can no longer authenticate.`,
      });
      router.refresh();
    } catch {
      setRevokeState({
        status: "error",
        message: "Runner credential could not be revoked.",
      });
    }
  }

  return (
    <section
      className="runner-credential-controls"
      aria-label={`Credential controls for ${runnerName}`}
    >
      <div className="runner-control-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={rotateState.status === "loading" || revokeState.status === "loading"}
          onClick={handleRotateCredential}
        >
          {rotateState.status === "loading" ? "Rotating…" : "Rotate Credential"}
        </button>
        {confirmingRevoke ? (
          <>
            <button
              className="secondary-button danger-button"
              type="button"
              disabled={revokeState.status === "loading"}
              onClick={handleRevokeCredential}
            >
              {revokeState.status === "loading" ? "Revoking…" : "Confirm Revoke"}
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={revokeState.status === "loading"}
              onClick={() => {
                setConfirmingRevoke(false);
                setRevokeState({ status: "idle" });
              }}
            >
              Cancel
            </button>
          </>
        ) : (
          <button
            className="secondary-button danger-button"
            type="button"
            disabled={rotateState.status === "loading" || revokeState.status === "loading"}
            onClick={() => {
              setConfirmingRevoke(true);
              setRevokeState({
                status: "success",
                message: "Confirm revocation to stop this runner credential from authenticating.",
              });
            }}
          >
            Revoke Credential
          </button>
        )}
      </div>
      <RunnerActionMessage state={rotateState} />
      {rotateState.status === "success" && rotateState.secret ? (
        <VisibleOnceSecret
          label="Runner credential"
          value={rotateState.secret.token}
          metadata={`Rotated ${rotateState.secret.rotatedAt}`}
          onDismiss={() =>
            setRotateState({
              status: "success",
              message: "Runner credential dismissed. Rotate again only if a new value is needed.",
            })
          }
        />
      ) : null}
      <RunnerActionMessage state={revokeState} />
    </section>
  );
}

function VisibleOnceSecret({
  label,
  value,
  metadata,
  onDismiss,
}: {
  label: string;
  value: string;
  metadata: string;
  onDismiss: () => void;
}) {
  return (
    <section className="visible-once-secret" aria-label={`${label} visible once`}>
      <div>
        <span>{label}</span>
        <code translate="no">{value}</code>
        <p>{metadata}</p>
      </div>
      <button className="secondary-button" type="button" onClick={onDismiss}>
        Dismiss
      </button>
    </section>
  );
}

function RunnerActionMessage({ state }: { state: RequestState }) {
  if (state.status !== "success" && state.status !== "error") {
    return null;
  }

  return (
    <p
      className={`form-message ${state.status === "error" ? "error" : "success"}`}
      role="status"
      aria-live="polite"
    >
      {state.message}
    </p>
  );
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function registrationFailureMessage(code: unknown): string {
  if (code === "database_unavailable" || code === "database_schema_missing") {
    return "Registration token could not be created. Start the database and run migrations.";
  }

  return "Registration token could not be created.";
}

function credentialFailureMessage(code: unknown, action: "rotated" | "revoked"): string {
  if (code === "validation_failed") {
    return "Runner credential request was invalid.";
  }

  if (code === "runner_not_found") {
    return "Runner could not be found.";
  }

  if (code === "runner_credential_not_found") {
    return "Runner credential could not be found.";
  }

  if (code === "runner_credential_already_revoked") {
    return "Runner credential is already revoked.";
  }

  return `Runner credential could not be ${action}.`;
}
