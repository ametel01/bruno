import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import {
  BRUNO_AGENT_ID_LABEL,
  DEFAULT_HERMES_PRIVATE_NETWORK,
  DEFAULT_HERMES_READINESS_TIMEOUT_MS,
  DEFAULT_HERMES_DOCKER_CPUS,
  DEFAULT_HERMES_DOCKER_MEMORY,
  DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
  DEFAULT_HERMES_STATE_ROOT,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  DOCKER_CLI_TIMEOUT_MS,
  HERMES_WORKLOAD_GID,
  HERMES_WORKLOAD_UID,
} from "@/src/runner-service/constants";
import {
  type HermesProjectionOptions,
  type HermesProjectionResult,
  projectHermesHome,
} from "@/src/runner-service/hermes-projection";
import {
  MAX_RUNNER_IMAGE_IDENTITY_DIGESTS,
  MAX_RUNNER_IMAGE_REFERENCE_LENGTH,
  MAX_RUNNER_RESTART_COUNT,
  RUNNER_CANARY_CONTRACT_VERSION,
  RUNNER_LAUNCH_CONTRACT_VERSION,
  RUNNER_STATUS_CONTRACT_VERSION,
  type RunnerAgentStatusSnapshot,
  type RunnerCanaryObservation,
  type RunnerCanaryRequest,
  type RunnerCanaryResponse,
  type RunnerCleanupResponsePayload,
  type RunnerContainerState,
  type RunnerGatewayState,
  type RunnerImageIdentity,
  type RunnerLaunchAcceptedResponse,
  type RunnerLaunchAction,
  type RunnerLaunchDisposition,
  type RunnerOperation,
  type RunnerPlatformState,
  type RunnerReadinessReason,
  type RunnerReportedDurableStatusSnapshot,
  type RunnerRestartPolicyName,
  type RunnerStatusResponse,
  type RunnerStopResponsePayload,
  type RunnerTelegramState,
  runnerTargetFromLaunchSpec,
} from "@/src/runner-service/runner-contracts";
import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";
import { redactSecretText } from "@/src/shared/secret-redaction";

export { BRUNO_AGENT_ID_LABEL, DEFAULT_MANUAL_RUNNER_IMAGE, DOCKER_CLI_TIMEOUT_MS };

const DOCKER_RUNNER_IMAGE_ENV = "BRUNO_DOCKER_RUNNER_IMAGE";
const DOCKER_RUNNER_ARGS_ENV = "BRUNO_DOCKER_RUNNER_ARGS_JSON";
const DOCKER_EXECUTABLE_ENV = "BRUNO_RUNNER_DOCKER_EXECUTABLE";
const HERMES_PRIVATE_NETWORK_ENV = "BRUNO_HERMES_PRIVATE_NETWORK";
const HERMES_DOCKER_CPUS_ENV = "BRUNO_HERMES_DOCKER_CPUS";
const HERMES_DOCKER_MEMORY_ENV = "BRUNO_HERMES_DOCKER_MEMORY";
const HERMES_DOCKER_PIDS_LIMIT_ENV = "BRUNO_HERMES_DOCKER_PIDS_LIMIT";
const HERMES_READINESS_PORT_ENV = "BRUNO_HERMES_READINESS_PORT";
const HERMES_STATE_ROOT_ENV = "BRUNO_HERMES_STATE_ROOT";
const BRUNO_CONFIG_REVISION_LABEL = "bruno.config_revision";
const BRUNO_LAUNCH_SPEC_VERSION_LABEL = "bruno.launch_spec_version";
const BRUNO_OPERATION_ID_LABEL = "bruno.operation_id";
const BRUNO_OPERATION_ACTION_LABEL = "bruno.operation_action";
const BRUNO_OPERATION_ACCEPTED_AT_LABEL = "bruno.operation_accepted_at";
const HERMES_DOCKER_CAP_DROP = ["ALL"] as const;
const HERMES_DOCKER_CAP_ADD = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETGID", "SETUID"] as const;
const HERMES_DOCKER_SECURITY_OPT = ["no-new-privileges"] as const;
const MAX_HERMES_LOG_BYTES_PER_FILE = 64 * 1024;
const MAX_HERMES_LOG_LINES = 500;
const STATUS_PROBE_TIMEOUT_MS = 2_000;
const CANARY_TIMEOUT_MS = 15_000;
const MAX_PROBE_RESPONSE_BYTES = 64 * 1024;
const MAX_DOCKER_IMAGE_IDENTITY_BYTES = 16 * 1024;
const DOCKER_IMAGE_IDENTITY_FORMAT = '{"imageId":{{json .Id}},"repoDigests":{{json .RepoDigests}}}';
const HERMES_CONTAINER_HEALTH_PROBE_SOURCE = `
import json
import sys
import urllib.error
import urllib.request

status = 0
body = None

try:
    api_key = None
    with open("/opt/data/.env", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if line.startswith("API_SERVER_KEY="):
                raw_value = line.split("=", 1)[1].strip()
                api_key = json.loads(raw_value) if raw_value.startswith('"') else raw_value
                break
    if not api_key:
        raise ValueError("missing API server key")
    request = urllib.request.Request(
        "http://127.0.0.1:" + sys.argv[1] + "/health/detailed",
        headers={"Authorization": "Bearer " + api_key, "Accept": "application/json"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=2) as response:
            status = response.status
            raw_body = response.read(${MAX_PROBE_RESPONSE_BYTES + 1})
            if len(raw_body) <= ${MAX_PROBE_RESPONSE_BYTES}:
                body = json.loads(raw_body.decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
except Exception:
    pass

print(json.dumps({"status": status, "body": body}, separators=(",", ":")))
`;
const HERMES_CONTAINER_CANARY_PROBE_SOURCE = `
import json
import sys
import urllib.error
import urllib.request

status = 0
body = None

try:
    api_key = None
    with open("/opt/data/.env", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()
            if line.startswith("API_SERVER_KEY="):
                raw_value = line.split("=", 1)[1].strip()
                api_key = json.loads(raw_value) if raw_value.startswith('"') else raw_value
                break
    if not api_key:
        raise ValueError("missing API server key")
    payload = json.dumps({
        "model": sys.argv[2],
        "messages": [{"role": "user", "content": "Reply with ok."}],
        "tools": [],
        "stream": False,
        "max_tokens": 16,
    }).encode("utf-8")
    request = urllib.request.Request(
        "http://127.0.0.1:" + sys.argv[1] + "/v1/chat/completions",
        data=payload,
        headers={
            "Authorization": "Bearer " + api_key,
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            status = response.status
            raw_body = response.read(${MAX_PROBE_RESPONSE_BYTES + 1})
            if len(raw_body) <= ${MAX_PROBE_RESPONSE_BYTES}:
                body = json.loads(raw_body.decode("utf-8"))
    except urllib.error.HTTPError as error:
        status = error.code
except Exception:
    pass

print(json.dumps({"status": status, "body": body}, separators=(",", ":")))
`;
const DUMMY_DOCKER_RUNNER_ARGS = [
  "sh",
  "-c",
  [
    'printf "bruno manual runner started for %s\\n" "$BRUNO_AGENT_ID"',
    'printf "bruno manual runner stderr ready for %s\\n" "$BRUNO_AGENT_ID" >&2',
    'trap \'printf "bruno manual runner stopping for %s\\n" "$BRUNO_AGENT_ID"; exit 0\' TERM INT',
    "while true; do sleep 1; done",
  ].join("; "),
];

export type DockerCliResult = {
  stdout: string;
  stderr: string;
};

export type DockerRunnerCommand = {
  image: string;
  args: string[];
};

export type ManualRunnerDockerOptions = {
  additionalContainerLabels?: Readonly<Record<string, string>>;
  command?: DockerRunnerCommand;
  docker?: DockerExecutableRunner;
  dockerExecutable?: string;
  hermes?: Partial<HermesDockerRuntimeOptions>;
  nameSuffix?: () => string;
  now?: () => Date;
  probe?: {
    requestHealth?: HermesHealthTransport;
    requestContainerHealth?: HermesContainerHealthTransport;
    requestCanary?: HermesCanaryTransport;
    requestContainerCanary?: HermesContainerCanaryTransport;
  };
  projection?: {
    project?: (
      spec: AgentLaunchSpec,
      context?: { signal: AbortSignal },
    ) => Promise<HermesProjectionResult>;
    options?: HermesProjectionOptions;
  };
  readiness?: {
    wait?: HermesReadinessWaiter;
  };
};

export type HermesDockerRuntimeOptions = {
  cpus: string;
  memory: string;
  network: string;
  pidsLimit: string;
  readinessPort: number;
};

export type HermesReadinessWaiter = (input: {
  agentId: string;
  apiServerKey: string;
  configRevision: string;
  containerName: string;
}) => Promise<{ ok: true } | { ok: false; reason: HermesReadinessReason }>;

export type HermesReadinessReason =
  | "api_server_not_connected"
  | "telegram_not_connected"
  | "gateway_failed"
  | "revision_mismatch"
  | "timeout";

const HERMES_READINESS_REASONS = new Set<HermesReadinessReason>([
  "api_server_not_connected",
  "telegram_not_connected",
  "gateway_failed",
  "revision_mismatch",
  "timeout",
]);

export type HermesReadinessEvaluation = { ok: true } | { ok: false; reason: HermesReadinessReason };

export type HermesHealthTransportResult = {
  ok: boolean;
  body: unknown;
  status?: number;
};

export type HermesHealthTransport = (input: {
  apiServerKey: string;
  containerName: string;
  readinessPort: number;
  signal?: AbortSignal;
}) => Promise<HermesHealthTransportResult>;

export type HermesContainerHealthTransport = (input: {
  containerName: string;
  readinessPort: number;
  signal?: AbortSignal;
}) => Promise<HermesHealthTransportResult>;

export type HermesCanaryTransportResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type HermesCanaryTransport = (input: {
  apiServerKey: string;
  containerName: string;
  model: string;
  readinessPort: number;
  signal?: AbortSignal;
}) => Promise<HermesCanaryTransportResult>;

export type HermesContainerCanaryTransport = (input: {
  containerName: string;
  model: string;
  readinessPort: number;
  signal?: AbortSignal;
}) => Promise<HermesCanaryTransportResult>;

export type DockerExecutableRunner = (
  executable: string,
  args: readonly string[],
  options?: { signal?: AbortSignal; timeoutMs?: number },
) => Promise<DockerCliResult>;

export type RunnerContainer = {
  id: string;
  name: string;
  image: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunnerLogLine = {
  stream: "stdout" | "stderr";
  message: string;
  source?: "container_bootstrap" | "hermes_gateway";
  metadata?: Record<string, unknown>;
  createdAt: string | null;
};

export class HermesReadinessError extends Error {
  readonly reason: HermesReadinessReason;

  constructor(reason: HermesReadinessReason) {
    super("Hermes readiness check failed.");
    this.name = "HermesReadinessError";
    this.reason = reason;
  }
}

export function isHermesReadinessReason(value: unknown): value is HermesReadinessReason {
  return typeof value === "string" && HERMES_READINESS_REASONS.has(value as HermesReadinessReason);
}

class HermesRevisionEvidenceError extends Error {
  constructor() {
    super("Hermes runner revision evidence did not match the launch spec.");
    this.name = "HermesRevisionEvidenceError";
  }
}

type DockerRestartPolicyInspect = {
  MaximumRetryCount?: unknown;
  Name?: unknown;
};

type DockerInspectContainer = {
  Id?: string;
  Image?: unknown;
  RestartCount?: unknown;
  Args?: string[];
  Mounts?: Array<{
    Destination?: string;
    Source?: string;
    Type?: string;
  }>;
  Name?: string;
  Config?: {
    Cmd?: string[];
    Entrypoint?: string[];
    Env?: string[];
    Healthcheck?: {
      Test?: string[];
    };
    Image?: string;
    Labels?: Record<string, string> | null;
  };
  HostConfig?: {
    CapAdd?: string[] | null;
    Binds?: string[] | null;
    CapDrop?: string[] | null;
    Memory?: number;
    NanoCpus?: number;
    NetworkMode?: string;
    PidsLimit?: number;
    PortBindings?: Record<string, Array<{ HostPort?: string }> | null> | null;
    RestartPolicy?: DockerRestartPolicyInspect;
    SecurityOpt?: string[] | null;
  };
  NetworkSettings?: {
    Networks?: Record<string, unknown>;
    Ports?: Record<string, Array<{ HostPort?: string }> | null> | null;
  };
  State?: {
    Status?: string;
    StartedAt?: string;
    FinishedAt?: string;
  };
};

type DockerPsLine = {
  ID?: string;
};

type InspectedRunnerContainer = RunnerContainer & {
  inspect: DockerInspectContainer;
};

type LaunchToken = {
  acceptedAt: string;
  action: RunnerLaunchAction;
  controller: AbortController;
  createdContainerId: string | null;
  deadlineAt: number;
  operationId: string;
  target: RunnerOperation["target"];
  terminalReason: "cancelled" | "timeout" | null;
};

export class ManualRunnerDocker {
  private readonly additionalContainerLabels: readonly (readonly [string, string])[];
  private readonly command: DockerRunnerCommand;
  private readonly docker: DockerExecutableRunner;
  private readonly dockerExecutable: string;
  private readonly hermes: HermesDockerRuntimeOptions;
  private readonly nameSuffix: () => string;
  private readonly now: () => Date;
  private readonly project: (
    spec: AgentLaunchSpec,
    context?: { signal: AbortSignal },
  ) => Promise<HermesProjectionResult>;
  private readonly requestCanary: HermesCanaryTransport;
  private readonly requestContainerCanary: HermesContainerCanaryTransport;
  private readonly requestContainerHealth: HermesContainerHealthTransport;
  private readonly requestHealth: HermesHealthTransport;
  private readonly stateRoot: string;
  private readonly preferContainerHealthProbe: boolean;
  private readonly agentLocks = new Map<string, Promise<unknown>>();
  private readonly launchTokens = new Map<string, Set<LaunchToken>>();

  constructor(options: ManualRunnerDockerOptions = {}) {
    this.additionalContainerLabels = resolveAdditionalContainerLabels(
      options.additionalContainerLabels,
    );
    this.command = options.command ?? resolveManualRunnerCommand();
    this.docker = options.docker ?? runDockerExecutable;
    this.dockerExecutable =
      options.dockerExecutable ?? process.env[DOCKER_EXECUTABLE_ENV]?.trim() ?? "docker";
    this.hermes = resolveHermesDockerRuntimeOptions(options.hermes);
    this.nameSuffix = options.nameSuffix ?? (() => randomUUID().replaceAll("-", "").slice(0, 12));
    this.now = options.now ?? (() => new Date());
    this.stateRoot = resolveHermesStateRoot(options.projection?.options?.stateRoot);
    this.project =
      options.projection?.project ??
      ((spec) =>
        projectHermesHome(spec, {
          ownership: { uid: HERMES_WORKLOAD_UID, gid: HERMES_WORKLOAD_GID },
          ...(options.projection?.options ?? {}),
        }));
    this.requestHealth = options.probe?.requestHealth ?? fetchHermesHealth;
    this.preferContainerHealthProbe = options.probe?.requestHealth === undefined;
    this.requestContainerHealth =
      options.probe?.requestContainerHealth ??
      ((input) => this.requestHermesHealthFromContainer(input));
    this.requestCanary = options.probe?.requestCanary ?? fetchHermesCanary;
    this.requestContainerCanary =
      options.probe?.requestContainerCanary ??
      ((input) => this.requestHermesCanaryFromContainer(input));
  }

  async start(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<
    | { container: RunnerContainer; projection: HermesProjectionResult | null }
    | Omit<RunnerLaunchAcceptedResponse, "ok" | "agentId" | "action">
  > {
    if (!launchSpec) {
      return await this.startLegacy(agentId);
    }

    return await this.launchManaged(agentId, "start", launchSpec);
  }

  async stop(agentId: string): Promise<RunnerStopResponsePayload> {
    const inFlightOperationId = this.cancelActiveLaunches(agentId);

    return await this.withAgentLock(agentId, async () => {
      const details = await this.listSelectedContainerDetails(agentId);
      let runningOperationId: string | null = null;

      for (const container of details) {
        if (container.status === "running" || container.status === "restarting") {
          const operationId = readOperationFromInspect(container.inspect)?.id ?? null;

          if (runningOperationId === null && operationId !== null) {
            runningOperationId = operationId;
          }
        }
      }
      const [stopped, stoppedDetails] = await Promise.all(
        details.map(async (container) => {
          if (container.status === "running" || container.status === "restarting") {
            await this.runDocker(["stop", "--time", "20", container.id]);
          }
          return this.inspectSelectedContainer(container.id, agentId);
        }),
      ).then(
        async (stoppedContainers) =>
          [stoppedContainers, await this.listSelectedContainerDetails(agentId)] as const,
      );
      const selected = stoppedDetails.length > 0 ? chooseStatusContainer(stoppedDetails) : null;
      const observedAt = this.now().toISOString();

      return {
        cancelledOperationId: inFlightOperationId ?? runningOperationId ?? null,
        containers: stopped,
        snapshot: buildTerminalSnapshot("stopped", selected, observedAt),
      };
    });
  }

  async cleanup(agentId: string): Promise<RunnerCleanupResponsePayload> {
    const inFlightOperationId = this.cancelActiveLaunches(agentId);

    return await this.withAgentLock(agentId, async () => {
      const details = await this.listSelectedContainerDetails(agentId);
      const selected = details.length > 0 ? chooseStatusContainer(details) : null;
      const selectedOperationId = selected ? readOperationFromInspect(selected.inspect)?.id : null;
      const containers = details.map(({ inspect: _inspect, ...container }) => container);

      await Promise.all(
        containers.map((container) => this.runDocker(["rm", "--force", container.id])),
      );

      const observedAt = this.now().toISOString();

      return {
        cancelledOperationId: inFlightOperationId ?? selectedOperationId ?? null,
        containers,
        removedAgentRoot: await removeHermesAgentRoot(agentId, this.stateRoot),
        snapshot: buildTerminalSnapshot("cancelled", selected, observedAt, true),
      };
    });
  }

  async restart(
    agentId: string,
    launchSpec: AgentLaunchSpec | null = null,
  ): Promise<
    | { container: RunnerContainer; projection: HermesProjectionResult | null }
    | Omit<RunnerLaunchAcceptedResponse, "ok" | "agentId" | "action">
  > {
    if (!launchSpec) {
      await this.removeSelectedContainers(agentId);
      return await this.startLegacy(agentId);
    }

    return await this.launchManaged(agentId, "restart", launchSpec);
  }

  async status(agentId: string): Promise<Omit<RunnerStatusResponse, "ok" | "agentId" | "action">> {
    const snapshot = await this.observeStatus(agentId);

    return {
      contractVersion: RUNNER_STATUS_CONTRACT_VERSION,
      snapshot,
    };
  }

  async canary(
    agentId: string,
    request: RunnerCanaryRequest,
  ): Promise<Omit<RunnerCanaryResponse, "ok" | "agentId" | "action">> {
    const snapshot = await this.observeStatus(agentId);

    if (
      snapshot.phase !== "ready" ||
      snapshot.operation?.id !== request.operationId ||
      snapshot.operation.target.configRevision !== request.configRevision
    ) {
      throw new RunnerCanaryNotReadyError();
    }

    let apiServerKey = await readProjectedApiServerKey(agentId, this.stateRoot);
    const containerName = snapshot.container.name;

    if (!apiServerKey || !containerName) {
      throw new RunnerCanaryNotReadyError();
    }

    const startedAt = Date.now();
    const observation = await this.callCanaryTransport({
      apiServerKey,
      containerName,
      model: request.model,
    });
    apiServerKey = null;

    return {
      contractVersion: RUNNER_CANARY_CONTRACT_VERSION,
      operationId: request.operationId,
      configRevision: request.configRevision,
      observation: {
        ...observation,
        observedAt: this.now().toISOString(),
        latencyMs: Math.max(0, Date.now() - startedAt),
      },
    };
  }

  async logs(
    agentId: string,
  ): Promise<{ container: RunnerContainer | null; logs: RunnerLogLine[] }> {
    const [[container], gatewayLogs] = await Promise.all([
      this.listSelectedContainers(agentId),
      readHermesGatewayLogLines(agentId, this.stateRoot),
    ]);

    if (!container) {
      return { container: null, logs: gatewayLogs };
    }

    const result = await this.runDocker(["logs", "--timestamps", container.id]);

    return {
      container,
      logs: mergeRunnerLogLines(gatewayLogs, parseDockerLogOutput(result)),
    };
  }

  private async startLegacy(
    agentId: string,
  ): Promise<{ container: RunnerContainer; projection: HermesProjectionResult | null }> {
    await this.removeSelectedContainers(agentId);
    const containerName = dockerContainerName(agentId, this.nameSuffix());
    const runResult = await this.runDocker(
      buildLegacyDockerRunArgs({
        agentId,
        command: this.command,
        containerName,
      }),
    );
    const containerId = runResult.stdout.trim();

    if (!containerId) {
      throw new Error("Docker did not return a container id.");
    }

    return {
      container: await this.inspectSelectedContainer(containerId, agentId),
      projection: null,
    };
  }

  private async launchManaged(
    agentId: string,
    action: RunnerLaunchAction,
    launchSpec: AgentLaunchSpec,
  ): Promise<Omit<RunnerLaunchAcceptedResponse, "ok" | "agentId" | "action">> {
    const token: LaunchToken = {
      acceptedAt: this.now().toISOString(),
      action,
      controller: new AbortController(),
      createdContainerId: null,
      deadlineAt: Date.now() + DOCKER_CLI_TIMEOUT_MS,
      operationId: randomUUID(),
      target: runnerTargetFromLaunchSpec(launchSpec),
      terminalReason: null,
    };
    this.registerLaunchToken(agentId, token);

    try {
      return await this.withAgentLock(
        agentId,
        async () => {
          try {
            return await this.acceptHermesLaunch(agentId, launchSpec, token);
          } catch (error) {
            await this.cleanupKnownCreatedContainer(token);
            throw error;
          }
        },
        token,
      );
    } catch (error) {
      await this.cleanupKnownCreatedContainer(token);

      if (token.terminalReason === "cancelled") {
        throw new RunnerLaunchCancelledError();
      }

      if (token.terminalReason === "timeout" || isAbortLikeError(error)) {
        throw new RunnerLaunchAcceptanceTimeoutError();
      }

      throw error;
    } finally {
      this.unregisterLaunchToken(agentId, token);
    }
  }

  private async acceptHermesLaunch(
    agentId: string,
    launchSpec: AgentLaunchSpec,
    token: LaunchToken,
  ): Promise<Omit<RunnerLaunchAcceptedResponse, "ok" | "agentId" | "action">> {
    this.throwIfLaunchTerminated(token);
    const projection = await this.runLaunchStep(token, () =>
      this.project(launchSpec, { signal: token.controller.signal }),
    );
    this.throwIfLaunchTerminated(token);

    const details = await this.listSelectedContainerDetails(agentId, token);
    this.throwIfLaunchTerminated(token);
    const winner = await this.runLaunchStep(token, () =>
      this.findExactRunningWinner(details, launchSpec, projection),
    );
    let disposition: RunnerLaunchDisposition = "created";
    let selected: InspectedRunnerContainer | null = null;

    if (winner) {
      disposition = "reused";
      selected = winner;
      await this.removeSurplusContainers(
        details.filter((detail) => detail.id !== winner.id),
        token,
      );
    } else {
      disposition = details.length > 0 ? "replaced" : "created";
      await this.removeSurplusContainers(details, token);
      this.throwIfLaunchTerminated(token);
      const containerName = dockerContainerName(agentId, this.nameSuffix());
      token.createdContainerId = containerName;
      const runResult = await this.runLaunchDocker(
        token,
        buildHermesDockerRunArgs({
          agentId,
          containerName,
          launchSpec,
          projection,
          runtime: this.hermes,
          additionalLabels: this.additionalContainerLabels,
          operation: {
            id: token.operationId,
            action: token.action,
            target: token.target,
            acceptedAt: token.acceptedAt,
          },
        }),
      );
      const containerId = runResult.stdout.trim();

      if (!containerId) {
        throw new Error("Docker did not return a container id.");
      }
      token.createdContainerId = containerId;
      this.throwIfLaunchTerminated(token);

      try {
        const container = await this.inspectSelectedContainer(
          containerId,
          agentId,
          { launchSpec, projection, runtime: this.hermes },
          token,
        );
        selected = {
          ...container,
          inspect: await this.inspectSelectedContainerRaw(container.id, agentId, token),
        };
        this.throwIfLaunchTerminated(token);
      } catch (error) {
        await this.runDocker(["rm", "--force", containerId]).catch(() => undefined);
        token.createdContainerId = null;

        if (error instanceof HermesRevisionEvidenceError) {
          throw new HermesReadinessError("revision_mismatch");
        }

        throw error;
      }
      token.createdContainerId = null;
    }

    if (!selected) {
      throw new Error("No selected Hermes container after launch acceptance.");
    }

    this.throwIfLaunchTerminated(token);

    const operation = readOperationFromInspect(selected.inspect) ?? {
      id: token.operationId,
      action: token.action,
      target: token.target,
      acceptedAt: token.acceptedAt,
    };
    const snapshot = buildAcceptedSnapshot(selected, operation, this.now().toISOString(), {
      requestedRevision: token.target.configRevision,
      projectionMarkerRevision: launchSpec.agent.configRevision,
    });

    return {
      contractVersion: RUNNER_LAUNCH_CONTRACT_VERSION,
      operation: {
        id: operation.id,
        state: "accepted",
        disposition,
        target: operation.target,
        acceptedAt: operation.acceptedAt,
      },
      snapshot,
    };
  }

  private async observeStatus(agentId: string): Promise<RunnerReportedDurableStatusSnapshot> {
    const details = await this.listSelectedContainerDetails(agentId);
    const observedAt = this.now().toISOString();

    if (details.length === 0) {
      return emptyDurableStatusSnapshot("idle", "container_absent", observedAt);
    }

    const selected = chooseStatusContainer(details);
    const imageIdentity = await this.observeImageIdentity(selected.inspect);
    const operation = readOperationFromInspect(selected.inspect);
    const revision = await readProjectedRevision(agentId, this.stateRoot);
    const requestedRevision =
      operation?.target.configRevision ??
      selected.inspect.Config?.Labels?.[BRUNO_CONFIG_REVISION_LABEL] ??
      null;
    const revisionState = classifyRevisionState({
      requested: requestedRevision,
      containerLabel: selected.inspect.Config?.Labels?.[BRUNO_CONFIG_REVISION_LABEL] ?? null,
      marker: revision,
    });
    const base = buildStatusSnapshotBase(
      selected,
      operation,
      observedAt,
      {
        requestedRevision,
        projectionMarkerRevision: revision.configRevision,
        revisionState,
      },
      imageIdentity,
    );

    if (!operation) {
      return { ...base, phase: "failed", readinessReason: "revision_missing" };
    }

    if (revisionState !== "match") {
      return { ...base, phase: "failed", readinessReason: "revision_mismatch" };
    }

    if (
      !hasExactStatusRuntimeEvidence(selected.inspect, agentId, operation, this.hermes, revision)
    ) {
      return { ...base, phase: "failed", readinessReason: "revision_mismatch" };
    }

    if (selected.status !== "running") {
      return {
        ...base,
        phase: selected.status === "exited" || selected.status === "dead" ? "failed" : "starting",
        readinessReason:
          selected.status === "exited" || selected.status === "dead"
            ? "container_terminal"
            : "container_not_running",
      };
    }

    let apiServerKey = await readProjectedApiServerKey(agentId, this.stateRoot);

    if (!apiServerKey) {
      return applyReadinessWindow(base, operation, "probe_credential_unavailable", observedAt);
    }

    const observation = await this.observeHermesHealth({
      apiServerKey,
      containerName: selected.name,
    });
    apiServerKey = null;
    const probeObservedAt = this.now().toISOString();
    const withObservation: RunnerReportedDurableStatusSnapshot = {
      ...base,
      gateway: { state: observation.gateway, observedAt: probeObservedAt },
      apiServer: { required: true, state: observation.apiServer, observedAt: probeObservedAt },
      telegram: { required: true, state: observation.telegram, observedAt: probeObservedAt },
      observedAt: probeObservedAt,
    };

    if (
      observation.gateway === "running" &&
      observation.apiServer === "connected" &&
      observation.telegram === "connected"
    ) {
      return { ...withObservation, phase: "ready", readinessReason: null };
    }

    return applyReadinessWindow(
      withObservation,
      operation,
      observation.reason,
      probeObservedAt,
      observation.immediateFailure,
    );
  }

  private async observeHermesHealth(input: {
    apiServerKey: string;
    containerName: string;
  }): Promise<{
    apiServer: RunnerPlatformState;
    gateway: RunnerGatewayState;
    immediateFailure: boolean;
    reason: Exclude<RunnerReadinessReason, null>;
    telegram: RunnerTelegramState;
  }> {
    if (!isSafePrivateContainerName(input.containerName)) {
      return {
        apiServer: "unknown",
        gateway: "unknown",
        immediateFailure: false,
        reason: "health_invalid",
        telegram: "unknown",
      };
    }

    try {
      let usedFallbackProbe = false;
      let response: HermesHealthTransportResult;

      try {
        response = this.preferContainerHealthProbe
          ? await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestContainerHealth({
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            )
          : await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestHealth({
                apiServerKey: input.apiServerKey,
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            );
      } catch {
        usedFallbackProbe = true;
        response = this.preferContainerHealthProbe
          ? await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestHealth({
                apiServerKey: input.apiServerKey,
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            )
          : await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestContainerHealth({
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            );
      }

      if (!response.ok && !usedFallbackProbe) {
        response = this.preferContainerHealthProbe
          ? await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestHealth({
                apiServerKey: input.apiServerKey,
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            )
          : await withProbeTimeout(STATUS_PROBE_TIMEOUT_MS, (signal) =>
              this.requestContainerHealth({
                containerName: input.containerName,
                readinessPort: this.hermes.readinessPort,
                signal,
              }),
            );
      }

      if (!response.ok) {
        return {
          apiServer: "unknown",
          gateway: "unknown",
          immediateFailure: false,
          reason:
            response.status === 401 || response.status === 403
              ? "health_unauthorized"
              : "health_unreachable",
          telegram: "unknown",
        };
      }

      const parsed = parseHermesHealthObservation(response.body);

      if (!parsed.ok) {
        return {
          apiServer: "unknown",
          gateway: "unknown",
          immediateFailure: false,
          reason: "health_invalid",
          telegram: "unknown",
        };
      }

      return parsed.observation;
    } catch (error) {
      return {
        apiServer: "unknown",
        gateway: "unknown",
        immediateFailure: false,
        reason: error instanceof ProbeTimeoutError ? "health_timeout" : "health_unreachable",
        telegram: "unknown",
      };
    }
  }

  private async requestHermesHealthFromContainer(
    input: Parameters<HermesContainerHealthTransport>[0],
  ): Promise<HermesHealthTransportResult> {
    try {
      const result = await this.runDocker(
        [
          "exec",
          input.containerName,
          "python",
          "-c",
          HERMES_CONTAINER_HEALTH_PROBE_SOURCE,
          String(input.readinessPort),
        ],
        {
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: STATUS_PROBE_TIMEOUT_MS,
        },
      );
      const parsed: unknown = JSON.parse(result.stdout);

      if (!isSafePlainRecord(parsed)) {
        return { ok: false, status: 0, body: null };
      }

      const status = safeOwnValue(parsed, "status");
      const body = safeOwnValue(parsed, "body");

      if (!Number.isInteger(status) || Number(status) < 0 || Number(status) > 599) {
        return { ok: false, status: 0, body: null };
      }

      return {
        ok: Number(status) >= 200 && Number(status) < 300,
        status: Number(status),
        body,
      };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  private async observeImageIdentity(
    inspect: DockerInspectContainer,
  ): Promise<RunnerImageIdentity | null> {
    const containerImageId = normalizeDockerImageId(inspect.Image);

    if (!containerImageId) {
      return null;
    }

    try {
      const result = await this.runDocker(
        ["image", "inspect", "--format", DOCKER_IMAGE_IDENTITY_FORMAT, containerImageId],
        { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
      );

      return parseDockerImageIdentity(result.stdout, containerImageId);
    } catch {
      return null;
    }
  }

  private async callCanaryTransport(input: {
    apiServerKey: string;
    containerName: string;
    model: string;
  }): Promise<Omit<RunnerCanaryObservation, "observedAt" | "latencyMs">> {
    if (!isSafePrivateContainerName(input.containerName)) {
      return { state: "failed", reason: "canary_unreachable" };
    }

    try {
      let usedContainerProbe = false;
      let response: HermesCanaryTransportResult;

      try {
        response = await withProbeTimeout(CANARY_TIMEOUT_MS, (signal) =>
          this.requestCanary({
            apiServerKey: input.apiServerKey,
            containerName: input.containerName,
            model: input.model,
            readinessPort: this.hermes.readinessPort,
            signal,
          }),
        );
      } catch {
        usedContainerProbe = true;
        response = await withProbeTimeout(CANARY_TIMEOUT_MS, (signal) =>
          this.requestContainerCanary({
            containerName: input.containerName,
            model: input.model,
            readinessPort: this.hermes.readinessPort,
            signal,
          }),
        );
      }

      if (!response.ok && !usedContainerProbe) {
        response = await withProbeTimeout(CANARY_TIMEOUT_MS, (signal) =>
          this.requestContainerCanary({
            containerName: input.containerName,
            model: input.model,
            readinessPort: this.hermes.readinessPort,
            signal,
          }),
        );
      }

      if (response.status === 401 || response.status === 403) {
        return { state: "failed", reason: "canary_unauthorized" };
      }

      if (!response.ok) {
        return { state: "failed", reason: "canary_model_failed" };
      }

      if (!isValidCanaryCompletion(response.body)) {
        return { state: "failed", reason: "canary_invalid_response" };
      }

      return { state: "passed", reason: null };
    } catch (error) {
      return {
        state: "failed",
        reason: error instanceof ProbeTimeoutError ? "canary_timeout" : "canary_unreachable",
      };
    }
  }

  private async requestHermesCanaryFromContainer(
    input: Parameters<HermesContainerCanaryTransport>[0],
  ): Promise<HermesCanaryTransportResult> {
    try {
      const result = await this.runDocker(
        [
          "exec",
          input.containerName,
          "python",
          "-c",
          HERMES_CONTAINER_CANARY_PROBE_SOURCE,
          String(input.readinessPort),
          input.model,
        ],
        {
          ...(input.signal ? { signal: input.signal } : {}),
          timeoutMs: CANARY_TIMEOUT_MS,
        },
      );
      const parsed = parseHermesContainerProbeOutput(result.stdout);

      return parsed ?? { ok: false, status: 0, body: null };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  private async findExactRunningWinner(
    details: readonly InspectedRunnerContainer[],
    launchSpec: AgentLaunchSpec,
    projection: HermesProjectionResult,
  ): Promise<InspectedRunnerContainer | null> {
    const exact = (
      await Promise.all(
        details.map(async (detail) => {
          if (detail.status !== "running") {
            return null;
          }

          try {
            await assertHermesInspectMatchesRuntime(detail.inspect, {
              launchSpec,
              projection,
              runtime: this.hermes,
            });

            return readOperationFromInspect(detail.inspect) ? detail : null;
          } catch {
            // Stale and mismatched selected containers are replaced below.
            return null;
          }
        }),
      )
    ).filter((detail): detail is InspectedRunnerContainer => detail !== null);

    return exact.sort(compareOperationWinner)[0] ?? null;
  }

  private async removeSurplusContainers(
    containers: readonly InspectedRunnerContainer[],
    token: LaunchToken,
  ): Promise<void> {
    await containers.reduce(
      (previous, container) =>
        previous.then(async () => {
          this.throwIfLaunchTerminated(token);
          if (container.status === "running" || container.status === "restarting") {
            await this.runLaunchDocker(token, ["stop", "--time", "20", container.id]);
            this.throwIfLaunchTerminated(token);
          }
          await this.runLaunchDocker(token, ["rm", "--force", container.id]);
          this.throwIfLaunchTerminated(token);
        }),
      Promise.resolve(),
    );
  }

  private registerLaunchToken(agentId: string, token: LaunchToken): void {
    const tokens = this.launchTokens.get(agentId) ?? new Set<LaunchToken>();
    tokens.add(token);
    this.launchTokens.set(agentId, tokens);
  }

  private unregisterLaunchToken(agentId: string, token: LaunchToken): void {
    const tokens = this.launchTokens.get(agentId);

    if (!tokens) {
      return;
    }

    tokens.delete(token);
    if (tokens.size === 0) {
      this.launchTokens.delete(agentId);
    }
  }

  private cancelActiveLaunches(agentId: string): string | null {
    const tokens = [...(this.launchTokens.get(agentId) ?? [])];

    for (const token of tokens) {
      token.terminalReason = "cancelled";
      token.controller.abort();
    }

    return (
      tokens.sort((left, right) => left.acceptedAt.localeCompare(right.acceptedAt))[0]
        ?.operationId ?? null
    );
  }

  private throwIfLaunchTerminated(token: LaunchToken): void {
    if (token.terminalReason === "cancelled") {
      throw new RunnerLaunchCancelledError();
    }

    if (token.terminalReason === "timeout" || Date.now() >= token.deadlineAt) {
      token.terminalReason = "timeout";
      token.controller.abort();
      throw new RunnerLaunchAcceptanceTimeoutError();
    }
  }

  private async withLaunchDeadline<T>(token: LaunchToken, operation: () => Promise<T>): Promise<T> {
    const remainingMs = token.deadlineAt - Date.now();

    if (remainingMs <= 0) {
      token.terminalReason = "timeout";
      token.controller.abort();
      throw new RunnerLaunchAcceptanceTimeoutError();
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        token.terminalReason = "timeout";
        token.controller.abort();
        reject(new RunnerLaunchAcceptanceTimeoutError());
      }, remainingMs);
    });

    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async runLaunchStep<T>(token: LaunchToken, operation: () => Promise<T>): Promise<T> {
    this.throwIfLaunchTerminated(token);
    const result = await this.withLaunchDeadline(token, operation);
    this.throwIfLaunchTerminated(token);
    return result;
  }

  private async runLaunchDocker(
    token: LaunchToken,
    args: readonly string[],
  ): Promise<DockerCliResult> {
    return await this.runLaunchStep(token, () => {
      const remainingMs = Math.max(1, token.deadlineAt - Date.now());
      return this.runDocker(args, { signal: token.controller.signal, timeoutMs: remainingMs });
    });
  }

  private async cleanupKnownCreatedContainer(token: LaunchToken): Promise<void> {
    const containerId = token.createdContainerId;

    if (!containerId) {
      return;
    }
    token.createdContainerId = null;
    const cleanup = this.runDocker(["rm", "--force", containerId], {
      timeoutMs: Math.max(1, token.deadlineAt - Date.now()),
    }).catch(() => undefined);
    const remainingMs = token.deadlineAt - Date.now();

    if (remainingMs <= 0) {
      void cleanup;
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolveTimeout) => {
          timeout = setTimeout(resolveTimeout, remainingMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private async withAgentLock<T>(
    agentId: string,
    operation: () => Promise<T>,
    token?: LaunchToken,
  ): Promise<T> {
    const previous = this.agentLocks.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const chained = previous.then(() => current);
    this.agentLocks.set(agentId, chained);

    try {
      if (token) {
        await this.runLaunchStep(token, () => previous.then(() => undefined));
      } else {
        await previous.catch(() => undefined);
      }
      return await operation();
    } finally {
      release();
      if (this.agentLocks.get(agentId) === chained) {
        this.agentLocks.delete(agentId);
      }
    }
  }

  private async listSelectedContainers(agentId: string): Promise<RunnerContainer[]> {
    return (await this.listSelectedContainerDetails(agentId)).map(
      ({ inspect: _inspect, ...container }) => container,
    );
  }

  private async listSelectedContainerDetails(
    agentId: string,
    token?: LaunchToken,
  ): Promise<InspectedRunnerContainer[]> {
    const args = [
      "ps",
      "--all",
      "--filter",
      `label=${BRUNO_AGENT_ID_LABEL}=${agentId}`,
      "--format",
      "{{json .}}",
    ];
    const result = token ? await this.runLaunchDocker(token, args) : await this.runDocker(args);
    const ids = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseDockerPsLine(line).ID)
      .filter((id): id is string => Boolean(id?.trim()));
    return Promise.all(
      ids.map(async (id) => {
        if (token) {
          this.throwIfLaunchTerminated(token);
        }
        const inspect = await this.inspectSelectedContainerRaw(id, agentId, token);
        return {
          ...containerFromInspect(inspect, id),
          inspect,
        };
      }),
    );
  }

  private async removeSelectedContainers(agentId: string): Promise<void> {
    const containers = await this.listSelectedContainers(agentId);
    await Promise.all(
      containers.map((container) => this.runDocker(["rm", "--force", container.id])),
    );
  }

  private async inspectSelectedContainer(
    containerId: string,
    agentId: string,
    hermes: {
      launchSpec: AgentLaunchSpec;
      projection: HermesProjectionResult;
      runtime: HermesDockerRuntimeOptions;
    } | null = null,
    token?: LaunchToken,
  ): Promise<RunnerContainer> {
    const args = ["inspect", "--format", "{{json .}}", containerId];
    const result = token ? await this.runLaunchDocker(token, args) : await this.runDocker(args);
    const inspect = parseDockerInspect(result.stdout);

    if (inspect.Config?.Labels?.[BRUNO_AGENT_ID_LABEL] !== agentId) {
      throw new Error("Docker container label mismatch.");
    }

    if (hermes) {
      await assertHermesInspectMatchesRuntime(inspect, hermes);
    }

    return containerFromInspect(inspect, containerId);
  }

  private async inspectSelectedContainerRaw(
    containerId: string,
    agentId: string,
    token?: LaunchToken,
  ): Promise<DockerInspectContainer> {
    const args = ["inspect", "--format", "{{json .}}", containerId];
    const result = token ? await this.runLaunchDocker(token, args) : await this.runDocker(args);
    const inspect = parseDockerInspect(result.stdout);

    if (inspect.Config?.Labels?.[BRUNO_AGENT_ID_LABEL] !== agentId) {
      throw new Error("Docker container label mismatch.");
    }

    return inspect;
  }

  private runDocker(
    args: readonly string[],
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<DockerCliResult> {
    return this.docker(this.dockerExecutable, args, options);
  }
}

export class RunnerLaunchCancelledError extends Error {
  constructor() {
    super("Runner launch was cancelled.");
    this.name = "RunnerLaunchCancelledError";
  }
}

export class RunnerCanaryNotReadyError extends Error {
  constructor() {
    super("Runner canary requires a ready matching operation.");
    this.name = "RunnerCanaryNotReadyError";
  }
}

export class RunnerLaunchAcceptanceTimeoutError extends Error {
  constructor() {
    super("Runner launch acceptance timed out.");
    this.name = "RunnerLaunchAcceptanceTimeoutError";
  }
}

function containerFromInspect(
  inspect: DockerInspectContainer,
  fallbackId: string,
): RunnerContainer {
  return {
    id: inspect.Id || fallbackId,
    name: inspect.Name?.replace(/^\//, "") || "",
    image: inspect.Config?.Image || "",
    status: inspect.State?.Status || "unknown",
    startedAt: normalizeDockerTimestamp(inspect.State?.StartedAt),
    finishedAt: normalizeDockerTimestamp(inspect.State?.FinishedAt),
  };
}

function readOperationFromInspect(inspect: DockerInspectContainer): RunnerOperation | null {
  const labels = inspect.Config?.Labels ?? {};
  const id = labels[BRUNO_OPERATION_ID_LABEL];
  const action = labels[BRUNO_OPERATION_ACTION_LABEL];
  const acceptedAt = labels[BRUNO_OPERATION_ACCEPTED_AT_LABEL];
  const image = inspect.Config?.Image;
  const launchSpecVersion = labels[BRUNO_LAUNCH_SPEC_VERSION_LABEL];
  const configRevision = labels[BRUNO_CONFIG_REVISION_LABEL];
  const parsedAcceptedAt = acceptedAt ? Date.parse(acceptedAt) : NaN;

  if (
    !id ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    (action !== "start" && action !== "restart") ||
    !acceptedAt ||
    !Number.isFinite(parsedAcceptedAt) ||
    new Date(parsedAcceptedAt).toISOString() !== acceptedAt ||
    !image ||
    !launchSpecVersion ||
    !configRevision
  ) {
    return null;
  }

  return {
    id,
    action,
    target: { image, launchSpecVersion, configRevision },
    acceptedAt,
  };
}

function compareOperationWinner(
  left: InspectedRunnerContainer,
  right: InspectedRunnerContainer,
): number {
  const leftOperation = readOperationFromInspect(left.inspect);
  const rightOperation = readOperationFromInspect(right.inspect);
  const leftAcceptedAt = leftOperation?.acceptedAt ?? "";
  const rightAcceptedAt = rightOperation?.acceptedAt ?? "";

  return leftAcceptedAt.localeCompare(rightAcceptedAt) || left.id.localeCompare(right.id);
}

function chooseStatusContainer(
  containers: readonly InspectedRunnerContainer[],
): InspectedRunnerContainer {
  return [...containers].sort((left, right) => {
    const leftOperation = readOperationFromInspect(left.inspect);
    const rightOperation = readOperationFromInspect(right.inspect);

    if (leftOperation && rightOperation) {
      return compareOperationWinner(left, right);
    }

    if (leftOperation) {
      return -1;
    }

    if (rightOperation) {
      return 1;
    }

    return left.id.localeCompare(right.id);
  })[0] as InspectedRunnerContainer;
}

function buildAcceptedSnapshot(
  container: InspectedRunnerContainer,
  operation: RunnerOperation,
  observedAt: string,
  revision: { requestedRevision: string | null; projectionMarkerRevision: string | null },
): RunnerAgentStatusSnapshot {
  return {
    phase: "accepted",
    operation,
    container: {
      id: container.id,
      name: container.name,
      image: container.image,
      state: normalizeContainerState(container.status),
      startedAt: container.startedAt,
      finishedAt: container.finishedAt,
      observedAt,
    },
    revision: {
      state: "match",
      requested: revision.requestedRevision,
      containerLabel: operation.target.configRevision,
      projectionMarker: revision.projectionMarkerRevision,
      observedAt,
    },
    gateway: { state: "unknown", observedAt: null },
    apiServer: { required: true, state: "unknown", observedAt: null },
    telegram: { required: true, state: "unknown", observedAt: null },
    readinessReason: "launch_accepted",
    observedAt,
  };
}

function buildStatusSnapshotBase(
  container: InspectedRunnerContainer,
  operation: RunnerOperation | null,
  observedAt: string,
  revision: {
    requestedRevision: string | null;
    projectionMarkerRevision: string | null;
    revisionState: RunnerAgentStatusSnapshot["revision"]["state"];
  },
  imageIdentity: RunnerImageIdentity | null,
): RunnerReportedDurableStatusSnapshot {
  return {
    phase: "starting",
    operation,
    container: {
      id: container.id,
      name: container.name,
      image: container.image,
      imageIdentity,
      state: normalizeContainerState(container.status),
      restartPolicy: normalizeDockerRestartPolicy(container.inspect.HostConfig?.RestartPolicy),
      restartCount: normalizeDockerRestartCount(container.inspect.RestartCount),
      startedAt: container.startedAt,
      finishedAt: container.finishedAt,
      observedAt,
    },
    revision: {
      state: revision.revisionState,
      requested: revision.requestedRevision,
      containerLabel: container.inspect.Config?.Labels?.[BRUNO_CONFIG_REVISION_LABEL] ?? null,
      projectionMarker: revision.projectionMarkerRevision,
      observedAt,
    },
    gateway: { state: "unknown", observedAt: null },
    apiServer: { required: true, state: "unknown", observedAt: null },
    telegram: { required: true, state: "unknown", observedAt: null },
    readinessReason: "launch_accepted",
    observedAt,
  };
}

function emptyStatusSnapshot(
  phase: RunnerAgentStatusSnapshot["phase"],
  reason: Exclude<RunnerReadinessReason, null>,
  observedAt: string,
): RunnerAgentStatusSnapshot {
  return {
    phase,
    operation: null,
    container: {
      id: null,
      name: null,
      image: null,
      state: "absent",
      startedAt: null,
      finishedAt: null,
      observedAt,
    },
    revision: {
      state: "unknown",
      requested: null,
      containerLabel: null,
      projectionMarker: null,
      observedAt,
    },
    gateway: { state: "unknown", observedAt: null },
    apiServer: { required: true, state: "unknown", observedAt: null },
    telegram: { required: true, state: "unknown", observedAt: null },
    readinessReason: reason,
    observedAt,
  };
}

function emptyDurableStatusSnapshot(
  phase: RunnerReportedDurableStatusSnapshot["phase"],
  reason: Exclude<RunnerReadinessReason, null>,
  observedAt: string,
): RunnerReportedDurableStatusSnapshot {
  const snapshot = emptyStatusSnapshot(phase, reason, observedAt);

  return {
    ...snapshot,
    container: {
      ...snapshot.container,
      imageIdentity: null,
      restartPolicy: { name: "unknown", maximumRetryCount: null },
      restartCount: null,
    },
    telegram: { ...snapshot.telegram, state: "unknown" },
  };
}

function buildTerminalSnapshot(
  phase: "stopped" | "cancelled",
  selected: InspectedRunnerContainer | null,
  observedAt: string,
  containerRemoved = false,
): RunnerAgentStatusSnapshot {
  if (!selected) {
    return emptyStatusSnapshot(phase, "launch_cancelled", observedAt);
  }

  const operation = readOperationFromInspect(selected.inspect);

  return {
    phase,
    operation,
    container: {
      id: containerRemoved ? null : selected.id,
      name: containerRemoved ? null : selected.name,
      image: containerRemoved ? null : selected.image,
      state: containerRemoved ? "absent" : normalizeContainerState(selected.status),
      startedAt: containerRemoved ? null : selected.startedAt,
      finishedAt: containerRemoved ? null : selected.finishedAt,
      observedAt,
    },
    revision: {
      state: operation ? "unknown" : "missing",
      requested: operation?.target.configRevision ?? null,
      containerLabel: containerRemoved
        ? null
        : (selected.inspect.Config?.Labels?.[BRUNO_CONFIG_REVISION_LABEL] ?? null),
      projectionMarker: null,
      observedAt,
    },
    gateway: { state: phase === "stopped" ? "stopped" : "unknown", observedAt },
    apiServer: { required: true, state: "unknown", observedAt: null },
    telegram: { required: true, state: "unknown", observedAt: null },
    readinessReason: "launch_cancelled",
    observedAt,
  };
}

function normalizeContainerState(value: string): RunnerContainerState {
  return ["created", "running", "restarting", "paused", "exited", "dead", "removing"].includes(
    value,
  )
    ? (value as RunnerContainerState)
    : "unknown";
}

async function readProjectedRevision(
  agentId: string,
  configuredStateRoot?: string,
): Promise<{
  agentId: string | null;
  configRevision: string | null;
  configuredStateRoot: string | null;
  image: string | null;
  state: "missing" | "unreadable" | "read";
  stateRoot: string | null;
  version: string | null;
}> {
  const revisionPath = resolve(
    resolveHermesStateRoot(configuredStateRoot),
    agentId,
    "hermes",
    "bruno-config-revision.json",
  );

  try {
    await rejectSymlinkPath(resolveHermesStateRoot(configuredStateRoot));
    await rejectSymlinkPath(resolve(resolveHermesStateRoot(configuredStateRoot), agentId));
    await rejectSymlinkPath(
      resolve(resolveHermesStateRoot(configuredStateRoot), agentId, "hermes"),
    );
    const parsed: unknown = JSON.parse(
      await readSafeRegularFile(revisionPath, MAX_PROBE_RESPONSE_BYTES),
    );

    return {
      agentId: isRecord(parsed) && typeof parsed.agentId === "string" ? parsed.agentId : null,
      configRevision:
        isRecord(parsed) && typeof parsed.configRevision === "string"
          ? parsed.configRevision
          : null,
      configuredStateRoot: resolveHermesStateRoot(configuredStateRoot),
      image: isRecord(parsed) && typeof parsed.image === "string" ? parsed.image : null,
      state: "read",
      stateRoot: await realpath(resolveHermesStateRoot(configuredStateRoot)),
      version: isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : null,
    };
  } catch (error) {
    return {
      agentId: null,
      configRevision: null,
      configuredStateRoot: null,
      image: null,
      state: isMissingPathError(error) ? "missing" : "unreadable",
      stateRoot: null,
      version: null,
    };
  }
}

async function readProjectedApiServerKey(
  agentId: string,
  configuredStateRoot?: string,
): Promise<string | null> {
  const stateRoot = resolveHermesStateRoot(configuredStateRoot);
  const envPath = resolve(stateRoot, agentId, "hermes", ".env");

  try {
    await rejectSymlinkPath(stateRoot);
    await rejectSymlinkPath(resolve(stateRoot, agentId));
    await rejectSymlinkPath(resolve(stateRoot, agentId, "hermes"));
    const content = await readSafeRegularFile(envPath, MAX_PROBE_RESPONSE_BYTES);

    const assignments = content
      .split(/\r?\n/)
      .map((line) => /^API_SERVER_KEY=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);

    if (assignments.length !== 1) {
      return null;
    }

    const assignment = assignments[0]?.[1] ?? "";
    let value = assignment;

    if (assignment.startsWith('"') || assignment.endsWith('"')) {
      if (!(assignment.startsWith('"') && assignment.endsWith('"'))) {
        return null;
      }

      const parsed: unknown = JSON.parse(assignment);
      if (typeof parsed !== "string") {
        return null;
      }
      value = parsed;
    }

    return /^bruno_agent_[A-Za-z0-9_-]{32,247}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readSafeRegularFile(path: string, maxBytes: number): Promise<string> {
  const beforeOpen = await lstat(path);

  if (!beforeOpen.isFile() || beforeOpen.nlink !== 1 || beforeOpen.size > maxBytes) {
    throw new Error("Hermes projected file is not a safe bounded regular file.");
  }

  const handle = await open(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
  );

  try {
    const info = await handle.stat();

    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > maxBytes ||
      info.dev !== beforeOpen.dev ||
      info.ino !== beforeOpen.ino
    ) {
      throw new Error("Hermes projected file is not a safe bounded regular file.");
    }

    const content = await handle.readFile("utf8");

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new Error("Hermes projected file exceeds the allowed size.");
    }

    return content;
  } finally {
    await handle.close();
  }
}

function classifyRevisionState(input: {
  requested: string | null;
  containerLabel: string | null;
  marker: { configRevision: string | null; state: "missing" | "unreadable" | "read" };
}): RunnerAgentStatusSnapshot["revision"]["state"] {
  if (input.marker.state === "missing") {
    return "missing";
  }

  if (input.marker.state === "unreadable") {
    return "unreadable";
  }

  if (!input.requested || !input.containerLabel || !input.marker.configRevision) {
    return "missing";
  }

  return input.requested === input.containerLabel && input.requested === input.marker.configRevision
    ? "match"
    : "mismatch";
}

function hasExactStatusRuntimeEvidence(
  inspect: DockerInspectContainer,
  agentId: string,
  operation: RunnerOperation,
  runtime: HermesDockerRuntimeOptions,
  marker: {
    agentId: string | null;
    configRevision: string | null;
    configuredStateRoot: string | null;
    image: string | null;
    stateRoot: string | null;
    version: string | null;
  },
): boolean {
  const stateRoots = [
    ...new Set([marker.configuredStateRoot, marker.stateRoot].filter(Boolean)),
  ] as string[];
  const labels = inspect.Config?.Labels;
  const checks = {
    image: inspect.Config?.Image === operation.target.image,
    agentLabel: labels?.[BRUNO_AGENT_ID_LABEL] === agentId,
    versionLabel: labels?.[BRUNO_LAUNCH_SPEC_VERSION_LABEL] === operation.target.launchSpecVersion,
    revisionLabel: labels?.[BRUNO_CONFIG_REVISION_LABEL] === operation.target.configRevision,
    markerAgent: marker.agentId === agentId,
    markerRevision: marker.configRevision === operation.target.configRevision,
    markerImage: marker.image === operation.target.image,
    markerVersion: marker.version === operation.target.launchSpecVersion,
    homeMount: stateRoots.some((stateRoot) =>
      hasExactMount(inspect, resolve(stateRoot, agentId, "hermes"), "/opt/data"),
    ),
    workspaceMount: stateRoots.some((stateRoot) =>
      hasExactMount(inspect, resolve(stateRoot, agentId, "workspace"), "/workspace"),
    ),
    networkMode: inspect.HostConfig?.NetworkMode === runtime.network,
    networkAttachment: Boolean(
      inspect.NetworkSettings?.Networks && runtime.network in inspect.NetworkSettings.Networks,
    ),
    hostPorts: !hasPublishedPort(inspect.HostConfig?.PortBindings),
    networkPorts: !hasPublishedPort(inspect.NetworkSettings?.Ports),
    restartPolicy: hasExactManagedRestartPolicy(inspect),
    security: hasExactDockerStringSet(inspect.HostConfig?.SecurityOpt, HERMES_DOCKER_SECURITY_OPT),
    capDrop: hasExactDockerStringSet(inspect.HostConfig?.CapDrop, HERMES_DOCKER_CAP_DROP),
    capAdd: hasExactDockerStringSet(inspect.HostConfig?.CapAdd, HERMES_DOCKER_CAP_ADD),
    pids: inspect.HostConfig?.PidsLimit === Number.parseInt(runtime.pidsLimit, 10),
    cpus: inspect.HostConfig?.NanoCpus === parseDockerCpusToNanoCpus(runtime.cpus),
    memory: inspect.HostConfig?.Memory === parseDockerMemoryBytes(runtime.memory),
    socket: !inspectContainsDockerSocket(inspect),
  };
  const failed = Object.entries(checks).find(([, passed]) => !passed)?.[0];

  return !failed;
}

function normalizeDockerRestartPolicy(value: DockerRestartPolicyInspect | undefined): {
  name: RunnerRestartPolicyName;
  maximumRetryCount: number | null;
} {
  const name = value?.Name;
  const maximumRetryCount = normalizeDockerRestartCount(value?.MaximumRetryCount);

  if (
    (name !== "no" && name !== "always" && name !== "unless-stopped" && name !== "on-failure") ||
    maximumRetryCount === null
  ) {
    return { name: "unknown", maximumRetryCount: null };
  }

  return { name, maximumRetryCount };
}

function normalizeDockerRestartCount(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_RUNNER_RESTART_COUNT
    ? value
    : null;
}

function parseDockerImageIdentity(
  stdout: string,
  expectedImageId: string,
): RunnerImageIdentity | null {
  if (Buffer.byteLength(stdout, "utf8") > MAX_DOCKER_IMAGE_IDENTITY_BYTES) {
    return null;
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return null;
  }

  if (
    !isExactSafeRecord(parsed, ["imageId", "repoDigests"]) ||
    parsed.imageId !== expectedImageId ||
    !normalizeDockerImageId(parsed.imageId) ||
    !Array.isArray(parsed.repoDigests) ||
    parsed.repoDigests.length > MAX_RUNNER_IMAGE_IDENTITY_DIGESTS
  ) {
    return null;
  }

  const repoDigests: string[] = [];

  for (const value of parsed.repoDigests) {
    if (!isDockerRepoDigest(value)) {
      return null;
    }
    repoDigests.push(value);
  }

  return { imageId: expectedImageId, repoDigests: [...new Set(repoDigests)].sort() };
}

function normalizeDockerImageId(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

function isDockerRepoDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_RUNNER_IMAGE_REFERENCE_LENGTH &&
    /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/.test(
      value,
    )
  );
}

function hasExactManagedRestartPolicy(inspect: DockerInspectContainer): boolean {
  const policy = normalizeDockerRestartPolicy(inspect.HostConfig?.RestartPolicy);

  return policy.name === "unless-stopped" && policy.maximumRetryCount === 0;
}

function hasExactMount(
  inspect: DockerInspectContainer,
  source: string,
  destination: string,
): boolean {
  return (
    inspect.Mounts?.some(
      (mount) =>
        mount.Type === "bind" && mount.Source === source && mount.Destination === destination,
    ) ?? false
  );
}

function applyReadinessWindow<
  T extends {
    phase: RunnerAgentStatusSnapshot["phase"];
    readinessReason: RunnerReadinessReason;
    observedAt: string;
  },
>(
  snapshot: T,
  operation: RunnerOperation,
  reason: Exclude<RunnerReadinessReason, null>,
  observedAt: string,
  immediateFailure = false,
): T {
  const timedOut =
    Date.parse(observedAt) - Date.parse(operation.acceptedAt) >=
    DEFAULT_HERMES_READINESS_TIMEOUT_MS;

  return {
    ...snapshot,
    phase: timedOut || immediateFailure ? "failed" : "starting",
    readinessReason: timedOut ? "readiness_timeout" : reason,
    observedAt,
  };
}

function parseHermesHealthObservation(value: unknown):
  | {
      ok: true;
      observation: {
        apiServer: RunnerPlatformState;
        gateway: RunnerGatewayState;
        immediateFailure: boolean;
        reason: Exclude<RunnerReadinessReason, null>;
        telegram: RunnerTelegramState;
      };
    }
  | { ok: false } {
  if (!isSafePlainRecord(value)) {
    return { ok: false };
  }

  const status = safeOwnValue(value, "status");
  const gateway = normalizeGatewayState(safeOwnValue(value, "gateway_state"));
  const apiServer = normalizePlatformState(readPlatformState(value, "api_server"));
  const telegram = normalizeTelegramState(readPlatformState(value, "telegram"));
  let reason: Exclude<RunnerReadinessReason, null> = "gateway_starting";
  let immediateFailure = false;

  if (status !== "ok" && status !== "error") {
    return { ok: false };
  }

  if (gateway === "failed" || status === "error") {
    reason = "gateway_failed";
    immediateFailure = true;
  } else if (gateway !== "running") {
    reason = "gateway_starting";
  } else if (apiServer !== "connected") {
    reason = "api_server_not_connected";
  } else if (telegram === "retrying") {
    reason = "telegram_retrying";
  } else if (telegram === "fatal") {
    reason = "telegram_fatal";
    immediateFailure = true;
  } else if (telegram === "paused") {
    reason = "telegram_paused";
    immediateFailure = true;
  } else if (telegram !== "connected") {
    reason = "telegram_not_connected";
  }

  return {
    ok: true,
    observation: {
      apiServer,
      gateway,
      immediateFailure,
      reason,
      telegram,
    },
  };
}

function normalizeGatewayState(value: unknown): RunnerGatewayState {
  if (value === "running" || value === "starting" || value === "failed" || value === "stopped") {
    return value;
  }

  return "unknown";
}

function normalizePlatformState(value: unknown): RunnerPlatformState {
  if (
    value === "connecting" ||
    value === "connected" ||
    value === "disconnected" ||
    value === "failed" ||
    value === "disabled"
  ) {
    return value;
  }

  return "unknown";
}

function normalizeTelegramState(value: unknown): RunnerTelegramState {
  if (
    value === "connecting" ||
    value === "connected" ||
    value === "disconnected" ||
    value === "retrying" ||
    value === "fatal" ||
    value === "paused" ||
    value === "disabled"
  ) {
    return value;
  }

  return "unknown";
}

function isSafePrivateContainerName(value: string): boolean {
  return /^bruno-runner-[A-Za-z0-9][A-Za-z0-9_.-]{0,103}$/.test(value);
}

function isValidCanaryCompletion(value: unknown): boolean {
  if (!isSafePlainRecord(value)) {
    return false;
  }

  const choices = safeOwnValue(value, "choices");

  if (!Array.isArray(choices) || choices.length < 1) {
    return false;
  }

  const choice = choices[0];
  if (!isSafePlainRecord(choice)) {
    return false;
  }

  const message = safeOwnValue(choice, "message");
  return (
    isSafePlainRecord(message) &&
    safeOwnValue(message, "role") === "assistant" &&
    typeof safeOwnValue(message, "content") === "string"
  );
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("Private runner probe timed out.");
    this.name = "ProbeTimeoutError";
  }
}

async function withProbeTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new ProbeTimeoutError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function isAbortLikeError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError" || error.name === "ABORT_ERR")
  );
}

async function assertHermesInspectMatchesRuntime(
  inspect: DockerInspectContainer,
  input: {
    launchSpec: AgentLaunchSpec;
    projection: HermesProjectionResult;
    runtime: HermesDockerRuntimeOptions;
  },
): Promise<void> {
  if (inspect.Config?.Image !== input.launchSpec.image.ref) {
    throw new HermesRevisionEvidenceError();
  }

  if (
    inspect.Config?.Labels?.[BRUNO_CONFIG_REVISION_LABEL] !== input.launchSpec.agent.configRevision
  ) {
    throw new HermesRevisionEvidenceError();
  }

  if (inspect.Config?.Labels?.[BRUNO_LAUNCH_SPEC_VERSION_LABEL] !== input.launchSpec.version) {
    throw new HermesRevisionEvidenceError();
  }

  assertMount(inspect, input.projection.hermesHome, "/opt/data");
  assertMount(inspect, input.projection.workspace, "/workspace");
  await assertProjectedRevisionMatchesLaunchSpec(input.projection, input.launchSpec);

  if (!inspect.HostConfig || inspect.HostConfig.NetworkMode !== input.runtime.network) {
    throw new HermesRevisionEvidenceError();
  }

  if (!hasExactManagedRestartPolicy(inspect)) {
    throw new HermesRevisionEvidenceError();
  }

  if (
    !inspect.NetworkSettings?.Networks ||
    !(input.runtime.network in inspect.NetworkSettings.Networks)
  ) {
    throw new HermesRevisionEvidenceError();
  }

  if (
    hasPublishedPort(inspect.HostConfig.PortBindings) ||
    hasPublishedPort(inspect.NetworkSettings.Ports)
  ) {
    throw new Error("Docker container unexpectedly publishes ports.");
  }

  if (!hasExactDockerStringSet(inspect.HostConfig.SecurityOpt, HERMES_DOCKER_SECURITY_OPT)) {
    throw new Error("Docker container security options mismatch.");
  }

  if (!hasExactDockerStringSet(inspect.HostConfig.CapDrop, HERMES_DOCKER_CAP_DROP)) {
    throw new Error("Docker container capability set mismatch.");
  }

  if (!hasExactDockerStringSet(inspect.HostConfig.CapAdd, HERMES_DOCKER_CAP_ADD)) {
    throw new Error("Docker container capability set mismatch.");
  }

  if (inspect.HostConfig.PidsLimit !== Number.parseInt(input.runtime.pidsLimit, 10)) {
    throw new Error("Docker container PID limit mismatch.");
  }

  const expectedNanoCpus = parseDockerCpusToNanoCpus(input.runtime.cpus);

  if (inspect.HostConfig.NanoCpus !== expectedNanoCpus) {
    throw new Error("Docker container CPU limit mismatch.");
  }

  const expectedMemory = parseDockerMemoryBytes(input.runtime.memory);

  if (inspect.HostConfig.Memory !== expectedMemory) {
    throw new Error("Docker container memory limit mismatch.");
  }

  if (inspectContainsDockerSocket(inspect)) {
    throw new Error("Docker container unexpectedly mounts the Docker socket.");
  }

  if (inspectContainsSecretValue(inspect, input.launchSpec)) {
    throw new Error("Docker container inspect exposes launch secrets.");
  }
}

function assertMount(
  inspect: DockerInspectContainer,
  expectedSource: string,
  expectedDestination: string,
): void {
  const hasMount = inspect.Mounts?.some(
    (mount) =>
      mount.Type === "bind" &&
      mount.Source === expectedSource &&
      mount.Destination === expectedDestination,
  );

  if (!hasMount) {
    throw new HermesRevisionEvidenceError();
  }
}

async function assertProjectedRevisionMatchesLaunchSpec(
  projection: HermesProjectionResult,
  launchSpec: AgentLaunchSpec,
): Promise<void> {
  let marker: unknown;

  try {
    await rejectSymlinkPath(projection.revisionPath);
    marker = JSON.parse(await readFile(projection.revisionPath, "utf8"));
  } catch {
    throw new HermesRevisionEvidenceError();
  }

  if (
    !isRecord(marker) ||
    marker.version !== launchSpec.version ||
    marker.agentId !== launchSpec.agent.id ||
    marker.configRevision !== launchSpec.agent.configRevision ||
    marker.image !== launchSpec.image.ref
  ) {
    throw new HermesRevisionEvidenceError();
  }
}

function hasPublishedPort(
  ports: Record<string, Array<{ HostPort?: string }> | null> | null | undefined,
): boolean {
  return Object.values(ports ?? {}).some((bindings) =>
    (bindings ?? []).some((binding) => Boolean(binding.HostPort?.trim())),
  );
}

function inspectContainsDockerSocket(inspect: DockerInspectContainer): boolean {
  const values = [
    ...(inspect.Mounts ?? []).flatMap((mount) => [mount.Source, mount.Destination]),
    ...(inspect.HostConfig?.Binds ?? []),
  ];

  return values.some((value) => value?.includes("/var/run/docker.sock"));
}

function hasExactDockerStringSet(
  actual: readonly string[] | null | undefined,
  expected: readonly string[],
): boolean {
  const normalizedActual = new Set(
    (actual ?? []).map((value) => value.trim().replace(/^CAP_/i, "").toUpperCase()),
  );
  const normalizedExpected = new Set(
    expected.map((value) => value.trim().replace(/^CAP_/i, "").toUpperCase()),
  );

  return (
    normalizedActual.size === normalizedExpected.size &&
    normalizedExpected.size === expected.length &&
    (actual ?? []).length === normalizedActual.size &&
    [...normalizedExpected].every((value) => normalizedActual.has(value))
  );
}

function inspectContainsSecretValue(
  inspect: DockerInspectContainer,
  launchSpec: AgentLaunchSpec,
): boolean {
  const highEntropySecrets =
    launchSpec.version === "bruno.hermes.launch.v3"
      ? [
          "openrouterApiKey" in launchSpec.secrets
            ? launchSpec.secrets.openrouterApiKey
            : launchSpec.secrets.modelApiKey,
          launchSpec.secrets.telegramBotToken,
          launchSpec.secrets.apiServerKey,
        ]
      : [launchSpec.secrets.apiServerKey];
  const inspectSurface = {
    Args: inspect.Args,
    Cmd: inspect.Config?.Cmd,
    Entrypoint: inspect.Config?.Entrypoint,
    Env: inspect.Config?.Env,
    Healthcheck: inspect.Config?.Healthcheck,
    Labels: inspect.Config?.Labels,
    Name: inspect.Name,
  };
  const inspectStrings = collectInspectStrings(inspectSurface);

  if (
    highEntropySecrets.some((secret) =>
      inspectStrings.some((value) => secret.trim().length > 0 && value.includes(secret)),
    )
  ) {
    return true;
  }

  return (
    launchSpec.version === "bruno.hermes.launch.v3" &&
    launchSpec.secrets.telegramAllowedUsers.some((telegramId) =>
      inspectStrings.some((value) => stringExposesTelegramAllowedUser(value, telegramId)),
    )
  );
}

function collectInspectStrings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectInspectStrings(entry));
  }

  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, entry]) => [key, ...collectInspectStrings(entry)]);
  }

  return [];
}

function stringExposesTelegramAllowedUser(value: string, telegramId: string): boolean {
  if (value === telegramId) {
    return true;
  }

  const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(value);

  if (!assignment?.[1] || assignment[1] !== "TELEGRAM_ALLOWED_USERS" || !assignment[2]) {
    return false;
  }

  return assignment[2]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .includes(telegramId);
}

function parseDockerCpusToNanoCpus(value: string): number {
  const cpus = Number.parseFloat(value);

  if (!Number.isFinite(cpus) || cpus <= 0) {
    throw new Error("Hermes Docker CPU limit must be positive.");
  }

  return Math.round(cpus * 1_000_000_000);
}

function parseDockerMemoryBytes(value: string): number {
  const match = /^(\d+)([bkmg])?$/i.exec(value.trim());

  if (!match?.[1]) {
    throw new Error("Hermes Docker memory limit must be a Docker byte value.");
  }

  const units: Record<string, number> = {
    b: 1,
    k: 1024,
    m: 1024 * 1024,
    g: 1024 * 1024 * 1024,
  };
  const unit = match[2]?.toLowerCase() ?? "b";

  return Number.parseInt(match[1], 10) * (units[unit] ?? 1);
}

export function buildHermesDockerRunArgs(input: {
  additionalLabels?: readonly (readonly [string, string])[];
  agentId: string;
  containerName: string;
  launchSpec: AgentLaunchSpec;
  operation: RunnerOperation;
  projection: HermesProjectionResult;
  runtime: HermesDockerRuntimeOptions;
}): string[] {
  return [
    "run",
    "--detach",
    "--restart",
    "unless-stopped",
    "--name",
    input.containerName,
    "--label",
    `${BRUNO_AGENT_ID_LABEL}=${input.agentId}`,
    "--label",
    `${BRUNO_CONFIG_REVISION_LABEL}=${input.launchSpec.agent.configRevision}`,
    "--label",
    `${BRUNO_LAUNCH_SPEC_VERSION_LABEL}=${input.launchSpec.version}`,
    "--label",
    `${BRUNO_OPERATION_ID_LABEL}=${input.operation.id}`,
    "--label",
    `${BRUNO_OPERATION_ACTION_LABEL}=${input.operation.action}`,
    "--label",
    `${BRUNO_OPERATION_ACCEPTED_AT_LABEL}=${input.operation.acceptedAt}`,
    ...(input.additionalLabels ?? []).flatMap(([name, value]) => ["--label", `${name}=${value}`]),
    "--network",
    input.runtime.network,
    "--mount",
    `type=bind,source=${input.projection.hermesHome},target=/opt/data`,
    "--mount",
    `type=bind,source=${input.projection.workspace},target=/workspace`,
    "--cpus",
    input.runtime.cpus,
    "--memory",
    input.runtime.memory,
    "--pids-limit",
    input.runtime.pidsLimit,
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    "--cap-add",
    "CHOWN",
    "--cap-add",
    "DAC_OVERRIDE",
    "--cap-add",
    "FOWNER",
    "--cap-add",
    "SETGID",
    "--cap-add",
    "SETUID",
    input.launchSpec.image.ref,
    "gateway",
    "run",
  ];
}

function resolveAdditionalContainerLabels(
  labels: Readonly<Record<string, string>> | undefined,
): readonly (readonly [string, string])[] {
  const entries = Object.entries(labels ?? {});
  for (const [name, value] of entries) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    ) {
      throw new Error("Additional Docker container label is invalid.");
    }
  }
  return entries;
}

function buildLegacyDockerRunArgs(input: {
  agentId: string;
  command: DockerRunnerCommand;
  containerName: string;
}): string[] {
  return [
    "run",
    "--detach",
    "--name",
    input.containerName,
    "--label",
    `${BRUNO_AGENT_ID_LABEL}=${input.agentId}`,
    "--env",
    `BRUNO_AGENT_ID=${input.agentId}`,
    input.command.image,
    ...input.command.args,
  ];
}

function resolveHermesDockerRuntimeOptions(
  overrides: Partial<HermesDockerRuntimeOptions> | undefined,
): HermesDockerRuntimeOptions {
  return {
    cpus:
      overrides?.cpus ?? process.env[HERMES_DOCKER_CPUS_ENV]?.trim() ?? DEFAULT_HERMES_DOCKER_CPUS,
    memory:
      overrides?.memory ??
      process.env[HERMES_DOCKER_MEMORY_ENV]?.trim() ??
      DEFAULT_HERMES_DOCKER_MEMORY,
    network:
      overrides?.network ??
      process.env[HERMES_PRIVATE_NETWORK_ENV]?.trim() ??
      DEFAULT_HERMES_PRIVATE_NETWORK,
    pidsLimit:
      overrides?.pidsLimit ??
      process.env[HERMES_DOCKER_PIDS_LIMIT_ENV]?.trim() ??
      DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
    readinessPort: readPositiveInteger(
      process.env[HERMES_READINESS_PORT_ENV],
      overrides?.readinessPort ?? 8642,
    ),
  };
}

export function createHermesReadinessWaiter(
  runtime: HermesDockerRuntimeOptions,
  options: {
    now?: () => number;
    pollMs?: number;
    requestHealth?: HermesHealthTransport;
    requireTelegram?: boolean;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
  } = {},
): HermesReadinessWaiter {
  return async (input) => {
    const now = options.now ?? Date.now;
    const requestHealth = options.requestHealth ?? fetchHermesHealth;
    const sleep =
      options.sleep ?? ((ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms)));
    const deadline = now() + (options.timeoutMs ?? 180_000);
    let latestReason: HermesReadinessReason | null = null;

    while (now() < deadline) {
      try {
        const response = await requestHealth({
          apiServerKey: input.apiServerKey,
          containerName: input.containerName,
          readinessPort: runtime.readinessPort,
        });

        if (response.ok && isRecord(response.body)) {
          const readiness = evaluateHermesReadyResponse(response.body, {
            requireTelegram: options.requireTelegram ?? true,
          });

          if (readiness.ok) {
            return { ok: true };
          }

          latestReason = readiness.reason;
        }
      } catch {
        // Hermes may still be booting or the private network route may not be ready yet.
      }

      await sleep(options.pollMs ?? 1_000);
    }

    return { ok: false, reason: latestReason ?? "timeout" };
  };
}

async function fetchHermesHealth(input: {
  apiServerKey: string;
  containerName: string;
  readinessPort: number;
  signal?: AbortSignal;
}): Promise<HermesHealthTransportResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), STATUS_PROBE_TIMEOUT_MS);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) {
    controller.abort();
  }

  try {
    const response = await fetch(
      `http://${input.containerName}:${input.readinessPort}/health/detailed`,
      {
        headers: {
          Authorization: `Bearer ${input.apiServerKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return { ok: false, body: null, status: response.status };
    }

    const text = await readBoundedResponseText(response, MAX_PROBE_RESPONSE_BYTES, controller);

    try {
      return {
        ok: true,
        body: JSON.parse(text),
        status: response.status,
      };
    } catch {
      return { ok: true, body: null, status: response.status };
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

async function fetchHermesCanary(input: {
  apiServerKey: string;
  containerName: string;
  model: string;
  readinessPort: number;
  signal?: AbortSignal;
}): Promise<HermesCanaryTransportResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANARY_TIMEOUT_MS);
  const abort = () => controller.abort();
  input.signal?.addEventListener("abort", abort, { once: true });
  if (input.signal?.aborted) {
    controller.abort();
  }

  try {
    const response = await fetch(
      `http://${input.containerName}:${input.readinessPort}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.apiServerKey}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          messages: [
            {
              role: "user",
              content: "Reply with ok.",
            },
          ],
          tools: [],
          stream: false,
          max_tokens: 16,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return { ok: false, status: response.status, body: null };
    }

    const text = await readBoundedResponseText(response, MAX_PROBE_RESPONSE_BYTES, controller);

    let body: unknown = null;

    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abort);
  }
}

async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  controller: AbortController,
): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);

  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    controller.abort();
    return "";
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) {
        break;
      }

      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        controller.abort();
        return "";
      }
      text += decoder.decode(chunk.value, { stream: true });
    }

    return text + decoder.decode();
  } catch {
    return "";
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseHermesContainerProbeOutput(stdout: string): HermesCanaryTransportResult | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  if (!isSafePlainRecord(parsed)) {
    return null;
  }

  const status = safeOwnValue(parsed, "status");

  if (!Number.isInteger(status) || Number(status) < 0 || Number(status) > 599) {
    return null;
  }

  return {
    ok: Number(status) >= 200 && Number(status) < 300,
    status: Number(status),
    body: safeOwnValue(parsed, "body"),
  };
}

export function isHermesReadyResponse(
  value: unknown,
  options: { requireTelegram?: boolean } = {},
): boolean {
  return evaluateHermesReadyResponse(value, options).ok;
}

export function evaluateHermesReadyResponse(
  value: unknown,
  options: { requireTelegram?: boolean } = {},
): HermesReadinessEvaluation {
  if (!isRecord(value)) {
    return { ok: false, reason: "gateway_failed" };
  }

  if (value.status !== "ok" || value.gateway_state !== "running") {
    return { ok: false, reason: "gateway_failed" };
  }

  if (readPlatformState(value, "api_server") !== "connected") {
    return { ok: false, reason: "api_server_not_connected" };
  }

  if ((options.requireTelegram ?? true) && readPlatformState(value, "telegram") !== "connected") {
    return { ok: false, reason: "telegram_not_connected" };
  }

  return { ok: true };
}

function readPlatformState(value: Record<string, unknown>, platformName: string): unknown {
  const platforms = safeOwnValue(value, "platforms");

  if (!isSafePlainRecord(platforms)) {
    return null;
  }

  const platform = safeOwnValue(platforms, platformName);

  return isSafePlainRecord(platform) ? safeOwnValue(platform, "state") : null;
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveManualRunnerCommand(
  input: Record<string, string | undefined> = process.env,
): DockerRunnerCommand {
  return {
    image: input[DOCKER_RUNNER_IMAGE_ENV]?.trim() || DEFAULT_MANUAL_RUNNER_IMAGE,
    args: parseManualRunnerArgs(input[DOCKER_RUNNER_ARGS_ENV]),
  };
}

function runDockerExecutable(
  executable: string,
  args: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DockerCliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? DOCKER_CLI_TIMEOUT_MS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }

        resolvePromise({ stdout, stderr });
      },
    );
  });
}

function parseDockerPsLine(line: string): DockerPsLine {
  const parsed: unknown = JSON.parse(line);

  if (!isRecord(parsed)) {
    throw new Error("Docker ps returned an invalid row.");
  }

  return parsed;
}

function parseDockerInspect(stdout: string): DockerInspectContainer {
  const parsed: unknown = JSON.parse(stdout.trim());

  if (!isRecord(parsed)) {
    throw new Error("Docker inspect returned an invalid object.");
  }

  return parsed;
}

function parseDockerLogOutput(result: DockerCliResult): RunnerLogLine[] {
  return [
    ...parseDockerLogStream("stdout", result.stdout),
    ...parseDockerLogStream("stderr", result.stderr),
  ].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;

    return leftTime - rightTime;
  });
}

function parseDockerLogStream(stream: RunnerLogLine["stream"], content: string): RunnerLogLine[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .map((line) => parseDockerLogLine(stream, line))
    .filter((line): line is RunnerLogLine => line !== null);
}

function parseDockerLogLine(stream: RunnerLogLine["stream"], line: string): RunnerLogLine | null {
  const match = /^(\S+)\s(.*)$/.exec(line);

  if (!match) {
    return {
      stream,
      source: "container_bootstrap",
      message: redactSecretText(line),
      metadata: { logSource: "container_bootstrap" },
      createdAt: null,
    };
  }

  const timestamp = new Date(match[1] ?? "");
  const message = match[2]?.trimEnd() ?? "";

  if (message.trim().length === 0) {
    return null;
  }

  if (Number.isNaN(timestamp.getTime())) {
    return {
      stream,
      source: "container_bootstrap",
      message: redactSecretText(line),
      metadata: { logSource: "container_bootstrap" },
      createdAt: null,
    };
  }

  return {
    stream,
    source: "container_bootstrap",
    message: redactSecretText(message),
    metadata: { logSource: "container_bootstrap" },
    createdAt: timestamp.toISOString(),
  };
}

async function readHermesGatewayLogLines(
  agentId: string,
  configuredStateRoot?: string,
): Promise<RunnerLogLine[]> {
  const stateRoot = resolveHermesStateRoot(configuredStateRoot);
  const logDirectory = resolveHermesGatewayLogDirectory(agentId, stateRoot);

  try {
    await rejectSymlinkPath(stateRoot);
    await rejectSymlinkPath(resolve(stateRoot, agentId));
    await rejectSymlinkPath(logDirectory);
  } catch {
    return [];
  }

  let entries: Array<{ name: string; mtimeMs: number }> = [];

  try {
    const entryPromises: Array<Promise<{ name: string; mtimeMs: number }>> = [];

    for (const name of await readdir(logDirectory)) {
      if (name === "current" || name.startsWith("current.")) {
        entryPromises.push(
          (async () => ({
            name,
            mtimeMs: (await stat(resolve(logDirectory, name))).mtimeMs,
          }))(),
        );
      }
    }

    entries = await Promise.all(entryPromises);
  } catch {
    return [];
  }

  const files = entries
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name))
    .map((entry) => resolve(logDirectory, entry.name));
  const lines = (
    await Promise.all(files.map((file) => readHermesGatewayLogFile(file, logDirectory)))
  )
    .flat()
    .slice(-MAX_HERMES_LOG_LINES);

  return lines;
}

async function readHermesGatewayLogFile(
  filePath: string,
  logDirectory: string,
): Promise<RunnerLogLine[]> {
  const relativePath = relative(logDirectory, filePath);

  if (relativePath.startsWith("..") || relativePath.includes(sep)) {
    return [];
  }

  try {
    await rejectSymlinkPath(filePath);
    const content = await readFile(filePath, { encoding: "utf8" });
    const tail =
      Buffer.byteLength(content, "utf8") > MAX_HERMES_LOG_BYTES_PER_FILE
        ? content.slice(-MAX_HERMES_LOG_BYTES_PER_FILE)
        : content;

    return tail
      .split(/\r?\n/)
      .map((line) => parseHermesGatewayLogLine(line, basename(filePath)))
      .filter((line): line is RunnerLogLine => line !== null);
  } catch {
    return [];
  }
}

function parseHermesGatewayLogLine(line: string, fileName: string): RunnerLogLine | null {
  const trimmed = line.trimEnd();

  if (!trimmed.trim()) {
    return null;
  }

  const dockerTimestamp = /^(\S+)\s(.*)$/.exec(trimmed);
  const bracketTimestamp = /^\[([^\]]+)\]\s*(.*)$/.exec(trimmed);
  const timestampText = dockerTimestamp?.[1] ?? bracketTimestamp?.[1] ?? "";
  const parsedTimestamp = timestampText ? new Date(timestampText) : null;
  const message = dockerTimestamp?.[2] ?? bracketTimestamp?.[2] ?? trimmed;

  return {
    stream: "stdout",
    source: "hermes_gateway",
    message: redactSecretText(message.trimEnd()),
    metadata: {
      logSource: "hermes_gateway",
      logFile: fileName,
    },
    createdAt:
      parsedTimestamp && !Number.isNaN(parsedTimestamp.getTime())
        ? parsedTimestamp.toISOString()
        : null,
  };
}

function mergeRunnerLogLines(
  gatewayLogs: RunnerLogLine[],
  bootstrapLogs: RunnerLogLine[],
): RunnerLogLine[] {
  const gatewayKeys = new Set(gatewayLogs.map(logDeduplicationKey));

  return [
    ...gatewayLogs,
    ...bootstrapLogs.filter((line) => !gatewayKeys.has(logDeduplicationKey(line))),
  ]
    .sort((left, right) => {
      const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
      const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;

      return leftTime - rightTime || sourceOrder(left) - sourceOrder(right);
    })
    .slice(-MAX_HERMES_LOG_LINES);
}

function logDeduplicationKey(line: RunnerLogLine): string {
  return `${line.createdAt ?? ""}:${line.message}`;
}

function sourceOrder(line: RunnerLogLine): number {
  return line.source === "hermes_gateway" ? 0 : 1;
}

async function removeHermesAgentRoot(
  agentId: string,
  configuredStateRoot?: string,
): Promise<boolean> {
  const stateRoot = resolveHermesStateRoot(configuredStateRoot);
  const agentRoot = resolve(stateRoot, agentId);
  assertChildPath(stateRoot, agentRoot);

  try {
    await rejectSymlinkPath(stateRoot);
    await rejectSymlinkPath(agentRoot);
    await rm(agentRoot, { force: true, recursive: true });
    return true;
  } catch (error) {
    if (isMissingPathError(error)) {
      return false;
    }

    throw error;
  }
}

function resolveHermesGatewayLogDirectory(agentId: string, configuredStateRoot?: string): string {
  const stateRoot = resolveHermesStateRoot(configuredStateRoot);
  const agentRoot = resolve(stateRoot, agentId);
  const logDirectory = resolve(agentRoot, "hermes", "logs", "gateways", "default");
  assertChildPath(stateRoot, agentRoot);
  assertChildPath(agentRoot, logDirectory);

  return logDirectory;
}

function resolveHermesStateRoot(configuredStateRoot?: string): string {
  return resolve(
    configuredStateRoot ?? process.env[HERMES_STATE_ROOT_ENV]?.trim() ?? DEFAULT_HERMES_STATE_ROOT,
  );
}

async function rejectSymlinkPath(path: string): Promise<void> {
  const info = await lstat(path);

  if (info.isSymbolicLink()) {
    throw new Error("Hermes runner path must not be a symbolic link.");
  }
}

function assertChildPath(parent: string, child: string): void {
  const relativePath = relative(parent, child);

  if (relativePath === "" || relativePath.startsWith("..") || relativePath.includes(`..${sep}`)) {
    throw new Error("Hermes runner path escaped the managed root.");
  }
}

function isMissingPathError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function parseManualRunnerArgs(value: string | undefined): string[] {
  if (!value?.trim()) {
    return [...DUMMY_DOCKER_RUNNER_ARGS];
  }

  const parsed: unknown = JSON.parse(value);

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${DOCKER_RUNNER_ARGS_ENV} must be a JSON string array.`);
  }

  return parsed;
}

function normalizeDockerTimestamp(value: string | undefined): string | null {
  if (!value || value.startsWith("0001-01-01")) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function dockerContainerName(agentId: string, suffix: string): string {
  return `bruno-runner-${agentId}-${suffix}`.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 120);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafePlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor,
  );
}

function isExactSafeRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isSafePlainRecord(value)) {
    return false;
  }

  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();

  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function safeOwnValue(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
