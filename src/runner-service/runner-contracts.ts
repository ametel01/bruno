import type { AgentLaunchSpec } from "@/src/server/agents/agent-launch-spec";

export const RUNNER_LAUNCH_CONTRACT_VERSION = "agentbay.runner.launch.v2" as const;
export const LEGACY_RUNNER_STATUS_CONTRACT_VERSION = "agentbay.runner.status.v2" as const;
export const RUNNER_STATUS_CONTRACT_VERSION = "agentbay.runner.status.v3" as const;
export const RUNNER_CANARY_CONTRACT_VERSION = "agentbay.runner.canary.v1" as const;
export const RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION = "bruno.runner.boot-snapshot.v1" as const;
export const MAX_RUNNER_RESTART_COUNT = 2_147_483_647;
export const MAX_RUNNER_IMAGE_IDENTITY_DIGESTS = 16;
export const MAX_RUNNER_IMAGE_REFERENCE_LENGTH = 512;

export type RunnerLaunchAction = "start" | "restart";
export type RunnerLaunchDisposition = "created" | "reused" | "replaced";
export type RunnerContainerState =
  | "absent"
  | "created"
  | "running"
  | "restarting"
  | "paused"
  | "exited"
  | "dead"
  | "removing"
  | "unknown";
export type RunnerSnapshotPhase =
  | "idle"
  | "accepted"
  | "starting"
  | "ready"
  | "failed"
  | "stopped"
  | "cancelled";
export type RunnerPlatformState =
  | "unknown"
  | "connecting"
  | "connected"
  | "disconnected"
  | "retrying"
  | "fatal"
  | "paused"
  | "failed"
  | "disabled";
export type RunnerTelegramState = Exclude<RunnerPlatformState, "failed">;
export type RunnerRestartPolicyName = "no" | "always" | "unless-stopped" | "on-failure" | "unknown";
export type RunnerImageIdentity = {
  imageId: string;
  repoDigests: string[];
};
export type RunnerGatewayState = "unknown" | "starting" | "running" | "failed" | "stopped";
export type RunnerRevisionState = "match" | "mismatch" | "missing" | "unreadable" | "unknown";
export type RunnerReadinessReason =
  | null
  | "launch_accepted"
  | "launch_cancelled"
  | "container_absent"
  | "container_not_running"
  | "container_terminal"
  | "revision_missing"
  | "revision_mismatch"
  | "probe_credential_unavailable"
  | "health_unauthorized"
  | "health_unreachable"
  | "health_timeout"
  | "health_invalid"
  | "gateway_starting"
  | "gateway_failed"
  | "api_server_not_connected"
  | "telegram_not_connected"
  | "telegram_retrying"
  | "telegram_fatal"
  | "telegram_paused"
  | "readiness_timeout";

export type RunnerOperationTarget = {
  image: string;
  launchSpecVersion: string;
  configRevision: string;
};

export type RunnerOperation = {
  id: string;
  action: RunnerLaunchAction;
  target: RunnerOperationTarget;
  acceptedAt: string;
};

export type RunnerAgentStatusSnapshot = {
  phase: RunnerSnapshotPhase;
  operation: RunnerOperation | null;
  container: {
    id: string | null;
    name: string | null;
    image: string | null;
    state: RunnerContainerState;
    startedAt: string | null;
    finishedAt: string | null;
    observedAt: string;
  };
  revision: {
    state: RunnerRevisionState;
    requested: string | null;
    containerLabel: string | null;
    projectionMarker: string | null;
    observedAt: string;
  };
  gateway: {
    state: RunnerGatewayState;
    observedAt: string | null;
  };
  apiServer: {
    required: boolean;
    state: RunnerPlatformState;
    observedAt: string | null;
  };
  telegram: {
    required: boolean;
    state: RunnerPlatformState;
    observedAt: string | null;
  };
  readinessReason: RunnerReadinessReason;
  observedAt: string;
};

export type RunnerDurableStatusSnapshot = Omit<
  RunnerAgentStatusSnapshot,
  "container" | "telegram"
> & {
  container: RunnerAgentStatusSnapshot["container"] & {
    imageIdentity?: RunnerImageIdentity | null;
    restartPolicy: {
      name: RunnerRestartPolicyName;
      maximumRetryCount: number | null;
    };
    restartCount: number | null;
  };
  telegram: Omit<RunnerAgentStatusSnapshot["telegram"], "state"> & {
    state: RunnerTelegramState;
  };
};

export type RunnerReportedDurableStatusSnapshot = Omit<RunnerDurableStatusSnapshot, "container"> & {
  container: Omit<RunnerDurableStatusSnapshot["container"], "imageIdentity"> & {
    imageIdentity: RunnerImageIdentity | null;
  };
};

export type RunnerLaunchAcceptedResponse = {
  ok: true;
  contractVersion: typeof RUNNER_LAUNCH_CONTRACT_VERSION;
  agentId: string;
  action: RunnerLaunchAction;
  operation: {
    id: string;
    state: "accepted";
    disposition: RunnerLaunchDisposition;
    target: RunnerOperationTarget;
    acceptedAt: string;
  };
  snapshot: RunnerAgentStatusSnapshot;
};

export type RunnerStatusResponse = {
  ok: true;
  contractVersion: typeof RUNNER_STATUS_CONTRACT_VERSION;
  agentId: string;
  action: "status";
  snapshot: RunnerReportedDurableStatusSnapshot;
};

export type ParsedRunnerStatusResponse = Omit<
  RunnerStatusResponse,
  "contractVersion" | "snapshot"
> & {
  contractVersion:
    | typeof RUNNER_STATUS_CONTRACT_VERSION
    | typeof LEGACY_RUNNER_STATUS_CONTRACT_VERSION;
  snapshot: RunnerDurableStatusSnapshot;
};

export type RunnerImageAttestationResult =
  | { ok: true; digest: string }
  | {
      ok: false;
      reason:
        | "status_invalid"
        | "status_not_ready"
        | "expected_image_invalid"
        | "image_identity_unavailable"
        | "configured_image_mismatch"
        | "repo_digest_mismatch";
    };

export type RunnerCanaryObservation = {
  state: "passed" | "failed";
  reason:
    | null
    | "canary_unauthorized"
    | "canary_unreachable"
    | "canary_timeout"
    | "canary_invalid_response"
    | "canary_model_failed";
  observedAt: string;
  latencyMs: number;
};

export type RunnerCanaryResponse = {
  ok: true;
  contractVersion: typeof RUNNER_CANARY_CONTRACT_VERSION;
  agentId: string;
  action: "canary";
  operationId: string;
  configRevision: string;
  observation: RunnerCanaryObservation;
};

export type RunnerCanaryRequest = {
  operationId: string;
  configRevision: string;
  model: string;
};

export const RUNNER_BOOT_COMPONENTS = [
  "docker",
  "hermesFixture",
  "detailedHealth",
  "modelCanary",
  "telegramConfig",
  "cleanup",
] as const;

export type RunnerBootComponent = (typeof RUNNER_BOOT_COMPONENTS)[number];
export type RunnerBootComponentState = "pending" | "passed" | "failed" | "skipped";
export type RunnerBootSnapshotStatus = "testing" | "ready" | "failed";
export type RunnerBootFailureReason =
  | null
  | "docker_unavailable"
  | "release_mismatch"
  | "fixture_launch_failed"
  | "detailed_health_failed"
  | "canary_failed"
  | "telegram_config_failed"
  | "cleanup_failed"
  | "deadline_exceeded"
  | "snapshot_invalid";

export type RunnerBootSnapshot = {
  ok: true;
  contractVersion: typeof RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION;
  status: RunnerBootSnapshotStatus;
  components: Record<RunnerBootComponent, RunnerBootComponentState>;
  failureReason: RunnerBootFailureReason;
  startedAt: string;
  completedAt: string | null;
};

export function parseRunnerBootSnapshot(value: unknown): RunnerBootSnapshot | null {
  if (
    !isExactRecord(value, [
      "completedAt",
      "components",
      "contractVersion",
      "failureReason",
      "ok",
      "startedAt",
      "status",
    ]) ||
    value.ok !== true ||
    value.contractVersion !== RUNNER_BOOT_SNAPSHOT_CONTRACT_VERSION ||
    !["testing", "ready", "failed"].includes(value.status as never) ||
    !isRunnerIsoTimestamp(value.startedAt) ||
    !isNullableIsoTimestamp(value.completedAt) ||
    ![
      null,
      "docker_unavailable",
      "release_mismatch",
      "fixture_launch_failed",
      "detailed_health_failed",
      "canary_failed",
      "telegram_config_failed",
      "cleanup_failed",
      "deadline_exceeded",
      "snapshot_invalid",
    ].includes(value.failureReason as never) ||
    !isExactRecord(value.components, RUNNER_BOOT_COMPONENTS)
  ) {
    return null;
  }

  const components = value.components as Record<string, unknown>;
  const states = RUNNER_BOOT_COMPONENTS.map((component) => components[component]);
  if (
    !states.every((state) => ["pending", "passed", "failed", "skipped"].includes(state as never))
  ) {
    return null;
  }
  if (
    RUNNER_BOOT_COMPONENTS.some(
      (component) => components[component] === "skipped" && component !== "modelCanary",
    )
  ) {
    return null;
  }

  const isReady = value.status === "ready";
  const isTesting = value.status === "testing";
  if (
    (isReady &&
      (value.failureReason !== null ||
        value.completedAt === null ||
        !states.every((state) => state === "passed" || state === "skipped"))) ||
    (isTesting && (value.failureReason !== null || value.completedAt !== null)) ||
    (value.status === "failed" &&
      (value.failureReason === null || value.completedAt === null || !states.includes("failed")))
  ) {
    return null;
  }

  return value as RunnerBootSnapshot;
}

export type RunnerStopResponsePayload = {
  cancelledOperationId: string | null;
  containers: Array<{
    id: string;
    name?: string;
    image?: string;
    status: string;
    startedAt?: string | null;
    finishedAt?: string | null;
  }>;
  snapshot: RunnerAgentStatusSnapshot;
};

export type RunnerCleanupResponsePayload = RunnerStopResponsePayload & {
  removedAgentRoot: boolean;
};

export function runnerTargetFromLaunchSpec(spec: AgentLaunchSpec): RunnerOperationTarget {
  return {
    image: spec.image.ref,
    launchSpecVersion: spec.version,
    configRevision: spec.agent.configRevision,
  };
}

export function isRunnerUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  );
}

export function isRunnerIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    return false;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function parseRunnerCanaryRequest(
  value: unknown,
): { ok: true; request: RunnerCanaryRequest } | { ok: false; reason: "canary_invalid" } {
  if (!isRecord(value)) {
    return { ok: false, reason: "canary_invalid" };
  }

  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "configRevision,model,operationId") {
    return { ok: false, reason: "canary_invalid" };
  }

  const operationId = value.operationId;
  const configRevision = value.configRevision;
  const model = typeof value.model === "string" ? value.model.trim() : "";

  if (
    !isRunnerUuid(operationId) ||
    !isRunnerConfigRevision(configRevision) ||
    model.length < 1 ||
    model.length > 200 ||
    !/^[A-Za-z0-9._:/@+-]+$/.test(model)
  ) {
    return { ok: false, reason: "canary_invalid" };
  }

  return { ok: true, request: { operationId, configRevision, model } };
}

export function parseRunnerLaunchAccepted(
  value: unknown,
): { ok: true; response: RunnerLaunchAcceptedResponse } | { ok: false } {
  if (
    !isExactRecord(value, [
      "action",
      "agentId",
      "contractVersion",
      "ok",
      "operation",
      "snapshot",
    ]) ||
    value.ok !== true ||
    value.contractVersion !== RUNNER_LAUNCH_CONTRACT_VERSION
  ) {
    return { ok: false };
  }

  if (!isRunnerUuid(value.agentId) || (value.action !== "start" && value.action !== "restart")) {
    return { ok: false };
  }

  if (
    !isExactRecord(value.operation, ["acceptedAt", "disposition", "id", "state", "target"]) ||
    value.operation.state !== "accepted"
  ) {
    return { ok: false };
  }

  if (
    !isRunnerUuid(value.operation.id) ||
    !["created", "reused", "replaced"].includes(String(value.operation.disposition)) ||
    !isRunnerIsoTimestamp(value.operation.acceptedAt) ||
    !isOperationTarget(value.operation.target) ||
    !isRunnerStatusSnapshot(value.snapshot) ||
    value.snapshot.phase !== "accepted" ||
    value.snapshot.readinessReason !== "launch_accepted" ||
    value.snapshot.operation?.id !== value.operation.id ||
    value.snapshot.operation.acceptedAt !== value.operation.acceptedAt ||
    !sameOperationTarget(value.snapshot.operation.target, value.operation.target)
  ) {
    return { ok: false };
  }

  return { ok: true, response: value as RunnerLaunchAcceptedResponse };
}

export function parseRunnerStatus(
  value: unknown,
): { ok: true; response: ParsedRunnerStatusResponse } | { ok: false } {
  if (
    !isExactRecord(value, ["action", "agentId", "contractVersion", "ok", "snapshot"]) ||
    value.ok !== true ||
    value.action !== "status" ||
    !isRunnerUuid(value.agentId)
  ) {
    return { ok: false };
  }

  if (
    value.contractVersion === RUNNER_STATUS_CONTRACT_VERSION &&
    isRunnerDurableStatusSnapshot(value.snapshot)
  ) {
    return { ok: true, response: value as RunnerStatusResponse };
  }

  if (
    value.contractVersion === RUNNER_STATUS_CONTRACT_VERSION &&
    isRunnerDurableStatusSnapshotWithoutImageIdentity(value.snapshot)
  ) {
    return {
      ok: true,
      response: {
        ok: true,
        contractVersion: RUNNER_STATUS_CONTRACT_VERSION,
        agentId: value.agentId,
        action: "status",
        snapshot: normalizeUnattestedV3StatusSnapshot(value.snapshot),
      },
    };
  }

  if (
    value.contractVersion !== LEGACY_RUNNER_STATUS_CONTRACT_VERSION ||
    !isRunnerStatusSnapshot(value.snapshot)
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    response: {
      ok: true,
      contractVersion: LEGACY_RUNNER_STATUS_CONTRACT_VERSION,
      agentId: value.agentId,
      action: "status",
      snapshot: normalizeLegacyStatusSnapshot(value.snapshot),
    },
  };
}

export function hasExactRunnerDurabilityEvidence(snapshot: RunnerDurableStatusSnapshot): boolean {
  return (
    snapshot.container.restartPolicy.name === "unless-stopped" &&
    snapshot.container.restartPolicy.maximumRetryCount === 0 &&
    snapshot.container.restartCount !== null
  );
}

/**
 * Produces the deliberately small image-attestation result used by controlled staging rollout.
 * Normal runtime readiness remains compatible with pre-attestation status-v3 runners, but this
 * proof fails closed until a new runner reports bounded Docker image identity evidence.
 */
export function attestManagedHermesImageIdentity(
  value: unknown,
  expectedDigestRef: unknown,
): RunnerImageAttestationResult {
  const parsed = parseRunnerStatus(value);

  if (!parsed.ok) {
    return { ok: false, reason: "status_invalid" };
  }

  if (!isRunnerStatusExactReady(parsed.response)) {
    return { ok: false, reason: "status_not_ready" };
  }

  const expected = parseDigestQualifiedImageReference(expectedDigestRef);

  if (!expected) {
    return { ok: false, reason: "expected_image_invalid" };
  }

  const snapshot = parsed.response.snapshot;
  const identity = snapshot.container.imageIdentity;

  if (!identity) {
    return { ok: false, reason: "image_identity_unavailable" };
  }

  if (
    snapshot.container.image !== expected.ref ||
    snapshot.operation?.target.image !== expected.ref
  ) {
    return { ok: false, reason: "configured_image_mismatch" };
  }

  if (!identity.repoDigests.includes(expected.repoDigest)) {
    return { ok: false, reason: "repo_digest_mismatch" };
  }

  return { ok: true, digest: expected.digest };
}

export function isRunnerStatusExactReady(response: ParsedRunnerStatusResponse): boolean {
  return (
    response.contractVersion === RUNNER_STATUS_CONTRACT_VERSION &&
    response.snapshot.phase === "ready" &&
    hasExactRunnerDurabilityEvidence(response.snapshot)
  );
}

export function parseRunnerCanary(
  value: unknown,
): { ok: true; response: RunnerCanaryResponse } | { ok: false } {
  if (
    !isExactRecord(value, [
      "action",
      "agentId",
      "configRevision",
      "contractVersion",
      "observation",
      "ok",
      "operationId",
    ]) ||
    value.ok !== true ||
    value.contractVersion !== RUNNER_CANARY_CONTRACT_VERSION ||
    value.action !== "canary" ||
    !isRunnerUuid(value.agentId) ||
    !isRunnerUuid(value.operationId) ||
    !isRunnerConfigRevision(value.configRevision) ||
    !isExactRecord(value.observation, ["latencyMs", "observedAt", "reason", "state"])
  ) {
    return { ok: false };
  }

  const observation = value.observation;

  const reason = observation.reason;
  if (
    (observation.state !== "passed" && observation.state !== "failed") ||
    ![
      null,
      "canary_unauthorized",
      "canary_unreachable",
      "canary_timeout",
      "canary_invalid_response",
      "canary_model_failed",
    ].includes(reason as never) ||
    (observation.state === "passed" ? reason !== null : reason === null) ||
    !isRunnerIsoTimestamp(observation.observedAt) ||
    typeof observation.latencyMs !== "number" ||
    !Number.isFinite(observation.latencyMs) ||
    observation.latencyMs < 0
  ) {
    return { ok: false };
  }

  return { ok: true, response: value as RunnerCanaryResponse };
}

export function isRunnerStatusSnapshot(value: unknown): value is RunnerAgentStatusSnapshot {
  if (
    !isExactRecord(value, [
      "apiServer",
      "container",
      "gateway",
      "observedAt",
      "operation",
      "phase",
      "readinessReason",
      "revision",
      "telegram",
    ]) ||
    !isExactRecord(value.container, [
      "finishedAt",
      "id",
      "image",
      "name",
      "observedAt",
      "startedAt",
      "state",
    ]) ||
    !isExactRecord(value.revision, [
      "containerLabel",
      "observedAt",
      "projectionMarker",
      "requested",
      "state",
    ])
  ) {
    return false;
  }

  return (
    ["idle", "accepted", "starting", "ready", "failed", "stopped", "cancelled"].includes(
      String(value.phase),
    ) &&
    (value.operation === null || isRunnerOperation(value.operation)) &&
    isNullableString(value.container.id) &&
    isNullableString(value.container.name) &&
    isNullableString(value.container.image) &&
    [
      "absent",
      "created",
      "running",
      "restarting",
      "paused",
      "exited",
      "dead",
      "removing",
      "unknown",
    ].includes(String(value.container.state)) &&
    isNullableIsoTimestamp(value.container.startedAt) &&
    isNullableIsoTimestamp(value.container.finishedAt) &&
    isRunnerIsoTimestamp(value.container.observedAt) &&
    ["match", "mismatch", "missing", "unreadable", "unknown"].includes(
      String(value.revision.state),
    ) &&
    isNullableString(value.revision.requested) &&
    isNullableString(value.revision.containerLabel) &&
    isNullableString(value.revision.projectionMarker) &&
    isRunnerIsoTimestamp(value.revision.observedAt) &&
    isExactRecord(value.gateway, ["observedAt", "state"]) &&
    ["unknown", "starting", "running", "failed", "stopped"].includes(String(value.gateway.state)) &&
    isNullableIsoTimestamp(value.gateway.observedAt) &&
    isExactRecord(value.apiServer, ["observedAt", "required", "state"]) &&
    typeof value.apiServer.required === "boolean" &&
    ["unknown", "connecting", "connected", "disconnected", "failed", "disabled"].includes(
      String(value.apiServer.state),
    ) &&
    isNullableIsoTimestamp(value.apiServer.observedAt) &&
    isExactRecord(value.telegram, ["observedAt", "required", "state"]) &&
    typeof value.telegram.required === "boolean" &&
    ["unknown", "connecting", "connected", "disconnected", "failed", "disabled"].includes(
      String(value.telegram.state),
    ) &&
    isNullableIsoTimestamp(value.telegram.observedAt) &&
    isNullableReadinessReason(value.readinessReason) &&
    isSnapshotPhaseInvariant(value) &&
    isRunnerIsoTimestamp(value.observedAt)
  );
}

export function isRunnerDurableStatusSnapshot(
  value: unknown,
): value is RunnerReportedDurableStatusSnapshot {
  if (
    !isRecord(value) ||
    !isExactRecord(value.container, [
      "finishedAt",
      "id",
      "image",
      "imageIdentity",
      "name",
      "observedAt",
      "restartCount",
      "restartPolicy",
      "startedAt",
      "state",
    ]) ||
    !isNullableRunnerImageIdentity(value.container.imageIdentity) ||
    !isExactRecord(value.container.restartPolicy, ["maximumRetryCount", "name"]) ||
    !isExactRecord(value.telegram, ["observedAt", "required", "state"])
  ) {
    return false;
  }

  const {
    imageIdentity: _imageIdentity,
    restartCount: _restartCount,
    restartPolicy: _restartPolicy,
    ...legacyContainer
  } = value.container;
  const legacyShape = {
    ...value,
    container: legacyContainer,
    telegram: {
      ...value.telegram,
      state:
        value.telegram.state === "retrying" ||
        value.telegram.state === "fatal" ||
        value.telegram.state === "paused"
          ? "failed"
          : value.telegram.state,
    },
  };

  return (
    isRunnerStatusSnapshot(legacyShape) &&
    isRunnerRestartPolicyName(value.container.restartPolicy.name) &&
    isNullableBoundedRestartCount(value.container.restartPolicy.maximumRetryCount) &&
    isNullableBoundedRestartCount(value.container.restartCount) &&
    [
      "unknown",
      "connecting",
      "connected",
      "disconnected",
      "retrying",
      "fatal",
      "paused",
      "disabled",
    ].includes(String(value.telegram.state))
  );
}

function normalizeLegacyStatusSnapshot(
  snapshot: RunnerAgentStatusSnapshot,
): RunnerDurableStatusSnapshot {
  return {
    ...snapshot,
    container: {
      ...snapshot.container,
      imageIdentity: null,
      restartPolicy: { name: "unknown", maximumRetryCount: null },
      restartCount: null,
    },
    telegram: {
      ...snapshot.telegram,
      state: snapshot.telegram.state === "failed" ? "unknown" : snapshot.telegram.state,
    },
  };
}

function normalizeUnattestedV3StatusSnapshot(
  snapshot: RunnerDurableStatusSnapshotWithoutImageIdentity,
): RunnerDurableStatusSnapshot {
  return {
    ...snapshot,
    container: {
      ...snapshot.container,
      imageIdentity: null,
    },
  };
}

type RunnerDurableStatusSnapshotWithoutImageIdentity = Omit<
  RunnerDurableStatusSnapshot,
  "container"
> & {
  container: Omit<RunnerDurableStatusSnapshot["container"], "imageIdentity">;
};

function isRunnerDurableStatusSnapshotWithoutImageIdentity(
  value: unknown,
): value is RunnerDurableStatusSnapshotWithoutImageIdentity {
  if (
    !isRecord(value) ||
    !isExactRecord(value.container, [
      "finishedAt",
      "id",
      "image",
      "name",
      "observedAt",
      "restartCount",
      "restartPolicy",
      "startedAt",
      "state",
    ])
  ) {
    return false;
  }

  return isRunnerDurableStatusSnapshot({
    ...value,
    container: { ...value.container, imageIdentity: null },
  });
}

function isNullableRunnerImageIdentity(value: unknown): value is RunnerImageIdentity | null {
  if (value === null) {
    return true;
  }

  if (
    !isExactRecord(value, ["imageId", "repoDigests"]) ||
    !isDockerContentDigest(value.imageId) ||
    !Array.isArray(value.repoDigests) ||
    value.repoDigests.length > MAX_RUNNER_IMAGE_IDENTITY_DIGESTS
  ) {
    return false;
  }

  const repoDigests = value.repoDigests;

  return repoDigests.every((digest, index) => {
    const previous = repoDigests[index - 1];

    return (
      typeof digest === "string" &&
      digest.length <= MAX_RUNNER_IMAGE_REFERENCE_LENGTH &&
      parseDigestQualifiedImageReference(digest)?.repoDigest === digest &&
      (previous === undefined || (typeof previous === "string" && previous < digest))
    );
  });
}

function parseDigestQualifiedImageReference(
  value: unknown,
): { ref: string; repository: string; repoDigest: string; digest: string } | null {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_RUNNER_IMAGE_REFERENCE_LENGTH ||
    containsUnsafeText(value)
  ) {
    return null;
  }

  const match = /^([^@]+)@(sha256:[0-9a-f]{64})$/.exec(value);

  if (!match?.[1] || !match[2]) {
    return null;
  }

  const namedReference = match[1];
  const finalSlash = namedReference.lastIndexOf("/");
  const finalColon = namedReference.lastIndexOf(":");
  const repository = finalColon > finalSlash ? namedReference.slice(0, finalColon) : namedReference;

  if (
    repository.length < 1 ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
      repository,
    ) ||
    (namedReference !== repository &&
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(namedReference.slice(finalColon + 1)))
  ) {
    return null;
  }

  return {
    ref: value,
    repository,
    repoDigest: `${repository}@${match[2]}`,
    digest: match[2],
  };
}

function isDockerContentDigest(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isRunnerRestartPolicyName(value: unknown): value is RunnerRestartPolicyName {
  return ["no", "always", "unless-stopped", "on-failure", "unknown"].includes(value as never);
}

function isNullableBoundedRestartCount(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_RUNNER_RESTART_COUNT)
  );
}

function isRunnerOperation(value: unknown): value is RunnerOperation {
  return (
    isExactRecord(value, ["acceptedAt", "action", "id", "target"]) &&
    isRunnerUuid(value.id) &&
    (value.action === "start" || value.action === "restart") &&
    isOperationTarget(value.target) &&
    isRunnerIsoTimestamp(value.acceptedAt)
  );
}

function isOperationTarget(value: unknown): value is RunnerOperationTarget {
  return (
    isExactRecord(value, ["configRevision", "image", "launchSpecVersion"]) &&
    typeof value.image === "string" &&
    value.image.length >= 1 &&
    value.image.length <= 512 &&
    !containsUnsafeText(value.image) &&
    typeof value.launchSpecVersion === "string" &&
    value.launchSpecVersion.length >= 1 &&
    value.launchSpecVersion.length <= 128 &&
    !containsUnsafeText(value.launchSpecVersion) &&
    isRunnerConfigRevision(value.configRevision)
  );
}

function sameOperationTarget(left: RunnerOperationTarget, right: RunnerOperationTarget): boolean {
  return (
    left.image === right.image &&
    left.launchSpecVersion === right.launchSpecVersion &&
    left.configRevision === right.configRevision
  );
}

function isRunnerConfigRevision(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function containsUnsafeText(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

function isSnapshotPhaseInvariant(value: Record<string, unknown>): boolean {
  const phase = value.phase;
  const operation = value.operation;
  const reason = value.readinessReason;
  const container = value.container as Record<string, unknown>;
  const revision = value.revision as Record<string, unknown>;
  const gateway = value.gateway as Record<string, unknown>;
  const apiServer = value.apiServer as Record<string, unknown>;
  const telegram = value.telegram as Record<string, unknown>;

  if (phase === "idle") {
    return operation === null && container.state === "absent" && reason === "container_absent";
  }

  if (phase === "accepted") {
    return operation !== null && reason === "launch_accepted";
  }

  if (phase === "ready") {
    return (
      operation !== null &&
      reason === null &&
      container.state === "running" &&
      revision.state === "match" &&
      gateway.state === "running" &&
      apiServer.state === "connected" &&
      (telegram.required === false || telegram.state === "connected")
    );
  }

  if (phase === "starting") {
    return operation !== null && reason !== null;
  }

  if (phase === "failed") {
    return reason !== null;
  }

  if (phase === "stopped" || phase === "cancelled") {
    return reason === "launch_cancelled";
  }

  return false;
}

function isNullableReadinessReason(value: unknown): value is RunnerReadinessReason {
  return [
    null,
    "launch_accepted",
    "launch_cancelled",
    "container_absent",
    "container_not_running",
    "container_terminal",
    "revision_missing",
    "revision_mismatch",
    "probe_credential_unavailable",
    "health_unauthorized",
    "health_unreachable",
    "health_timeout",
    "health_invalid",
    "gateway_starting",
    "gateway_failed",
    "api_server_not_connected",
    "telegram_not_connected",
    "telegram_retrying",
    "telegram_fatal",
    "telegram_paused",
    "readiness_timeout",
  ].includes(value as never);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNullableIsoTimestamp(value: unknown): value is string | null {
  return value === null || isRunnerIsoTimestamp(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (descriptor) => "value" in descriptor,
    )
  );
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();

  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
