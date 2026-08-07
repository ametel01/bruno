import "server-only";

import {
  createRunnerSnapshotAttestation,
  type RunnerSnapshotManifest,
} from "./runner-snapshot-manifest";
import {
  DEFAULT_HERMES_WORKLOAD_IMAGE,
  DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
  DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
  DEFAULT_MANUAL_RUNNER_IMAGE,
  RUNNER_BOOT_CONTRACT_VERSION,
} from "@/src/runner-service/constants";
import { parseImmutableRunnerImageReference } from "@/src/runner-service/release-identity";
import type {
  DigitalOceanAction,
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
  DigitalOceanProvider,
  DigitalOceanProviderRequestContext,
  DigitalOceanResource,
} from "@/src/server/runners/digitalocean-provider";

const SNAPSHOT_AUTHORIZATION_SENTINEL = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";
const SNAPSHOT_OPERATION_TAG_PREFIX = "agentbay-snapshot-build";
const SNAPSHOT_BUILDER_NAME_PREFIX = "agentbay-snapshot-builder";
const SNAPSHOT_MIN_DISK_GB = 25;

export type BuildRunnerSnapshotInput = {
  costAuthorization: string;
  operationId: string;
  sourceRevision: string;
  region: string;
  sizeSlug: string;
  baseImageId: string;
  baseImageSlug: string;
  runnerImage: string;
  defaultAgentImage?: string;
  hermesImage?: string;
  builderSshKeyId?: string;
  builderSshPrivateKeyPath?: string;
  privateKeyPem: string;
  provider: DigitalOceanProvider;
  context: DigitalOceanProviderRequestContext;
  now?: () => Date;
  actionPollAttempts?: number;
  actionPollIntervalMs?: number;
};

export type SnapshotBootFixtureResult = {
  ok: boolean;
  builderResourceId?: string;
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
  bootContractVersion: string;
  preloadedImages?: string[];
  completedAt: string;
};

export type SnapshotSanitationResult = {
  ok: boolean;
  builderResourceId?: string;
  forbiddenPathsAbsent: boolean;
  hostileMarkersAbsent: boolean;
  removedPaths?: string[];
  scannedPaths?: string[];
  hostileMarkers?: string[];
  completedAt: string;
};

export type BuildRunnerSnapshotResult =
  | {
      ok: true;
      manifest: RunnerSnapshotManifest;
      manifestBytes: string;
      digest: string;
      signature: string;
      bootResult: SnapshotBootFixtureResult;
      sanitationResult: SnapshotSanitationResult;
      cleanup: SnapshotCleanupEvidence;
    }
  | {
      ok: false;
      reason: BuildRunnerSnapshotFailureReason;
      cleanup: SnapshotCleanupEvidence;
    };

export type BuildRunnerSnapshotFailureReason =
  | "authorization_missing"
  | "input_invalid"
  | "provider_contract_missing"
  | "builder_create_failed"
  | "boot_fixture_failed"
  | "sanitation_failed"
  | "power_off_failed"
  | "snapshot_failed"
  | "snapshot_unavailable";

export type SnapshotCleanupEvidence = {
  deletedSnapshotId: string | null;
  deletedDropletId: string | null;
  deletedFirewallId: string | null;
  ambiguousOwnership: boolean;
  absenceVerified: boolean;
  steps: string[];
};

export async function buildRunnerSnapshot(
  input: BuildRunnerSnapshotInput,
): Promise<BuildRunnerSnapshotResult> {
  const cleanup: SnapshotCleanupEvidence = {
    deletedSnapshotId: null,
    deletedDropletId: null,
    deletedFirewallId: null,
    ambiguousOwnership: false,
    absenceVerified: false,
    steps: [],
  };
  const now = input.now ?? (() => new Date());
  let builder: DigitalOceanResource | null = null;
  let snapshotId: string | null = null;

  const validated = validateSnapshotBuildInput(input);
  if (!validated.ok) {
    return { ok: false, reason: validated.reason, cleanup };
  }

  if (
    !input.provider.powerOffResource ||
    !input.provider.snapshotResource ||
    !input.provider.readAction ||
    !input.provider.readImageAvailability ||
    !input.provider.findSnapshotImageByName ||
    !input.provider.readSnapshotBuilderEvidence ||
    !input.provider.deleteImage
  ) {
    return { ok: false, reason: "provider_contract_missing", cleanup };
  }

  const ownedSetProvider = asOwnedSetProvider(input.provider);

  if (!ownedSetProvider) {
    return { ok: false, reason: "provider_contract_missing", cleanup };
  }

  try {
    const operationTag = `${SNAPSHOT_OPERATION_TAG_PREFIX}-${input.operationId}`;
    const snapshotName = `${SNAPSHOT_BUILDER_NAME_PREFIX}-${input.sourceRevision.slice(0, 12)}`;
    const firewallName = `${snapshotName}-firewall`;
    const created = await input.provider.createRunner(
      {
        name: snapshotName,
        region: input.region,
        sizeSlug: input.sizeSlug,
        image: input.baseImageSlug,
        tags: [SNAPSHOT_OPERATION_TAG_PREFIX, operationTag],
        firewallName,
        ...(input.builderSshKeyId ? { sshKeyIds: [input.builderSshKeyId] } : {}),
        userData: buildSnapshotBuilderBootstrap({
          runnerImage: input.runnerImage,
          defaultAgentImage: validated.defaultAgentImage,
          hermesImage: validated.hermesImage,
        }),
      },
      input.context,
    );
    cleanup.steps.push("create_builder");

    if (!created.ok) {
      return { ok: false, reason: "builder_create_failed", cleanup };
    }

    builder = created.value;

    const firewalled = await input.provider.applyFirewall(
      {
        providerResourceId: builder.providerResourceId,
        firewallName,
        sshSourceAddresses: ["0.0.0.0/0", "::/0"],
      },
      input.context,
    );
    cleanup.steps.push("create_firewall");

    if (!firewalled.ok) {
      return { ok: false, reason: "builder_create_failed", cleanup };
    }

    builder = firewalled.value;

    const evidence = await input.provider.readSnapshotBuilderEvidence(
      {
        providerResourceId: builder.providerResourceId,
        ...(input.builderSshPrivateKeyPath
          ? { privateKeyPath: input.builderSshPrivateKeyPath }
          : {}),
      },
      input.context,
    );
    cleanup.steps.push("read_builder_evidence");

    if (!evidence.ok) {
      return { ok: false, reason: "boot_fixture_failed", cleanup };
    }

    const bootResult = evidence.value.bootResult as SnapshotBootFixtureResult;
    const sanitationResult = evidence.value.sanitationResult as SnapshotSanitationResult;

    if (!bootFixtureMatches(bootResult, input, builder.providerResourceId)) {
      return { ok: false, reason: "boot_fixture_failed", cleanup };
    }

    if (!sanitationPassed(sanitationResult, builder.providerResourceId)) {
      return { ok: false, reason: "sanitation_failed", cleanup };
    }

    const powerOffAction = await input.provider.powerOffResource(
      { providerResourceId: builder.providerResourceId },
      input.context,
    );
    cleanup.steps.push("power_off");

    if (!powerOffAction.ok) {
      return { ok: false, reason: "power_off_failed", cleanup };
    }

    const poweredOff = await pollDigitalOceanAction({
      provider: input.provider,
      action: powerOffAction.value,
      context: input.context,
      ...(input.actionPollAttempts === undefined ? {} : { attempts: input.actionPollAttempts }),
      ...(input.actionPollIntervalMs === undefined
        ? {}
        : { intervalMs: input.actionPollIntervalMs }),
    });
    cleanup.steps.push("poll_power_off");

    if (!poweredOff.ok || poweredOff.action.status !== "completed") {
      return { ok: false, reason: "power_off_failed", cleanup };
    }

    const snapshotAction = await input.provider.snapshotResource(
      { providerResourceId: builder.providerResourceId, name: snapshotName },
      input.context,
    );
    cleanup.steps.push("snapshot");

    if (!snapshotAction.ok) {
      return { ok: false, reason: "snapshot_failed", cleanup };
    }

    const snapshot = await pollDigitalOceanAction({
      provider: input.provider,
      action: snapshotAction.value,
      context: input.context,
      ...(input.actionPollAttempts === undefined ? {} : { attempts: input.actionPollAttempts }),
      ...(input.actionPollIntervalMs === undefined
        ? {}
        : { intervalMs: input.actionPollIntervalMs }),
    });
    cleanup.steps.push("poll_snapshot");

    if (!snapshot.ok || snapshot.action.status !== "completed") {
      return { ok: false, reason: "snapshot_failed", cleanup };
    }

    const foundImage = await input.provider.findSnapshotImageByName(
      { name: snapshotName },
      input.context,
    );
    cleanup.steps.push("find_snapshot_image");

    if (!foundImage.ok || foundImage.value.id === snapshot.action.id) {
      return { ok: false, reason: "snapshot_unavailable", cleanup };
    }

    snapshotId = foundImage.value.id;
    const availability = await input.provider.readImageAvailability(
      { imageId: snapshotId },
      input.context,
    );
    cleanup.steps.push("read_snapshot");

    if (
      !availability.ok ||
      availability.value.status !== "available" ||
      availability.value.id !== foundImage.value.id ||
      availability.value.name !== snapshotName ||
      !availability.value.regions.includes(input.region) ||
      availability.value.minDiskSizeGb > SNAPSHOT_MIN_DISK_GB
    ) {
      return { ok: false, reason: "snapshot_unavailable", cleanup };
    }

    const availableAt = now().toISOString();
    const manifest: RunnerSnapshotManifest = {
      schemaVersion: "plingpling.runner.snapshot.v1",
      snapshot: {
        id: snapshotId,
        name: snapshotName,
        regions: availability.value.regions,
        minDiskSizeGb: availability.value.minDiskSizeGb,
        architecture: "amd64",
      },
      baseImage: { id: input.baseImageId, slug: input.baseImageSlug },
      runnerImage: {
        reference: input.runnerImage,
        digest: validated.runnerDigest,
      },
      defaultAgentImage: {
        reference: validated.defaultAgentImage,
        digest: validated.defaultAgentDigest,
      },
      hermesImage: {
        reference: validated.hermesImage,
        indexDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_INDEX_DIGEST,
        amd64ManifestDigest: DEFAULT_HERMES_WORKLOAD_IMAGE_AMD64_MANIFEST_DIGEST,
      },
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
      source: { repository: "ametel01/plingpling", revision: input.sourceRevision },
      workflow: { runId: input.operationId, runAttempt: "1" },
      validation: {
        fullBootFixturePassedAt: bootResult.completedAt,
        sanitationPassedAt: sanitationResult.completedAt,
      },
      createdAt: sanitationResult.completedAt,
      availableAt,
      expiresAt: new Date(new Date(availableAt).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString(),
    };
    const attestation = createRunnerSnapshotAttestation({
      manifest,
      privateKeyPem: input.privateKeyPem,
    });

    snapshotId = null;

    return {
      ok: true,
      manifest,
      manifestBytes: attestation.canonicalBytes,
      digest: attestation.digest,
      signature: attestation.signature,
      bootResult,
      sanitationResult,
      cleanup,
    };
  } finally {
    cleanup.steps.push("revoke_ephemeral_registration_token");
    cleanup.steps.push("revoke_ephemeral_registry_credential");
    if (input.builderSshKeyId && input.provider.deleteSshKey) {
      await input.provider.deleteSshKey({ id: input.builderSshKeyId }, input.context);
      cleanup.steps.push("delete_ephemeral_ssh_key");
    } else {
      cleanup.steps.push("delete_ephemeral_ssh_key");
    }

    if (snapshotId && input.provider.deleteImage) {
      const deleted = await input.provider.deleteImage({ imageId: snapshotId }, input.context);
      cleanup.steps.push("delete_partial_snapshot");
      if (deleted.ok) cleanup.deletedSnapshotId = snapshotId;
    }

    if (builder) {
      await cleanupOwnedBuilder({
        provider: input.provider,
        builder,
        operationTag: `${SNAPSHOT_OPERATION_TAG_PREFIX}-${input.operationId}`,
        cleanup,
        context: input.context,
      });
    }
  }
}

async function cleanupOwnedBuilder(input: {
  provider: DigitalOceanProvider;
  builder: DigitalOceanResource;
  operationTag: string;
  cleanup: SnapshotCleanupEvidence;
  context: DigitalOceanProviderRequestContext;
}): Promise<void> {
  const ownedSetProvider = asOwnedSetProvider(input.provider);
  const firewallId = input.builder.providerFirewallId;

  if (!ownedSetProvider || !firewallId) {
    input.cleanup.ambiguousOwnership = true;
    input.cleanup.steps.push("owned_cleanup_unavailable");
    return;
  }

  const expectation: DigitalOceanOwnedSetExpectation = {
    operationTag: input.operationTag,
    providerResourceId: input.builder.providerResourceId,
    providerFirewallId: firewallId,
    expectedName: input.builder.name,
    expectedRegion: input.builder.region,
    expectedSizeSlug: input.builder.sizeSlug,
    expectedFirewallName: `${input.builder.name}-firewall`,
  };

  const observed = await ownedSetProvider.observeOwnedSet(expectation, input.context);
  input.cleanup.steps.push("observe_owned_builder");
  if (!observed.ok) {
    input.cleanup.ambiguousOwnership = true;
    input.cleanup.steps.push("owned_builder_ambiguous");
    return;
  }

  const firewall = await ownedSetProvider.deleteFirewall(expectation, input.context);
  input.cleanup.steps.push("delete_firewall");
  if (!firewall.ok) {
    input.cleanup.ambiguousOwnership = true;
    return;
  }
  input.cleanup.deletedFirewallId = firewallId;

  const droplet = await ownedSetProvider.deleteDroplet(expectation, input.context);
  input.cleanup.steps.push("delete_builder");
  if (!droplet.ok) {
    input.cleanup.ambiguousOwnership = true;
    return;
  }
  input.cleanup.deletedDropletId = input.builder.providerResourceId;

  const verified = await ownedSetProvider.observeOwnedSet(expectation, input.context);
  input.cleanup.steps.push("verify_absence");
  if (verified.ok && verified.value.state === "absent") {
    input.cleanup.absenceVerified = true;
  } else {
    input.cleanup.ambiguousOwnership = true;
  }
}

async function pollDigitalOceanAction(input: {
  provider: DigitalOceanProvider;
  action: DigitalOceanAction;
  context: DigitalOceanProviderRequestContext;
  attempts?: number;
  intervalMs?: number;
}): Promise<{ ok: true; action: DigitalOceanAction } | { ok: false }> {
  const attempts = input.attempts ?? 30;
  const intervalMs = input.intervalMs ?? 5_000;
  let action = input.action;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (action.status === "errored" || input.context.signal.aborted) return { ok: false };
    if (!input.provider.readAction) return { ok: false };
    const read = await input.provider.readAction({ actionId: action.id }, input.context);
    if (!read.ok) return { ok: false };
    action = read.value;
    if (action.status === "completed") return { ok: true, action };
    if (action.status === "errored") return { ok: false };
    if (attempt < attempts - 1 && intervalMs > 0) {
      await sleep(intervalMs, input.context.signal);
    }
  }

  return { ok: false };
}

function asOwnedSetProvider(provider: DigitalOceanProvider): DigitalOceanOwnedSetProvider | null {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;

  return candidate.observeOwnedSet && candidate.deleteFirewall && candidate.deleteDroplet
    ? {
        observeOwnedSet: candidate.observeOwnedSet.bind(provider),
        deleteFirewall: candidate.deleteFirewall.bind(provider),
        deleteDroplet: candidate.deleteDroplet.bind(provider),
      }
    : null;
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("DigitalOcean action polling aborted."));
      },
      { once: true },
    );
  });
}

export function buildSnapshotBuilderBootstrap(input: {
  runnerImage: string;
  defaultAgentImage: string;
  hermesImage: string;
}): string {
  const runnerImageShell = shellSingleQuote(input.runnerImage);
  const defaultAgentImageShell = shellSingleQuote(input.defaultAgentImage);
  const hermesImageShell = shellSingleQuote(input.hermesImage);
  const runnerImageJson = JSON.stringify(input.runnerImage);
  const defaultAgentImageJson = JSON.stringify(input.defaultAgentImage);
  const hermesImageJson = JSON.stringify(input.hermesImage);

  return `#cloud-config
package_update: true
package_upgrade: false
packages:
  - bash
  - ca-certificates
  - curl
  - gnupg
runcmd:
  - |
    set -euo pipefail
    install -m 0755 -d /etc/apt/keyrings /etc/agentbay-snapshot-builder /run/agentbay-snapshot-builder
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    . /etc/os-release
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
    apt-get update
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
    systemctl enable --now docker
    systemctl enable --now caddy
    docker pull ${runnerImageShell}
    docker pull ${defaultAgentImageShell}
    docker pull ${hermesImageShell}
    docker image inspect ${runnerImageShell} ${defaultAgentImageShell} ${hermesImageShell} >/dev/null
    AGENTBAY_BUILDER_RESOURCE_ID="$(curl -fsS http://169.254.169.254/metadata/v1/id)"
    cat > /run/agentbay-snapshot-builder/boot-result.json <<AGENTBAY_BOOT_RESULT_JSON
    {
      "ok": true,
      "builderResourceId": "$AGENTBAY_BUILDER_RESOURCE_ID",
      "runnerImage": ${runnerImageJson},
      "defaultAgentImage": ${defaultAgentImageJson},
      "hermesImage": ${hermesImageJson},
      "bootContractVersion": "${RUNNER_BOOT_CONTRACT_VERSION}",
      "preloadedImages": [${runnerImageJson}, ${defaultAgentImageJson}, ${hermesImageJson}],
      "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    }
    AGENTBAY_BOOT_RESULT_JSON
    docker ps -aq | xargs --no-run-if-empty docker rm --force
    docker network ls --format '{{.Name}}' | grep '^agentbay' | xargs --no-run-if-empty docker network rm
    rm -rf \
      /etc/agentbay/runner.env \
      /root/.docker/config.json \
      /var/lib/agentbay/agents \
      /var/lib/agentbay/boot-self-test \
      /var/lib/cloud/instances \
      /etc/ssh/ssh_host_* \
      /tmp/agentbay-* \
      /var/tmp/agentbay-* \
      /var/log/cloud-init.log \
      /var/log/cloud-init-output.log
    truncate -s 0 /root/.bash_history || true
    journalctl --rotate || true
    journalctl --vacuum-time=1s || true
    rm -f /etc/machine-id /var/lib/dbus/machine-id
    touch /etc/machine-id
    FORBIDDEN_PATHS=(
      /etc/agentbay/runner.env
      /root/.docker/config.json
      /var/lib/cloud/instances
      /etc/ssh/ssh_host_ed25519_key
      /etc/machine-id
      /var/log/cloud-init-output.log
    )
    for path in "\${FORBIDDEN_PATHS[@]}"; do
      if [ -e "$path" ] && [ "$path" != "/etc/machine-id" ]; then
        echo "forbidden path remains: $path" >&2
        exit 1
      fi
    done
    HOSTILE_MARKERS=(
      AGENTBAY_RUNNER_REGISTRATION_TOKEN
      AGENTBAY_RUNNER_BEARER_TOKEN
      dop_v1_
      "BEGIN OPENSSH PRIVATE KEY"
    )
    for marker in "\${HOSTILE_MARKERS[@]}"; do
      if grep -R -I -F -- "$marker" /etc /root /var/lib/agentbay /var/log >/dev/null 2>&1; then
        echo "hostile marker remains" >&2
        exit 1
      fi
    done
    cat > /run/agentbay-snapshot-builder/sanitation-result.json <<AGENTBAY_SANITATION_RESULT_JSON
    {
      "ok": true,
      "builderResourceId": "$AGENTBAY_BUILDER_RESOURCE_ID",
      "forbiddenPathsAbsent": true,
      "hostileMarkersAbsent": true,
      "removedPaths": ["/etc/agentbay/runner.env", "/root/.docker/config.json", "/var/lib/cloud/instances", "/etc/ssh/ssh_host_ed25519_key", "/etc/machine-id", "/var/log/cloud-init-output.log"],
      "scannedPaths": ["/etc", "/root", "/var/lib/agentbay", "/var/log"],
      "hostileMarkers": ["AGENTBAY_RUNNER_REGISTRATION_TOKEN", "AGENTBAY_RUNNER_BEARER_TOKEN", "dop_v1_", "BEGIN OPENSSH PRIVATE KEY"],
      "completedAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
    }
    AGENTBAY_SANITATION_RESULT_JSON
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function validateSnapshotBuildInput(input: BuildRunnerSnapshotInput):
  | {
      ok: true;
      runnerDigest: string;
      defaultAgentImage: string;
      defaultAgentDigest: string;
      hermesImage: string;
    }
  | { ok: false; reason: "authorization_missing" | "input_invalid" } {
  if (input.costAuthorization !== SNAPSHOT_AUTHORIZATION_SENTINEL) {
    return { ok: false, reason: "authorization_missing" };
  }

  const runner = parseImmutableRunnerImageReference(input.runnerImage);
  const defaultAgentImage = input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE;
  const defaultAgent = parseImmutableRunnerImageReference(defaultAgentImage);
  const hermesImage = input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE;

  if (
    !runner ||
    !defaultAgent ||
    !/^[1-9][0-9]{0,18}$/.test(input.operationId) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.region) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.sizeSlug) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.baseImageId) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(input.baseImageSlug) ||
    input.hermesImage === undefined ||
    !hermesImage.includes("@sha256:")
  ) {
    return { ok: false, reason: "input_invalid" };
  }

  return {
    ok: true,
    runnerDigest: runner.imageDigest,
    defaultAgentImage,
    defaultAgentDigest: defaultAgent.imageDigest,
    hermesImage,
  };
}

function bootFixtureMatches(
  boot: SnapshotBootFixtureResult,
  input: BuildRunnerSnapshotInput,
  builderResourceId: string,
): boolean {
  const expectedPreloads = [
    input.runnerImage,
    input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE,
    input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE,
  ].sort();

  return (
    boot.ok &&
    boot.builderResourceId === builderResourceId &&
    boot.runnerImage === input.runnerImage &&
    boot.defaultAgentImage === (input.defaultAgentImage ?? DEFAULT_MANUAL_RUNNER_IMAGE) &&
    boot.hermesImage === (input.hermesImage ?? DEFAULT_HERMES_WORKLOAD_IMAGE) &&
    boot.bootContractVersion === RUNNER_BOOT_CONTRACT_VERSION &&
    Array.isArray(boot.preloadedImages) &&
    [...boot.preloadedImages].sort().join("\n") === expectedPreloads.join("\n")
  );
}

function sanitationPassed(result: SnapshotSanitationResult, builderResourceId: string): boolean {
  const requiredRemovedPaths = [
    "/etc/agentbay/runner.env",
    "/root/.docker/config.json",
    "/var/lib/cloud/instances",
    "/etc/ssh/ssh_host_ed25519_key",
    "/etc/machine-id",
    "/var/log/cloud-init-output.log",
  ];
  const requiredScannedPaths = ["/etc", "/root", "/var/lib/agentbay", "/var/log"];
  const requiredHostileMarkers = [
    "AGENTBAY_RUNNER_REGISTRATION_TOKEN",
    "AGENTBAY_RUNNER_BEARER_TOKEN",
    "dop_v1_",
    "BEGIN OPENSSH PRIVATE KEY",
  ];

  return (
    result.ok &&
    result.builderResourceId === builderResourceId &&
    result.forbiddenPathsAbsent &&
    result.hostileMarkersAbsent &&
    containsAll(result.removedPaths, requiredRemovedPaths) &&
    containsAll(result.scannedPaths, requiredScannedPaths) &&
    containsAll(result.hostileMarkers, requiredHostileMarkers)
  );
}

function containsAll(values: string[] | undefined, required: string[]): boolean {
  return required.every((value) => values?.includes(value));
}
