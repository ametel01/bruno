import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_HERMES_WORKLOAD_IMAGE } from "@/src/runner-service/constants";
import { FakeDigitalOceanProvider } from "@/src/server/runners/digitalocean-provider";
import {
  buildRunnerSnapshot,
  buildSnapshotBuilderBootstrap,
} from "@/src/server/runners/runner-snapshot-build";
import {
  SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER,
  type SnapshotBuilderEvidencePublisher,
} from "@/src/server/runners/snapshot-builder-evidence-channel";

const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:abc123@sha256:${"a".repeat(64)}`;
const AGENT_IMAGE = `ghcr.io/ametel01/bruno-default:abc123@sha256:${"b".repeat(64)}`;
const AUTH = "I_UNDERSTAND_THIS_CREATES_A_BILLABLE_SNAPSHOT_BUILDER";

describe("runner snapshot build orchestration", () => {
  it("emits directly executable Bash user-data", () => {
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: RUNNER_IMAGE,
      runnerVersion: "abc123",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });

    const syntax = spawnSync("bash", ["-n"], { input: userData, encoding: "utf8" });

    expect(userData).toMatch(/^#!\/usr\/bin\/env bash\nset -euo pipefail\n/);
    expect(userData).not.toContain("#cloud-config");
    expect(userData).not.toContain("runcmd:");
    expect(userData.indexOf("user_data_started")).toBeLessThan(
      userData.indexOf("http://169.254.169.254/metadata/v1/id"),
    );
    expect(syntax).toMatchObject({ status: 0, stderr: "" });
  });

  it("treats an empty Bruno Docker-network set as successful cleanup", () => {
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: RUNNER_IMAGE,
      runnerVersion: "abc123",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });
    const cleanupFunction = userData.match(
      /cleanup_snapshot_builder_networks\(\) \{\n([\s\S]*?)\n\}/,
    )?.[0];
    const execution = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
docker() {
  if [ "$1" = "network" ] && [ "$2" = "ls" ]; then
    printf '%s\\n' bridge host none
    return 0
  fi
  return 99
}
${cleanupFunction ?? "exit 98"}
cleanup_snapshot_builder_networks`,
      ],
      { encoding: "utf8" },
    );

    expect(cleanupFunction).toBeTruthy();
    expect(execution).toMatchObject({ status: 0, stderr: "" });
  });

  it("installs Docker and Caddy before preloading images and emits boot/sanitation evidence", () => {
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: RUNNER_IMAGE,
      runnerVersion: "abc123",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });
    const runnerFixtureSource = userData
      .match(
        /--conditions react-server -e '(.+)'\s+> \/run\/bruno-snapshot-builder\/runner-boot-self-test\.json/,
      )?.[1]
      ?.replaceAll("'\"'\"'", "'");
    const bootResultSource = userData.match(
      /<<'BRUNO_BOOT_RESULT_PY'\n([\s\S]*?)\nBRUNO_BOOT_RESULT_PY/,
    )?.[1];
    const runnerFixtureSyntax = spawnSync(
      "bun",
      [
        "-e",
        'const source = await Bun.stdin.text(); new Bun.Transpiler({ loader: "ts" }).transformSync(source);',
      ],
      { input: runnerFixtureSource, encoding: "utf8" },
    );
    const bootResultSyntax = spawnSync(
      "python3",
      ["-c", 'import sys; compile(sys.stdin.read(), "boot-result.py", "exec")'],
      { input: bootResultSource, encoding: "utf8" },
    );

    expect(userData.indexOf("apt-get install -y docker-ce")).toBeLessThan(
      userData.indexOf(`docker pull '${RUNNER_IMAGE}'`),
    );
    expect(userData).toContain("systemctl enable --now docker");
    expect(userData).toContain("systemctl enable --now caddy");
    expect(userData.indexOf('publish_builder_evidence "bootstrap_started"')).toBeLessThan(
      userData.indexOf("apt-get update"),
    );
    expect(userData).toContain("/run/bruno-snapshot-builder/boot-result.json");
    expect(userData).toContain("/run/bruno-snapshot-builder/sanitation-result.json");
    expect(userData).toContain("docker image inspect");
    expect(userData).toContain("createRunnerBootReadinessController");
    expect(userData).toContain("createDockerRunnerBootSelfTestExecutor");
    expect(userData).toContain("RunnerCanaryNotReadyError");
    expect(userData).toContain("canaryAttempts: 6");
    expect(userData).toContain("canaryRetryDelayMs: 5000");
    expect(userData).toContain("modelCanaryAttempts");
    for (const outcome of [
      "passed",
      "canary_unauthorized",
      "canary_unreachable",
      "canary_timeout",
      "canary_invalid_response",
      "canary_model_failed",
      "canary_not_ready",
      "canary_exception",
    ]) {
      expect(userData).toContain(outcome);
    }
    expect(userData).toContain("BRUNO_RUNNER_EXPECTED_RELEASE_VERSION");
    expect(userData).toContain("BRUNO_RUNNER_EXPECTED_IMAGE_DIGEST");
    expect(userData).toContain("BRUNO_RUNNER_FIXTURE_EXIT_CODE=$?");
    expect(userData).toContain('"fixtureStatus": fixture["status"]');
    expect(userData).toContain('"failureReason": fixture["failureReason"]');
    expect(userData).toContain('"modelCanaryAttempts": canary_attempts');
    expect(userData).toContain("except (json.JSONDecodeError, OSError, TypeError, ValueError)");
    expect(userData).toContain('"failureReason": "snapshot_invalid"');
    expect(userData).toContain('"components": fixture["components"]');
    expect(userData).toContain("docker ps -aq | xargs --no-run-if-empty docker rm --force");
    expect(userData).toContain("grep -R -I -F");
    expect(userData).toContain("BRUNO_RUNNER_REGISTRATION_TOKEN");
    expect(userData).toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(userData).toContain('"/var/lib/cloud"');
    expect(userData).toContain('"/root/.ssh/authorized_keys"');
    expect(runnerFixtureSource).toBeTruthy();
    expect(runnerFixtureSyntax).toMatchObject({ status: 0, stderr: "" });
    expect(bootResultSource).toBeTruthy();
    expect(bootResultSyntax).toMatchObject({ status: 0, stderr: "" });
    const command = userData;
    expect(command.indexOf("rm -rf /var/lib/cloud /root/.ssh/authorized_keys")).toBeLessThan(
      command.indexOf('with open("/run/bruno-snapshot-builder/sanitation-result.json"'),
    );
    expect(command.indexOf("test ! -e /var/lib/cloud")).toBeLessThan(
      command.indexOf('with open("/run/bruno-snapshot-builder/sanitation-result.json"'),
    );
  });

  it("shell-quotes image references in the builder bootstrap", () => {
    const maliciousImage = `ghcr.io/owner/runner@sha256:${"a".repeat(64)}'; touch /tmp/pwned; '`;
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: maliciousImage,
      runnerVersion: "abc123",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    });

    expect(userData).toContain("'\"'\"'; touch /tmp/pwned; '\"'\"''");
    expect(userData).not.toContain(`docker pull '${maliciousImage}'`);
  });

  it("publishes progress and sanitized completion through the outbound evidence channel", () => {
    const publisher = evidencePublisher("github-token-'quoted");
    const userData = buildSnapshotBuilderBootstrap({
      runnerImage: RUNNER_IMAGE,
      runnerVersion: "abc123",
      runnerDigest: `sha256:${"a".repeat(64)}`,
      defaultAgentImage: AGENT_IMAGE,
      hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
      evidencePublisher: publisher,
    });
    const command = userData;
    const shellSyntax = spawnSync("bash", ["-n"], {
      input: command,
      encoding: "utf8",
    });
    const publisherSource = command.match(
      /<<'BRUNO_EVIDENCE_PUBLISHER_PY'\n([\s\S]*?)\nBRUNO_EVIDENCE_PUBLISHER_PY/,
    )?.[1];
    const publisherSyntax = spawnSync(
      "python3",
      ["-c", 'import sys; compile(sys.stdin.read(), "publish-evidence.py", "exec")'],
      { input: publisherSource, encoding: "utf8" },
    );

    expect(shellSyntax).toMatchObject({ status: 0, stderr: "" });
    expect(publisherSource).toBeTruthy();
    expect(publisherSyntax).toMatchObject({ status: 0, stderr: "" });
    expect(command).toContain(SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER);
    expect(command).toContain("github-token-'\"'\"'quoted");
    expect(command).toContain("bootstrap_started");
    expect(command).toContain("docker_installed");
    expect(command).toContain("images_preloaded");
    expect(command).toContain("fixture_complete");
    expect(command).toContain('/run/bruno-snapshot-builder/publish-evidence.py "complete"');
    expect(command).toContain('/run/bruno-snapshot-builder/publish-evidence.py "$1" || true');
    expect(command).not.toContain(
      '/run/bruno-snapshot-builder/publish-evidence.py "complete" || true',
    );
    expect(command).toContain("/run/bruno-snapshot-builder/bootstrap-stage");
    expect(command.indexOf("rm -rf /var/lib/cloud /root/.ssh/authorized_keys")).toBeLessThan(
      command.indexOf('/run/bruno-snapshot-builder/publish-evidence.py "complete"'),
    );
    expect(command.indexOf("os.remove(path)")).toBeLessThan(command.indexOf("last_error = None"));
    expect(command.indexOf("os.remove(path)")).toBeLessThan(
      command.indexOf('sanitation_result["completedAt"]'),
    );
    expect(command).toContain(
      'if stage == "complete":\n    payload["nonce"] = os.environ["BRUNO_SNAPSHOT_EVIDENCE_NONCE"]',
    );
    expect(command).toContain('grep -R -I -F -- "$BRUNO_SNAPSHOT_EVIDENCE_TOKEN"');
    expect(command).toContain("unset BRUNO_SNAPSHOT_EVIDENCE_TOKEN");
    expect(command).toContain("After=cloud-final.service network-online.target");
    expect(command).toContain("systemctl start --no-block bruno-snapshot-finalize.service");
    expect(command.indexOf("source /run/bruno-snapshot-builder/evidence.env")).toBeLessThan(
      command.indexOf("rm -rf /var/lib/cloud /root/.ssh/authorized_keys"),
    );
    expect(command.indexOf("rm -rf /var/lib/cloud /root/.ssh/authorized_keys")).toBeLessThan(
      command.indexOf('/run/bruno-snapshot-builder/publish-evidence.py "complete"'),
    );
  });

  it("uses the protected outbound evidence reader instead of inbound SSH when configured", async () => {
    const provider = new FakeDigitalOceanProvider();
    const input = baseInput(provider);
    const readBuilderEvidence = async (evidenceInput: { providerResourceId: string }) => {
      const providerEvidence = await provider.readSnapshotBuilderEvidence(evidenceInput);
      provider.calls.pop();
      return providerEvidence;
    };

    const result = await buildRunnerSnapshot({
      ...input,
      builderEvidencePublisher: evidencePublisher("github-token-test-value"),
      readBuilderEvidence,
    });

    expect(result.ok).toBe(true);
    expect(provider.calls.map((call) => call.step)).not.toContain("readBuilderEvidence");
    const create = provider.calls.find((call) => call.step === "create");
    expect(create).toMatchObject({ step: "create" });
    expect(JSON.stringify(create)).toContain(SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER);
    expect(JSON.stringify(result)).not.toContain("github-token-test-value");
  });

  it("builds a signed manifest only after boot, sanitation, power-off, snapshot, and availability", async () => {
    const provider = new FakeDigitalOceanProvider();
    const { privateKey } = generateKeyPairSync("ed25519");

    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    });

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        schemaVersion: "bruno.runner.snapshot.v2",
        runner: {
          region: "sfo3",
          sizeSlug: "s-1vcpu-2gb",
          diskSizeGb: 50,
          architecture: "amd64",
        },
        snapshot: {
          provider: "digitalocean",
          id: "9102",
          status: "available",
          regions: ["sfo3"],
          architecture: "amd64",
        },
      },
      bundle: {
        signature: { algorithm: "Ed25519", keyId: "snapshot-test-key" },
      },
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        deletedSshKeyId: null,
        sshKeyDeletionFailed: false,
        deletedSnapshotId: null,
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "readBuilderEvidence",
      "powerOff",
      "readAction",
      "snapshot",
      "readAction",
      "findImage",
      "readImage",
      "observeOwnedSet",
      "deleteFirewall",
      "observeOwnedSet",
      "observeOwnedSet",
      "deleteDroplet",
      "observeOwnedSet",
      "observeOwnedSet",
      "observeOwnedSet",
    ]);
    expect(provider.calls).toEqual(
      expect.arrayContaining([
        {
          step: "firewall",
          input: expect.objectContaining({
            sshSourceAddresses: ["203.0.113.7/32"],
            webSourceAddresses: [],
          }),
        },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("dop_v1_super_secret");
    expect(JSON.stringify(result)).not.toContain("BEGIN PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("expiresAt");
  });

  it("accepts a snapshot whose minimum disk matches the selected runner profile", async () => {
    const provider = new ProfileSizedSnapshotProvider(50);

    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        runner: { diskSizeGb: 50 },
        snapshot: { minDiskSizeGb: 50 },
      },
    });
  });

  it("waits for a pending snapshot image to become available in the selected region", async () => {
    const provider = new PendingSnapshotImageProvider();

    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      imageAvailabilityPollAttempts: 2,
      imageAvailabilityPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      manifest: {
        snapshot: {
          status: "available",
          regions: ["sfo3"],
          minDiskSizeGb: 50,
        },
      },
    });
    expect(provider.imageReads).toBe(2);
  });

  it("rejects a snapshot whose minimum disk exceeds the selected runner profile", async () => {
    const provider = new ProfileSizedSnapshotProvider(51);

    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_unavailable",
      bootResult: { ok: true },
      sanitationResult: { ok: true },
      cleanup: {
        deletedSnapshotId: "9102",
        snapshotAbsenceVerified: true,
      },
    });
  });

  it("fails before provider effects without the cost authorization sentinel", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      costAuthorization: "yes",
    });

    expect(result).toEqual({
      ok: false,
      reason: "authorization_missing",
      cleanup: {
        deletedSnapshotId: null,
        snapshotAbsenceVerified: true,
        deletedDropletId: null,
        deletedFirewallId: null,
        deletedSshKeyId: null,
        sshKeyAbsenceVerified: true,
        sshKeyDeletionFailed: false,
        ambiguousOwnership: false,
        absenceVerified: false,
        steps: [],
      },
    });
    expect(provider.calls).toEqual([]);
  });

  it("fails before provider effects when callback publication and reading are not paired", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderEvidencePublisher: evidencePublisher("github-token-test-value"),
    });

    expect(result).toMatchObject({ ok: false, reason: "input_invalid" });
    expect(provider.calls).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("github-token-test-value");
  });

  it("fails before provider effects on world-open, non-exact, invalid, or injected controller CIDRs", async () => {
    for (const controllerSshSourceCidr of [
      "0.0.0.0/0",
      "0.0.0.0/32",
      "::/0",
      "::/128",
      "203.0.113.7/24",
      "bad/32",
      "203.0.113.7/32; touch /tmp/pwned",
    ]) {
      const provider = new FakeDigitalOceanProvider();
      const result = await buildRunnerSnapshot({
        ...baseInput(provider),
        controllerSshSourceCidr,
      });

      expect(result).toMatchObject({
        ok: false,
        reason: "input_invalid",
      });
      expect(provider.calls).toEqual([]);
    }
  });

  it("records ephemeral SSH key deletion success in cleanup evidence", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderSshKeyId: "ssh-key-123",
    });

    expect(result).toMatchObject({
      ok: true,
      cleanup: {
        deletedSshKeyId: "ssh-key-123",
        sshKeyAbsenceVerified: true,
        sshKeyDeletionFailed: false,
      },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([{ step: "deleteSshKey", input: { id: "ssh-key-123" } }]),
    );
  });

  it("records provider SSH key deletion failure without claiming success", async () => {
    const provider = new FakeDigitalOceanProvider({ fail: { deleteSshKey: "delete denied" } });
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderSshKeyId: "ssh-key-123",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        deletedSshKeyId: null,
        sshKeyDeletionFailed: true,
        deletedSnapshotId: "9102",
      },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([{ step: "deleteSshKey", input: { id: "ssh-key-123" } }]),
    );
  });

  it("preserves the build failure when the exact ephemeral SSH key was already absent", async () => {
    const provider = new AlreadyAbsentSshKeyAfterEvidenceTimeoutProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderSshKeyId: "ssh-key-123",
      builderEvidencePollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "builder_evidence_timeout",
      cleanup: {
        deletedSshKeyId: "ssh-key-123",
        sshKeyAbsenceVerified: true,
        sshKeyDeletionFailed: false,
      },
    });
    expect(provider.calls.map((call) => call.step)).not.toContain("verifySshKeyAbsent");
  });

  it("deletes the builder when retrieved sanitation evidence fails after creation", async () => {
    const provider = new BadSanitationEvidenceProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "sanitation_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toEqual([
      "create",
      "firewall",
      "readBuilderEvidence",
      "observeOwnedSet",
      "deleteFirewall",
      "observeOwnedSet",
      "observeOwnedSet",
      "deleteDroplet",
      "observeOwnedSet",
      "observeOwnedSet",
      "observeOwnedSet",
    ]);
  });

  it("returns sanitized builder evidence when the full boot fixture fails", async () => {
    const provider = new FailedBootEvidenceProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "boot_fixture_failed",
      bootResult: {
        ok: false,
        fixtureStatus: "failed",
        failureReason: "fixture_launch_failed",
      },
      sanitationResult: {
        ok: true,
        forbiddenPathsAbsent: true,
        hostileMarkersAbsent: true,
      },
      cleanup: { absenceVerified: true },
    });
  });

  it("requires bounded allowlisted model-canary attempts ending in passed", async () => {
    for (const modelCanaryAttempts of [
      undefined,
      [],
      ["canary_timeout"],
      ["private-provider-response", "passed"],
      [
        "canary_timeout",
        "canary_timeout",
        "canary_timeout",
        "canary_timeout",
        "canary_timeout",
        "canary_timeout",
        "passed",
      ],
    ]) {
      const result = await buildRunnerSnapshot(
        baseInput(new CanaryAttemptEvidenceProvider(modelCanaryAttempts)),
      );

      expect(result).toMatchObject({ ok: false, reason: "boot_fixture_failed" });
    }

    const recovered = await buildRunnerSnapshot(
      baseInput(
        new CanaryAttemptEvidenceProvider(["canary_timeout", "canary_model_failed", "passed"]),
      ),
    );

    expect(recovered).toMatchObject({ ok: true });
  });

  it("retains failed boot evidence when terminal cleanup also fails closed", async () => {
    const provider = new FailedBootAmbiguousCleanupProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      bootResult: { ok: false, failureReason: "fixture_launch_failed" },
      sanitationResult: { ok: true },
      cleanup: { ambiguousOwnership: true, absenceVerified: false },
    });
  });

  it("waits for a newly created builder to publish boot evidence", async () => {
    const provider = new DelayedBuilderEvidenceProvider(2);
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderEvidencePollIntervalMs: 0,
    });

    expect(result).toMatchObject({ ok: true });
    expect(provider.calls.filter((call) => call.step === "readBuilderEvidence")).toHaveLength(3);
  });

  it("cleans up the builder with an independent context after evidence polling is aborted", async () => {
    const controller = new AbortController();
    const provider = new AbortingBuilderEvidenceProvider(controller);
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      context: { signal: controller.signal },
      builderEvidencePollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "boot_fixture_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
  });

  it("keeps polling through slow fresh-builder bootstrap without exceeding resilience limits", async () => {
    const provider = new DelayedBuilderEvidenceProvider(60);
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderEvidencePollIntervalMs: 0,
    });

    expect(result).toMatchObject({ ok: true, cleanup: { absenceVerified: true } });
    expect(provider.calls.filter((call) => call.step === "readBuilderEvidence")).toHaveLength(61);
  });

  it("caps fresh-builder evidence observations below the resilience ceiling", async () => {
    const provider = new DelayedBuilderEvidenceProvider(100);
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderEvidencePollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "builder_evidence_timeout",
      diagnostics: {
        schemaVersion: "bruno.runner.snapshot-builder-diagnostics.v1",
        status: "unavailable",
        lastStage: null,
      },
      cleanup: { absenceVerified: true },
    });
    expect(provider.calls.filter((call) => call.step === "readBuilderEvidence")).toHaveLength(63);
  });

  it("retains only allowlisted progress diagnostics after evidence polling times out", async () => {
    const provider = new DelayedBuilderEvidenceProvider(100);
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      builderEvidencePollIntervalMs: 0,
      readBuilderDiagnostics: async () => ({
        schemaVersion: "bruno.runner.snapshot-builder-diagnostics.v1",
        status: "progress_observed",
        lastStage: "docker_installed",
        sourceUrl: "https://github.com/ametel01/bruno/issues/294#issuecomment-12",
        localStatus: "progress_observed",
        localStage: "bootstrap_started",
        cloudInitStatus: "running",
      }),
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "builder_evidence_timeout",
      diagnostics: {
        status: "progress_observed",
        lastStage: "docker_installed",
      },
      cleanup: { absenceVerified: true },
    });
    expect(JSON.stringify(result)).not.toContain("github-token-test-value");
    expect(JSON.stringify(result)).not.toContain('"authenticationSecret"');
  });

  it("retries a retryable Droplet deletion outcome until absence is confirmed", async () => {
    const provider = new EventuallyConsistentDropletDeletionProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      cleanupPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: true,
      cleanup: {
        deletedDropletId: "do-fake-1",
        ambiguousOwnership: false,
        absenceVerified: true,
      },
    });
    expect(provider.calls.filter((call) => call.step === "deleteDroplet")).toHaveLength(3);
  });

  it("fails closed when the expected builder host key does not match the pinned identity", async () => {
    const provider = new FakeDigitalOceanProvider({
      builderHostKeySha256: "SHA256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    });
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      expectedBuilderHostKeySha256: "SHA256:ccccccccccccccccccccccccccccccccccccccccccc",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "boot_fixture_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("readBuilderEvidence");
    expect(provider.calls.map((call) => call.step)).not.toContain("powerOff");
  });

  it("rejects invalid expected builder host-key fingerprints before provider effects", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      expectedBuilderHostKeySha256: "SHA256:bad; touch /tmp/pwned",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "input_invalid",
    });
    expect(provider.calls).toEqual([]);
  });

  it("fails closed on asynchronous action errors and removes the partial snapshot", async () => {
    const provider = new ActionErroredProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_failed",
      cleanup: {
        deletedDropletId: "do-fake-1",
        deletedFirewallId: "do-fake-firewall-1",
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("readAction");
  });

  it("reconciles an image that appears after the initial snapshot-action timeout", async () => {
    const provider = new LateSnapshotImageProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      actionPollAttempts: 1,
      actionPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_failed",
      cleanup: {
        deletedSnapshotId: "late-snapshot-9102",
        snapshotAbsenceVerified: true,
        absenceVerified: true,
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("observeSnapshotImage");
  });

  it("reconciles a late image after the snapshot request outcome is unknown", async () => {
    const provider = new OutcomeUnknownLateImageProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      actionPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_failed",
      cleanup: {
        deletedSnapshotId: "eventual-snapshot-9102",
        snapshotAbsenceVerified: true,
      },
    });
  });

  it("never treats a prior run's same-revision snapshot as the current attempt", async () => {
    const provider = new PriorRevisionSnapshotProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      actionPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        snapshotAbsenceVerified: false,
        absenceVerified: true,
      },
    });
    expect(provider.calls).toContainEqual({
      step: "snapshot",
      input: {
        providerResourceId: "do-fake-1",
        name: "bruno-snapshot-builder-111111111111-123456",
      },
    });
    expect(provider.calls).not.toContainEqual({
      step: "deleteImage",
      input: { imageId: "prior-snapshot-9102" },
    });
    expect(provider.builderWasAbsentAtFirstImageObservation).toBe(true);
  });

  it("waits for a completed snapshot action's image to become visible before deleting it", async () => {
    const provider = new CompletedEventuallyVisibleImageProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      actionPollIntervalMs: 0,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_unavailable",
      cleanup: {
        deletedSnapshotId: "eventual-snapshot-9102",
        snapshotAbsenceVerified: true,
      },
    });
  });

  it("converts unexpected post-effect exceptions into retained cleanup evidence", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot({
      ...baseInput(provider),
      privateKeyPem: "not a private key",
    });

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        deletedSnapshotId: "9102",
        snapshotAbsenceVerified: true,
        deletedDropletId: "do-fake-1",
        absenceVerified: true,
      },
    });
  });

  it("does not use the snapshot action ID as the manifest image ID", async () => {
    const provider = new FakeDigitalOceanProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: true,
      manifest: { snapshot: { id: "9102" } },
    });
    expect(provider.calls).toEqual(
      expect.arrayContaining([
        { step: "readAction", input: { actionId: "8102" } },
        { step: "findImage", input: { name: "bruno-snapshot-builder-111111111111-123456" } },
        { step: "readImage", input: { imageId: "9102" } },
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('"id":"8102"');
  });

  it("fails closed when the provider cannot resolve a distinct snapshot image after action completion", async () => {
    const provider = new MissingSnapshotImageProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "snapshot_unavailable",
      cleanup: {
        deletedSnapshotId: "9102",
        snapshotAbsenceVerified: true,
        deletedDropletId: "do-fake-1",
      },
    });
    expect(provider.calls.map((call) => call.step)).toContain("findImage");
    expect(provider.calls.map((call) => call.step)).not.toContain("readImage");
  });

  it("records ambiguous ownership and does not delete an unowned builder", async () => {
    const provider = new AmbiguousOwnedSetProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        deletedDropletId: null,
        deletedFirewallId: null,
        ambiguousOwnership: true,
        absenceVerified: false,
        deletedSnapshotId: "9102",
      },
    });
    expect(provider.calls.map((call) => call.step)).not.toContain("deleteDroplet");
    expect(provider.calls.map((call) => call.step)).toContain("verifyImageAbsent");
  });

  it("replaces a build failure with cleanup_failed when builder absence is ambiguous", async () => {
    const provider = new AmbiguousFailureProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        absenceVerified: false,
        ambiguousOwnership: true,
        snapshotAbsenceVerified: true,
      },
    });
  });

  it("does not claim failed snapshot deletion until provider absence is observed", async () => {
    const provider = new UnverifiedImageDeletionProvider();
    const result = await buildRunnerSnapshot(baseInput(provider));

    expect(result).toMatchObject({
      ok: false,
      reason: "cleanup_failed",
      cleanup: {
        deletedSnapshotId: null,
        snapshotAbsenceVerified: false,
      },
    });
  });
});

class BadSanitationEvidenceProvider extends FakeDigitalOceanProvider {
  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
    context?: { signal: AbortSignal },
  ) {
    const result = await super.readSnapshotBuilderEvidence(input, context);
    if (!result.ok) return result;
    return {
      ok: true as const,
      value: {
        ...result.value,
        sanitationResult: {
          ok: false,
          builderResourceId: input.providerResourceId,
          forbiddenPathsAbsent: false,
          hostileMarkersAbsent: true,
          removedPaths: ["/etc/bruno/runner.env"],
          scannedPaths: ["/etc"],
          hostileMarkers: ["BRUNO_RUNNER_REGISTRATION_TOKEN"],
          completedAt: "2026-08-07T00:00:02.000Z",
        },
      },
    };
  }
}

class FailedBootEvidenceProvider extends FakeDigitalOceanProvider {
  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
    context?: { signal: AbortSignal },
  ) {
    const result = await super.readSnapshotBuilderEvidence(input, context);
    if (!result.ok) return result;
    return {
      ok: true as const,
      value: {
        ...result.value,
        bootResult: {
          ...(result.value.bootResult as Record<string, unknown>),
          ok: false,
          fixtureStatus: "failed",
          failureReason: "fixture_launch_failed",
          modelCanaryAttempts: [],
        },
      },
    };
  }
}

class CanaryAttemptEvidenceProvider extends FakeDigitalOceanProvider {
  constructor(private readonly modelCanaryAttempts: unknown) {
    super();
  }

  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
    context?: { signal: AbortSignal },
  ) {
    const result = await super.readSnapshotBuilderEvidence(input, context);
    if (!result.ok) return result;
    const bootResult = { ...(result.value.bootResult as Record<string, unknown>) };
    delete bootResult.modelCanaryAttempts;
    if (this.modelCanaryAttempts !== undefined) {
      bootResult.modelCanaryAttempts = this.modelCanaryAttempts;
    }
    return { ok: true as const, value: { ...result.value, bootResult } };
  }
}

class FailedBootAmbiguousCleanupProvider extends FailedBootEvidenceProvider {
  override async observeOwnedSet(
    input: Parameters<FakeDigitalOceanProvider["observeOwnedSet"]>[0],
  ) {
    this.calls.push({ step: "observeOwnedSet", input });
    return {
      ok: false as const,
      reason: "ownership_ambiguous" as const,
      retryable: false,
      message: "ambiguous owner",
    };
  }
}

class DelayedBuilderEvidenceProvider extends FakeDigitalOceanProvider {
  #remainingUnavailableAttempts: number;

  constructor(unavailableAttempts: number) {
    super();
    this.#remainingUnavailableAttempts = unavailableAttempts;
  }

  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
    context?: { signal: AbortSignal },
  ) {
    if (this.#remainingUnavailableAttempts > 0) {
      this.#remainingUnavailableAttempts -= 1;
      this.calls.push({ step: "readBuilderEvidence", input });
      return {
        ok: false as const,
        reason: "builder_evidence_not_ready" as const,
        message: "Snapshot builder evidence is not ready yet.",
      };
    }

    return super.readSnapshotBuilderEvidence(input, context);
  }
}

class AlreadyAbsentSshKeyAfterEvidenceTimeoutProvider extends DelayedBuilderEvidenceProvider {
  constructor() {
    super(100);
  }

  override async deleteSshKey(input: Parameters<FakeDigitalOceanProvider["deleteSshKey"]>[0]) {
    this.calls.push({ step: "deleteSshKey", input });
    return { ok: true as const, value: { deleted: true as const, alreadyAbsent: true as const } };
  }

  override async verifySshKeyAbsent(
    input: Parameters<FakeDigitalOceanProvider["verifySshKeyAbsent"]>[0],
  ) {
    this.calls.push({ step: "verifySshKeyAbsent", input });
    return {
      ok: false as const,
      reason: "cleanup_failed" as const,
      message: "provider observation remained unavailable",
    };
  }
}

class AbortingBuilderEvidenceProvider extends FakeDigitalOceanProvider {
  readonly #controller: AbortController;

  constructor(controller: AbortController) {
    super();
    this.#controller = controller;
  }

  override async readSnapshotBuilderEvidence(
    input: Parameters<FakeDigitalOceanProvider["readSnapshotBuilderEvidence"]>[0],
  ) {
    this.calls.push({ step: "readBuilderEvidence", input });
    this.#controller.abort();
    return {
      ok: false as const,
      reason: "builder_evidence_not_ready" as const,
      message: "Snapshot builder evidence polling was aborted.",
    };
  }
}

class EventuallyConsistentDropletDeletionProvider extends FakeDigitalOceanProvider {
  #deleteAttempts = 0;

  override async deleteDroplet(
    input: Parameters<FakeDigitalOceanProvider["deleteDroplet"]>[0],
    context?: { signal: AbortSignal },
  ) {
    const deleted = await super.deleteDroplet(input, context);
    this.#deleteAttempts += 1;
    if (this.#deleteAttempts === 1) {
      return {
        ok: false as const,
        reason: "delete_outcome_unknown" as const,
        retryable: true,
        message: "DigitalOcean has not made the completed deletion observable yet.",
      };
    }
    if (this.#deleteAttempts === 2) {
      return {
        ok: false as const,
        reason: "ownership_ambiguous" as const,
        retryable: false,
        message: "The exact-ID delete is complete while tag discovery still lags.",
      };
    }
    return deleted;
  }
}

class ActionErroredProvider extends FakeDigitalOceanProvider {
  override async readAction(input: { actionId: string }, context?: { signal: AbortSignal }) {
    await super.readAction(input, context);
    return {
      ok: true as const,
      value: {
        id: input.actionId,
        status: input.actionId.endsWith("02") ? ("errored" as const) : ("completed" as const),
        type: input.actionId.endsWith("02") ? "snapshot" : "power_off",
        resourceId: "do-fake-1",
      },
    };
  }
}

class ProfileSizedSnapshotProvider extends FakeDigitalOceanProvider {
  constructor(private readonly minDiskSizeGb: number) {
    super();
  }

  override async readImageAvailability(
    input: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[0],
    context?: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[1],
  ) {
    const result = await super.readImageAvailability(input, context);
    return result.ok
      ? { ok: true as const, value: { ...result.value, minDiskSizeGb: this.minDiskSizeGb } }
      : result;
  }
}

class PendingSnapshotImageProvider extends ProfileSizedSnapshotProvider {
  imageReads = 0;

  constructor() {
    super(50);
  }

  override async readImageAvailability(
    input: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[0],
    context?: Parameters<FakeDigitalOceanProvider["readImageAvailability"]>[1],
  ) {
    const result = await super.readImageAvailability(input, context);
    this.imageReads += 1;
    if (!result.ok || this.imageReads > 1) return result;
    return {
      ok: true as const,
      value: { ...result.value, status: "pending" as const, regions: [] },
    };
  }
}

class LateSnapshotImageProvider extends FakeDigitalOceanProvider {
  #snapshotActionReads = 0;

  override async snapshotResource(
    input: Parameters<FakeDigitalOceanProvider["snapshotResource"]>[0],
  ) {
    this.calls.push({ step: "snapshot", input });
    return {
      ok: true as const,
      value: {
        id: "late-snapshot-action",
        status: "in-progress" as const,
        type: "snapshot",
        resourceId: input.providerResourceId,
      },
    };
  }

  override async readAction(input: { actionId: string }) {
    if (input.actionId !== "late-snapshot-action") return await super.readAction(input);
    this.calls.push({ step: "readAction", input });
    this.#snapshotActionReads += 1;
    return {
      ok: true as const,
      value: {
        id: input.actionId,
        status: this.#snapshotActionReads > 1 ? ("completed" as const) : ("in-progress" as const),
        type: "snapshot",
        resourceId: "do-fake-1",
      },
    };
  }

  override async observeSnapshotImageByName(
    input: Parameters<FakeDigitalOceanProvider["observeSnapshotImageByName"]>[0],
  ) {
    this.calls.push({ step: "observeSnapshotImage", input });
    return {
      ok: true as const,
      value: {
        state: "present" as const,
        image: {
          id: "late-snapshot-9102",
          name: input.name,
          regions: ["sfo3"],
          minDiskSizeGb: 25,
          architecture: "amd64" as const,
          status: "available" as const,
        },
      },
    };
  }
}

abstract class EventuallyVisibleImageProvider extends FakeDigitalOceanProvider {
  #observations = 0;

  override async observeSnapshotImageByName(
    input: Parameters<FakeDigitalOceanProvider["observeSnapshotImageByName"]>[0],
  ) {
    this.calls.push({ step: "observeSnapshotImage", input });
    this.#observations += 1;
    if (this.#observations === 1) {
      return { ok: true as const, value: { state: "absent" as const } };
    }
    return {
      ok: true as const,
      value: {
        state: "present" as const,
        image: {
          id: "eventual-snapshot-9102",
          name: input.name,
          regions: ["sfo3"],
          minDiskSizeGb: 25,
          architecture: "amd64" as const,
          status: "available" as const,
        },
      },
    };
  }
}

class OutcomeUnknownLateImageProvider extends EventuallyVisibleImageProvider {
  override async snapshotResource(
    input: Parameters<FakeDigitalOceanProvider["snapshotResource"]>[0],
  ) {
    this.calls.push({ step: "snapshot", input });
    return {
      ok: false as const,
      reason: "action_outcome_unknown" as const,
      message: "snapshot request outcome unknown",
    };
  }
}

class PriorRevisionSnapshotProvider extends FakeDigitalOceanProvider {
  builderWasAbsentAtFirstImageObservation = false;

  override async snapshotResource(
    input: Parameters<FakeDigitalOceanProvider["snapshotResource"]>[0],
  ) {
    this.calls.push({ step: "snapshot", input });
    return {
      ok: false as const,
      reason: "action_outcome_unknown" as const,
      message: "snapshot request outcome unknown",
    };
  }

  override async observeSnapshotImageByName(
    input: Parameters<FakeDigitalOceanProvider["observeSnapshotImageByName"]>[0],
  ) {
    if (!this.calls.some((call) => call.step === "observeSnapshotImage")) {
      this.builderWasAbsentAtFirstImageObservation =
        this.resources.get("do-fake-1")?.deletedAt !== null && this.firewalls.size === 0;
    }
    this.calls.push({ step: "observeSnapshotImage", input });
    return input.name === "bruno-snapshot-builder-111111111111"
      ? {
          ok: true as const,
          value: {
            state: "present" as const,
            image: {
              id: "prior-snapshot-9102",
              name: input.name,
              regions: ["sfo3"],
              minDiskSizeGb: 25,
              architecture: "amd64" as const,
              status: "available" as const,
            },
          },
        }
      : { ok: true as const, value: { state: "absent" as const } };
  }
}

class CompletedEventuallyVisibleImageProvider extends EventuallyVisibleImageProvider {
  override async snapshotResource(
    input: Parameters<FakeDigitalOceanProvider["snapshotResource"]>[0],
  ) {
    this.calls.push({ step: "snapshot", input });
    return {
      ok: true as const,
      value: {
        id: "eventual-snapshot-action",
        status: "completed" as const,
        type: "snapshot",
        resourceId: input.providerResourceId,
      },
    };
  }
}

class MissingSnapshotImageProvider extends FakeDigitalOceanProvider {
  override async findSnapshotImageByName(
    input: Parameters<FakeDigitalOceanProvider["findSnapshotImageByName"]>[0],
    context?: { signal: AbortSignal },
  ) {
    await super.findSnapshotImageByName(input, context);
    return {
      ok: false as const,
      reason: "image_lookup_failed" as const,
      message: "missing image",
    };
  }
}

class AmbiguousOwnedSetProvider extends FakeDigitalOceanProvider {
  override async observeOwnedSet(
    input: Parameters<FakeDigitalOceanProvider["observeOwnedSet"]>[0],
  ) {
    this.calls.push({ step: "observeOwnedSet", input });
    return {
      ok: false as const,
      reason: "ownership_ambiguous" as const,
      retryable: false,
      message: "ambiguous owner",
    };
  }
}

class AmbiguousFailureProvider extends BadSanitationEvidenceProvider {
  override async observeOwnedSet(
    input: Parameters<FakeDigitalOceanProvider["observeOwnedSet"]>[0],
  ) {
    this.calls.push({ step: "observeOwnedSet", input });
    return {
      ok: false as const,
      reason: "ownership_ambiguous" as const,
      retryable: false,
      message: "ambiguous owner",
    };
  }
}

class UnverifiedImageDeletionProvider extends AmbiguousOwnedSetProvider {
  override async verifyImageAbsent(
    input: Parameters<FakeDigitalOceanProvider["verifyImageAbsent"]>[0],
  ) {
    this.calls.push({ step: "verifyImageAbsent", input });
    return {
      ok: false as const,
      reason: "cleanup_failed" as const,
      message: "image absence is unknown",
    };
  }
}

function baseInput(provider: FakeDigitalOceanProvider) {
  return {
    costAuthorization: AUTH,
    operationId: "123456",
    sourceRevision: "1".repeat(40),
    region: "sfo3",
    sizeSlug: "s-1vcpu-2gb",
    baseImageId: "ubuntu-24-04-x64-20260801",
    baseImageSlug: "ubuntu-24-04-x64",
    runnerImage: RUNNER_IMAGE,
    defaultAgentImage: AGENT_IMAGE,
    hermesImage: DEFAULT_HERMES_WORKLOAD_IMAGE,
    controllerSshSourceCidr: "203.0.113.7/32",
    privateKeyPem: generateKeyPairSync("ed25519")
      .privateKey.export({ format: "pem", type: "pkcs8" })
      .toString(),
    signingKeyId: "snapshot-test-key",
    provider,
    context: { signal: new AbortController().signal },
    now: () => new Date("2026-08-07T00:00:03.000Z"),
    imageAvailabilityPollIntervalMs: 0,
  };
}

function evidencePublisher(token: string): SnapshotBuilderEvidencePublisher {
  return {
    token,
    repository: "ametel01/bruno",
    issueNumber: 294,
    runId: "123456",
    nonce: "11111111-1111-4111-8111-111111111111",
    authenticationSecret: "d".repeat(64),
    apiUrl: "https://api.github.com",
  };
}
