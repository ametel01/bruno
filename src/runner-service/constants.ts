export const AGENTBAY_AGENT_ID_LABEL = "agentbay.agent_id";
export const DEFAULT_MANUAL_RUNNER_IMAGE = "busybox:1.36";
export const DEFAULT_HERMES_WORKLOAD_IMAGE =
  "nousresearch/hermes-agent:v2026.7.7.2@sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973";
export const DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST =
  "sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973";
export const DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST =
  "sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a";
export const DEFAULT_HERMES_PRIVATE_NETWORK = "agentbay-hermes";
export const DEFAULT_HERMES_READINESS_TIMEOUT_MS = 180_000;
export const DEFAULT_HERMES_RUNNER_MAX_AGENTS = 1;
export const DEFAULT_HERMES_DOCKER_CPUS = "1";
export const DEFAULT_HERMES_DOCKER_MEMORY = "1536m";
export const DEFAULT_HERMES_DOCKER_PIDS_LIMIT = "256";
export const DEFAULT_HERMES_STATE_ROOT = "/var/lib/agentbay/agents";
export const DEFAULT_RUNNER_BOOT_SELF_TEST_ROOT = "/var/lib/agentbay/boot-self-test";
export const RUNNER_BOOT_MODEL_CANARY_ENABLED_ENV = "AGENTBAY_RUNNER_BOOT_MODEL_CANARY_ENABLED";
export const DOCKER_CLI_TIMEOUT_MS = 30_000;
export const RUNNER_BOOT_CONTRACT_VERSION = "bruno.runner.boot.v1";
export const RUNNER_RELEASE_VERSION_MAX_LENGTH = 80;
export const RUNNER_BOOT_CONTRACT_VERSION_MAX_LENGTH = 80;
export const RUNNER_RELEASE_DOCKER_OUTPUT_MAX_BYTES = 32 * 1024;
export const RUNNER_RELEASE_MAX_REPO_DIGESTS = 16;
export const RUNNER_OCI_REVISION_LABEL = "org.opencontainers.image.revision";
export const RUNNER_OCI_VERSION_LABEL = "org.opencontainers.image.version";
