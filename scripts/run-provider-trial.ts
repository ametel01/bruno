import { execFile, spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { desc, eq } from "drizzle-orm";
import { CURRENT_ROLLOUT_CONFIGURATION_GENERATION } from "@/src/server/agents/deployment-slo-identity";
import { createProviderTrialCohort } from "@/src/server/agents/provider-trial-cohort";
import {
  initializeProviderTrialDriver,
  providerTrialBenchmarkOwnerIdentityHash,
  reconcileProviderTrialCleanup,
  resumeProviderTrialDriver,
  verifyProviderTrialDriverReport,
} from "@/src/server/agents/provider-trial-driver";
import {
  listProviderTrialPreflightIssues,
  matchesProviderTrialGateEvidence,
  PROVIDER_TRIAL_APPROVED_SCOPE,
  parseProviderTrialOperatorConfiguration,
} from "@/src/server/agents/provider-trial-operator-config";
import {
  readProviderTrialBenchmarkOwner,
  resolveProviderTrialBenchmarkOwner,
} from "@/src/server/agents/provider-trial-owner";
import { createProviderTrialProductionDriverDependencies } from "@/src/server/agents/provider-trial-production-adapter";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  providerTrialAuthorizationEvents,
  providerTrialCohorts,
  providerTrialRuns,
} from "@/src/server/db/schema";

type Command =
  | "preflight"
  | "verify-gates"
  | "initialize"
  | "run"
  | "reconcile-cleanup"
  | "verify-credential-cleanup";
type OperatorConfig = NonNullable<ReturnType<typeof parseProviderTrialOperatorConfiguration>>;
type SigningKey = { keyId: string; privateKeyPem: string };
type AuthorizedIdentityEvidence = {
  digitalOceanAccount: string;
  digitalOceanCredential: string;
  modelCredential: string;
  telegramBot: string;
  telegramChat: string;
  telegramCredential: string;
  telegramUser: string;
  modelProvider: "chatgpt" | "claude";
};
type VerifiedGateEvidence = { digest: string; identities: AuthorizedIdentityEvidence };

const execFileAsync = promisify(execFile);
const GATE_EVIDENCE_SCHEMA_VERSION = "bruno.provider-trial-prerequisite-gates.v1";
const GATE_COMMANDS = [
  ["repository", ["run", "verify"]],
  ["browser", ["run", "test:e2e:ci"]],
  ["cloudReproduction", ["run", "repro:cloud-runner"]],
  ["lifecycleSmoke", ["run", "local:agent:smoke"]],
] as const;

function write(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function main(): Promise<number> {
  const command = (process.argv[2] ?? "preflight") as Command;
  if (
    ![
      "preflight",
      "verify-gates",
      "initialize",
      "run",
      "reconcile-cleanup",
      "verify-credential-cleanup",
    ].includes(command)
  ) {
    write({ command, effects: 0, ok: false, issues: ["unsupported_command"] });
    return 1;
  }

  const issues = listProviderTrialPreflightIssues(process.env);
  if (issues.length > 0) {
    write({ command, effects: 0, ok: false, issues });
    return 1;
  }
  const config = parseProviderTrialOperatorConfiguration(process.env);
  if (!config) {
    write({ command, effects: 0, ok: false, issues: ["invalid_configuration"] });
    return 1;
  }
  if (!(await hasSafeArtifactPaths(config))) {
    write({ command, effects: 0, ok: false, issues: ["artifact_paths"] });
    return 1;
  }
  const signing = await readSigningKey(config.signing);
  if (!signing) {
    write({ command, effects: 0, ok: false, issues: ["signing_key"] });
    return 1;
  }
  const sourceRevision = await readSourceRevision();
  const cleanupOnly = command === "reconcile-cleanup" || command === "verify-credential-cleanup";
  if (!cleanupOnly && config.releaseSourceRevision !== sourceRevision) {
    write({ command, effects: 0, ok: false, issues: ["immutable_release_revision"] });
    return 1;
  }
  if (command === "verify-gates") {
    return await verifyPrerequisiteGates(config, signing, sourceRevision);
  }
  const gateEvidence = await readGateEvidence(
    config,
    signing,
    cleanupOnly ? config.releaseSourceRevision : sourceRevision,
  );
  if (!gateEvidence) {
    write({ command, effects: 0, ok: false, issues: ["prerequisite_gates"] });
    return 1;
  }
  if (command === "preflight") {
    write({
      command,
      effects: 0,
      ok: true,
      issues: [],
      gateEvidenceDigest: gateEvidence.digest,
      scope: {
        slots: 30,
        region: PROVIDER_TRIAL_APPROVED_SCOPE.region,
        runnerSizeSlug: PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug,
        maxSpendCents: PROVIDER_TRIAL_APPROVED_SCOPE.maxSpendCents,
        maxSlotCostCents: PROVIDER_TRIAL_APPROVED_SCOPE.maxSlotCostCents,
        maxProviderResources: PROVIDER_TRIAL_APPROVED_SCOPE.maxProviderResources,
        cleanup: "all_trial_resources",
        retainedProviderResources: 0,
        evidenceRetentionDays: PROVIDER_TRIAL_APPROVED_SCOPE.evidenceRetentionDays,
      },
    });
    return 0;
  }

  const connection = createDatabaseConnection();
  try {
    if (command === "initialize") {
      return await initialize(connection, config, gateEvidence);
    }
    if (command === "verify-credential-cleanup") {
      return await verifyCredentialCleanup(
        connection,
        config,
        signing,
        sourceRevision,
        gateEvidence,
      );
    }
    if (command === "reconcile-cleanup") {
      return await reconcileCleanup(connection, config, gateEvidence);
    }
    return await run(connection, config, signing, gateEvidence);
  } finally {
    await connection.close();
  }
}

async function reconcileCleanup(
  connection: DatabaseConnection,
  config: OperatorConfig,
  gateEvidence: VerifiedGateEvidence,
): Promise<number> {
  const ownerUserId = await connection.db.transaction(readProviderTrialBenchmarkOwner);
  const [cohort] = await connection.db
    .select({ id: providerTrialCohorts.id })
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.cohortKey, config.cohortKey))
    .limit(1);
  if (!ownerUserId || !cohort) throw new Error("trial_not_initialized");
  const [authorizationEvidence] = await connection.db
    .select()
    .from(providerTrialAuthorizationEvents)
    .where(eq(providerTrialAuthorizationEvents.cohortId, cohort.id))
    .orderBy(desc(providerTrialAuthorizationEvents.generation))
    .limit(1);
  if (
    !authorizationEvidence ||
    authorizationEvidence.generation !== config.authorization.generation ||
    authorizationEvidence.prerequisiteGateEvidenceDigest !== gateEvidence.digest ||
    authorizationEvidence.deploymentChoicesDigest !== config.deploymentChoicesDigest
  ) {
    throw new Error("cleanup_authorization_evidence_mismatch");
  }
  const dependencies = createProviderTrialProductionDriverDependencies({
    ownerUserId,
    fixture: config.fixture,
    env: process.env,
  });
  if (!dependencies.cleanup) throw new Error("cleanup_dependency_missing");
  const result = await reconcileProviderTrialCleanup(
    connection,
    { cohortId: cohort.id, authorization: config.authorization },
    { cleanup: dependencies.cleanup },
  );
  write({
    command: "reconcile-cleanup",
    effects: "authorized_cleanup_only",
    ok: true,
    cohortId: cohort.id,
    state: result.state,
    nextSlotNumber: result.nextSlotNumber,
    spentCents: result.spentCents,
  });
  return 0;
}

async function initialize(
  connection: DatabaseConnection,
  config: OperatorConfig,
  gateEvidence: VerifiedGateEvidence,
): Promise<number> {
  const owner = await connection.db.transaction(resolveProviderTrialBenchmarkOwner);
  let [cohort] = await connection.db
    .select()
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.cohortKey, config.cohortKey))
    .limit(1);
  if (!cohort) {
    cohort = await createProviderTrialCohort(connection, {
      cohortKey: config.cohortKey,
      region: PROVIDER_TRIAL_APPROVED_SCOPE.region,
      runnerSizeSlug: PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug,
      rolloutConfigurationGeneration: CURRENT_ROLLOUT_CONFIGURATION_GENERATION,
    });
  }
  if (
    cohort.region !== PROVIDER_TRIAL_APPROVED_SCOPE.region ||
    cohort.runnerSizeSlug !== PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug ||
    cohort.rolloutConfigurationGeneration !== CURRENT_ROLLOUT_CONFIGURATION_GENERATION
  ) {
    throw new Error("cohort_scope_mismatch");
  }
  const [existing] = await connection.db
    .select({
      cohortId: providerTrialRuns.cohortId,
      configuration: providerTrialRuns.configuration,
      state: providerTrialRuns.state,
      authorizationGeneration: providerTrialRuns.authorizationGeneration,
    })
    .from(providerTrialRuns)
    .where(eq(providerTrialRuns.cohortId, cohort.id))
    .limit(1);
  if (!existing) {
    await initializeProviderTrialDriver(connection, {
      cohortId: cohort.id,
      authorization: config.authorization,
      configuration: {
        providerMode: "digitalocean",
        perSlotTimeoutMs: PROVIDER_TRIAL_APPROVED_SCOPE.perSlotTimeoutMs,
        cleanupTimeoutMs: PROVIDER_TRIAL_APPROVED_SCOPE.cleanupTimeoutMs,
        maxSpendCents: PROVIDER_TRIAL_APPROVED_SCOPE.maxSpendCents,
        maxSlotCostCents: PROVIDER_TRIAL_APPROVED_SCOPE.maxSlotCostCents,
        maxProviderResources: PROVIDER_TRIAL_APPROVED_SCOPE.maxProviderResources,
        deploymentChoicesDigest: config.deploymentChoicesDigest,
        authorizedRegion: PROVIDER_TRIAL_APPROVED_SCOPE.region,
        authorizedRunnerSizeSlug: PROVIDER_TRIAL_APPROVED_SCOPE.runnerSizeSlug,
        benchmarkOwnerIdentityHash: providerTrialBenchmarkOwnerIdentityHash(owner.userId),
        benchmarkTelegramIdentityHash: config.benchmarkTelegramIdentityHash,
        digitalOceanAccountIdentityHash: gateEvidence.identities.digitalOceanAccount,
        telegramBotIdentityHash: gateEvidence.identities.telegramBot,
        telegramChatIdentityHash: gateEvidence.identities.telegramChat,
        telegramUserIdentityHash: gateEvidence.identities.telegramUser,
        prerequisiteGateEvidenceDigest: gateEvidence.digest,
        evidenceRetentionDays: PROVIDER_TRIAL_APPROVED_SCOPE.evidenceRetentionDays,
      },
    });
  } else if (
    !matchesProviderTrialGateEvidence(
      existing.configuration,
      gateEvidence,
      gateEvidenceModeBeforeLease(existing, config.authorization.generation),
    )
  ) {
    throw new Error("cohort_gate_evidence_mismatch");
  }
  write({
    command: "initialize",
    effects: "database_only",
    ok: true,
    cohortId: cohort.id,
    created: { cohort: !existing, benchmarkOwner: owner.created },
  });
  return 0;
}

async function run(
  connection: DatabaseConnection,
  config: OperatorConfig,
  signing: SigningKey,
  gateEvidence: VerifiedGateEvidence,
): Promise<number> {
  const ownerUserId = await connection.db.transaction(readProviderTrialBenchmarkOwner);
  const [cohort] = await connection.db
    .select({ id: providerTrialCohorts.id })
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.cohortKey, config.cohortKey))
    .limit(1);
  if (!ownerUserId || !cohort) throw new Error("trial_not_initialized");
  const [trialRun] = await connection.db
    .select({
      configuration: providerTrialRuns.configuration,
      state: providerTrialRuns.state,
      authorizationGeneration: providerTrialRuns.authorizationGeneration,
    })
    .from(providerTrialRuns)
    .where(eq(providerTrialRuns.cohortId, cohort.id))
    .limit(1);
  if (
    !trialRun ||
    !matchesProviderTrialGateEvidence(
      trialRun.configuration,
      gateEvidence,
      gateEvidenceModeBeforeLease(trialRun, config.authorization.generation),
    )
  ) {
    throw new Error("cohort_gate_evidence_mismatch");
  }

  const dependencies = {
    ...createProviderTrialProductionDriverDependencies({
      ownerUserId,
      fixture: config.fixture,
      env: process.env,
    }),
    signing,
  };
  let result: Awaited<ReturnType<typeof resumeProviderTrialDriver>>;
  do {
    result = await resumeProviderTrialDriver(
      connection,
      {
        cohortId: cohort.id,
        authorization: config.authorization,
        authorizationEvidence: {
          prerequisiteGateEvidenceDigest: gateEvidence.digest,
          deploymentChoicesDigest: config.deploymentChoicesDigest,
        },
      },
      dependencies,
    );
  } while (result.state === "running" || result.state === "ready_to_finalize");

  const gatePassed =
    result.state === "complete" && (await readCompletedCohortGate(connection, cohort.id, signing));

  write({
    command: "run",
    effects: "authorized_trial",
    ok: false,
    cohortId: cohort.id,
    state: result.state,
    nextSlotNumber: result.nextSlotNumber,
    spentCents: result.spentCents,
    gatePassed,
    credentialCleanupRequired: true,
    ...(result.signedReportDigest ? { signedReportDigest: result.signedReportDigest } : {}),
  });
  return gatePassed ? 4 : result.state === "complete" ? 3 : 2;
}

async function readSigningKey(input: {
  keyId: string;
  privateKeyPath: string;
}): Promise<{ keyId: string; privateKeyPem: string } | null> {
  try {
    const privateKeyPem = await readFile(input.privateKeyPath, "utf8");
    const key = createPrivateKey(privateKeyPem);
    return key.asymmetricKeyType === "ed25519" ? { keyId: input.keyId, privateKeyPem } : null;
  } catch {
    return null;
  }
}

async function verifyPrerequisiteGates(
  config: OperatorConfig,
  signingKey: SigningKey,
  sourceRevision: string,
): Promise<number> {
  for (const [name, args] of GATE_COMMANDS) {
    const exitCode = await runCommand("bun", [...args]);
    if (exitCode !== 0) {
      write({ command: "verify-gates", effects: "local_validation", ok: false, gate: name });
      return exitCode || 1;
    }
  }
  if ((await readSourceRevision()) !== sourceRevision) {
    write({ command: "verify-gates", effects: "local_validation", ok: false, gate: "source" });
    return 1;
  }
  const identities = await observeAuthorizedIdentities(config);
  if (!identities) {
    write({
      command: "verify-gates",
      effects: "read_only_identity_checks",
      ok: false,
      gate: "authorized_identities",
    });
    return 1;
  }
  const manifest = {
    schemaVersion: GATE_EVIDENCE_SCHEMA_VERSION,
    sourceRevision,
    releaseBundleDigest: config.releaseBundleDigest,
    completedAt: new Date().toISOString(),
    authorization: {
      idHash: digest(config.authorization.id),
      generation: config.authorization.generation,
    },
    identities,
    gates: {
      repository: "passed",
      browser: "passed",
      cloudReproduction: "passed",
      lifecycleSmoke: "passed",
      immutableRelease: "passed",
    },
  } as const;
  const manifestBytes = JSON.stringify(manifest);
  const evidence = {
    manifest,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKey.keyId,
      value: sign(null, Buffer.from(manifestBytes), signingKey.privateKeyPem).toString("base64url"),
    },
  } as const;
  const evidenceBytes = JSON.stringify(evidence);
  await mkdir(dirname(config.gateEvidencePath), { recursive: true });
  await writeFile(config.gateEvidencePath, evidenceBytes, { encoding: "utf8", mode: 0o600 });
  write({
    command: "verify-gates",
    effects: "local_validation",
    ok: true,
    gateEvidenceDigest: digest(evidenceBytes),
  });
  return 0;
}

async function readGateEvidence(
  config: OperatorConfig,
  signingKey: SigningKey,
  sourceRevision: string,
): Promise<VerifiedGateEvidence | null> {
  try {
    const evidenceBytes = await readFile(config.gateEvidencePath, "utf8");
    const evidence = JSON.parse(evidenceBytes) as unknown;
    if (!isRecord(evidence) || !isRecord(evidence.manifest) || !isRecord(evidence.signature)) {
      return null;
    }
    const manifest = evidence.manifest;
    const gates = manifest.gates;
    const authorization = manifest.authorization;
    const identities = manifest.identities;
    if (
      manifest.schemaVersion !== GATE_EVIDENCE_SCHEMA_VERSION ||
      manifest.sourceRevision !== sourceRevision ||
      manifest.releaseBundleDigest !== config.releaseBundleDigest ||
      typeof manifest.completedAt !== "string" ||
      !isRecord(authorization) ||
      authorization.idHash !== digest(config.authorization.id) ||
      authorization.generation !== config.authorization.generation ||
      !isRecord(identities) ||
      !isSha256(identities.digitalOceanAccount) ||
      identities.digitalOceanCredential !==
        digest(`digitalocean-credential:${process.env.BRUNO_DIGITALOCEAN_TOKEN}`) ||
      identities.modelCredential !== digest(`model-credential:${config.fixture.modelApiKey}`) ||
      !isSha256(identities.telegramBot) ||
      !isSha256(identities.telegramChat) ||
      identities.telegramCredential !==
        digest(`telegram-credential:${config.fixture.telegramBotToken}`) ||
      identities.telegramUser !== digest(`telegram-user:${config.fixture.telegramUserId}`) ||
      identities.modelProvider !== config.fixture.assistant ||
      !isRecord(gates) ||
      [
        gates.repository,
        gates.browser,
        gates.cloudReproduction,
        gates.lifecycleSmoke,
        gates.immutableRelease,
      ].some((value) => value !== "passed") ||
      evidence.signature.algorithm !== "Ed25519" ||
      evidence.signature.keyId !== signingKey.keyId ||
      typeof evidence.signature.value !== "string"
    ) {
      return null;
    }
    const valid = verify(
      null,
      Buffer.from(JSON.stringify(manifest)),
      createPublicKey(signingKey.privateKeyPem),
      Buffer.from(evidence.signature.value, "base64url"),
    );
    return valid
      ? {
          digest: digest(evidenceBytes),
          identities: {
            digitalOceanAccount: String(identities.digitalOceanAccount),
            digitalOceanCredential: String(identities.digitalOceanCredential),
            modelCredential: String(identities.modelCredential),
            telegramBot: String(identities.telegramBot),
            telegramChat: String(identities.telegramChat),
            telegramCredential: String(identities.telegramCredential),
            telegramUser: String(identities.telegramUser),
            modelProvider: identities.modelProvider as "chatgpt" | "claude",
          },
        }
      : null;
  } catch {
    return null;
  }
}

async function readCompletedCohortGate(
  connection: DatabaseConnection,
  cohortId: string,
  signingKey: SigningKey,
): Promise<boolean> {
  const [run] = await connection.db
    .select({
      signedReportBytes: providerTrialRuns.signedReportBytes,
      signedReportDigest: providerTrialRuns.signedReportDigest,
      signedReportKeyId: providerTrialRuns.signedReportKeyId,
      signedReportSignature: providerTrialRuns.signedReportSignature,
    })
    .from(providerTrialRuns)
    .where(eq(providerTrialRuns.cohortId, cohortId))
    .limit(1);
  try {
    const publicKeyPem = createPublicKey(signingKey.privateKeyPem)
      .export({ format: "pem", type: "spki" })
      .toString();
    if (
      !verifyProviderTrialDriverReport({
        canonicalBytes: run?.signedReportBytes ?? "",
        digest: run?.signedReportDigest ?? "",
        keyId: run?.signedReportKeyId ?? "",
        signature: run?.signedReportSignature ?? "",
        trustedPublicKeys: { [signingKey.keyId]: publicKeyPem },
      })
    ) {
      return false;
    }
    const report = JSON.parse(run?.signedReportBytes ?? "") as unknown;
    if (!isRecord(report) || !isRecord(report.cohort)) return false;
    const cohort = report.cohort;
    return (
      isRecord(cohort.apiAcceptance) &&
      typeof cohort.apiAcceptance.committed === "number" &&
      cohort.apiAcceptance.committed >= 29 &&
      isRecord(cohort.readiness) &&
      typeof cohort.readiness.readyWithin60 === "number" &&
      cohort.readiness.readyWithin60 >= 29 &&
      cohort.readiness.passesGate === true
    );
  } catch {
    return false;
  }
}

async function readAuthoritativeProviderCleanup(
  connection: DatabaseConnection,
  cohortId: string,
  signingKey: SigningKey,
): Promise<{ reportDigest: string | null; runState: "complete" | "paused" } | null> {
  const [run] = await connection.db
    .select({
      state: providerTrialRuns.state,
      pauseReason: providerTrialRuns.pauseReason,
      cleanupEvidence: providerTrialRuns.cleanupEvidence,
      signedReportBytes: providerTrialRuns.signedReportBytes,
      signedReportDigest: providerTrialRuns.signedReportDigest,
      signedReportKeyId: providerTrialRuns.signedReportKeyId,
      signedReportSignature: providerTrialRuns.signedReportSignature,
    })
    .from(providerTrialRuns)
    .where(eq(providerTrialRuns.cohortId, cohortId))
    .limit(1);
  if (!run || !["complete", "paused"].includes(run.state)) return null;
  if (
    !isRecord(run.cleanupEvidence) ||
    run.cleanupEvidence.ok !== true ||
    run.cleanupEvidence.authoritative !== true ||
    !Array.isArray(run.cleanupEvidence.remainingResourceIds) ||
    run.cleanupEvidence.remainingResourceIds.length !== 0
  ) {
    return null;
  }
  if (run.state === "paused") {
    return [
      "budget_exhausted",
      "gate_impossible",
      "observation_incomplete",
      "safety_pause",
    ].includes(run.pauseReason ?? "")
      ? { reportDigest: null, runState: "paused" }
      : null;
  }
  const publicKeyPem = createPublicKey(signingKey.privateKeyPem)
    .export({ format: "pem", type: "spki" })
    .toString();
  return verifyProviderTrialDriverReport({
    canonicalBytes: run.signedReportBytes ?? "",
    digest: run.signedReportDigest ?? "",
    keyId: run.signedReportKeyId ?? "",
    signature: run.signedReportSignature ?? "",
    trustedPublicKeys: { [signingKey.keyId]: publicKeyPem },
  })
    ? { reportDigest: run.signedReportDigest, runState: "complete" }
    : null;
}

async function observeAuthorizedIdentities(
  config: OperatorConfig,
): Promise<AuthorizedIdentityEvidence | null> {
  try {
    const [digitalOcean, telegramBot, telegramChat, model] = await Promise.all([
      fetchJson("https://api.digitalocean.com/v2/account", {
        authorization: `Bearer ${process.env.BRUNO_DIGITALOCEAN_TOKEN}`,
      }),
      fetchJson(`https://api.telegram.org/bot${config.fixture.telegramBotToken}/getMe`, {}),
      fetchJson(
        `https://api.telegram.org/bot${config.fixture.telegramBotToken}/getChat?chat_id=${encodeURIComponent(config.fixture.telegramChatId)}`,
        {},
      ),
      config.fixture.assistant === "chatgpt"
        ? fetchJson("https://api.openai.com/v1/models", {
            authorization: `Bearer ${config.fixture.modelApiKey}`,
          })
        : fetchJson("https://api.anthropic.com/v1/models", {
            "anthropic-version": "2023-06-01",
            "x-api-key": config.fixture.modelApiKey,
          }),
    ]);
    const account = isRecord(digitalOcean.body) ? digitalOcean.body.account : null;
    const botResult = isRecord(telegramBot.body) ? telegramBot.body.result : null;
    const chatResult = isRecord(telegramChat.body) ? telegramChat.body.result : null;
    if (
      digitalOcean.status !== 200 ||
      !isRecord(account) ||
      typeof account.uuid !== "string" ||
      telegramBot.status !== 200 ||
      !isRecord(botResult) ||
      typeof botResult.id !== "number" ||
      telegramChat.status !== 200 ||
      !isRecord(chatResult) ||
      String(chatResult.id) !== config.fixture.telegramChatId ||
      model.status !== 200
    ) {
      return null;
    }
    return {
      digitalOceanAccount: digest(`digitalocean:${account.uuid}`),
      digitalOceanCredential: digest(
        `digitalocean-credential:${process.env.BRUNO_DIGITALOCEAN_TOKEN}`,
      ),
      modelCredential: digest(`model-credential:${config.fixture.modelApiKey}`),
      telegramBot: digest(`telegram-bot:${botResult.id}`),
      telegramChat: digest(`telegram-chat:${chatResult.id}`),
      telegramCredential: digest(`telegram-credential:${config.fixture.telegramBotToken}`),
      telegramUser: digest(`telegram-user:${config.fixture.telegramUserId}`),
      modelProvider: config.fixture.assistant,
    };
  } catch {
    return null;
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Status remains authoritative when a provider returns a non-JSON error body.
  }
  return { status: response.status, body };
}

async function verifyCredentialCleanup(
  connection: DatabaseConnection,
  config: OperatorConfig,
  signingKey: SigningKey,
  sourceRevision: string,
  gateEvidence: VerifiedGateEvidence,
): Promise<number> {
  const [cohort] = await connection.db
    .select({ id: providerTrialCohorts.id })
    .from(providerTrialCohorts)
    .where(eq(providerTrialCohorts.cohortKey, config.cohortKey))
    .limit(1);
  const providerCleanup = cohort
    ? await readAuthoritativeProviderCleanup(connection, cohort.id, signingKey)
    : null;
  if (!cohort || !providerCleanup) {
    write({ command: "verify-credential-cleanup", ok: false, issues: ["provider_cleanup"] });
    return 1;
  }
  const [run] = await connection.db
    .select({
      configuration: providerTrialRuns.configuration,
      authorizationGeneration: providerTrialRuns.authorizationGeneration,
    })
    .from(providerTrialRuns)
    .where(eq(providerTrialRuns.cohortId, cohort.id))
    .limit(1);
  const [latestAuthorizationEvidence] = await connection.db
    .select()
    .from(providerTrialAuthorizationEvents)
    .where(eq(providerTrialAuthorizationEvents.cohortId, cohort.id))
    .orderBy(desc(providerTrialAuthorizationEvents.generation))
    .limit(1);
  if (
    !run ||
    run.authorizationGeneration !== config.authorization.generation ||
    !latestAuthorizationEvidence ||
    latestAuthorizationEvidence.generation !== config.authorization.generation ||
    latestAuthorizationEvidence.prerequisiteGateEvidenceDigest !== gateEvidence.digest ||
    latestAuthorizationEvidence.deploymentChoicesDigest !== config.deploymentChoicesDigest
  ) {
    return 1;
  }

  const credentialsRejected = await Promise.all([
    credentialRejected(
      "https://api.digitalocean.com/v2/account",
      { authorization: `Bearer ${process.env.BRUNO_DIGITALOCEAN_TOKEN}` },
      [401],
    ),
    config.fixture.assistant === "chatgpt"
      ? credentialRejected(
          "https://api.openai.com/v1/models",
          { authorization: `Bearer ${config.fixture.modelApiKey}` },
          [401],
        )
      : credentialRejected(
          "https://api.anthropic.com/v1/models",
          {
            "anthropic-version": "2023-06-01",
            "x-api-key": config.fixture.modelApiKey,
          },
          [401],
        ),
    credentialRejected(
      `https://api.telegram.org/bot${config.fixture.telegramBotToken}/getMe`,
      {},
      [401, 404],
    ),
  ]);
  if (credentialsRejected.some((rejected) => !rejected)) {
    write({
      command: "verify-credential-cleanup",
      ok: false,
      issues: ["credential_still_active"],
    });
    return 1;
  }

  const manifest = {
    schemaVersion: "bruno.provider-trial-credential-cleanup.v2",
    authorizedReleaseSourceRevision: config.releaseSourceRevision,
    cleanupOperatorSourceRevision: sourceRevision,
    gateEvidenceDigest: gateEvidence.digest,
    cohortReportDigest: providerCleanup.reportDigest,
    trialState: providerCleanup.runState,
    verifiedAt: new Date().toISOString(),
    credentials: {
      digitalOcean: "rejected",
      model: "rejected",
      telegram: "rejected",
      localCredentialFile: "absent",
      signingPrivateKey: "absent",
    },
  } as const;
  const pendingManifest = {
    ...manifest,
    credentials: {
      ...manifest.credentials,
      localCredentialFile: "pending_deletion",
      signingPrivateKey: "pending_deletion",
    },
  } as const;
  const pendingManifestBytes = JSON.stringify(pendingManifest);
  const pendingEvidenceBytes = JSON.stringify({
    manifest: pendingManifest,
    signature: {
      algorithm: "Ed25519",
      keyId: signingKey.keyId,
      value: sign(null, Buffer.from(pendingManifestBytes), signingKey.privateKeyPem).toString(
        "base64url",
      ),
    },
  });
  const evidencePath = `${config.gateEvidencePath}.credential-cleanup.json`;
  const pendingEvidencePath = `${evidencePath}.pending`;
  await writeFile(pendingEvidencePath, pendingEvidenceBytes, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await unlink(config.credentialFilePath);
    await unlink(config.signing.privateKeyPath);
    const manifestBytes = JSON.stringify(manifest);
    const evidenceBytes = JSON.stringify({
      manifest,
      signature: {
        algorithm: "Ed25519",
        keyId: signingKey.keyId,
        value: sign(null, Buffer.from(manifestBytes), signingKey.privateKeyPem).toString(
          "base64url",
        ),
      },
    });
    const finalPendingPath = `${evidencePath}.final-pending`;
    await writeFile(finalPendingPath, evidenceBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(finalPendingPath, evidencePath);
    await unlink(pendingEvidencePath).catch(() => undefined);
    write({
      command: "verify-credential-cleanup",
      effects: "credential_absence_verification",
      ok: true,
      evidenceDigest: digest(evidenceBytes),
    });
    return 0;
  } catch {
    write({
      command: "verify-credential-cleanup",
      ok: false,
      issues: ["local_cleanup_incomplete"],
      pendingEvidencePath,
    });
    return 1;
  }
}

async function credentialRejected(
  url: string,
  headers: Record<string, string>,
  rejectionStatuses: readonly number[],
): Promise<boolean> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    return rejectionStatuses.includes(response.status);
  } catch {
    return false;
  }
}

async function readSourceRevision(): Promise<string> {
  const [{ stdout }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: process.cwd(),
      encoding: "utf8",
    }),
  ]);
  const revision = stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(revision) || status.trim()) {
    throw new Error("source_revision_invalid");
  }
  return revision;
}

async function hasSafeArtifactPaths(config: OperatorConfig): Promise<boolean> {
  const evidenceDirectory = resolve(process.cwd(), ".vercel/provider-trial-evidence");
  const expected = {
    credential: resolve(process.cwd(), ".env.provider-trial.local"),
    gate: resolve(evidenceDirectory, "issue-299-prerequisite-gates.json"),
    privateKey: resolve(evidenceDirectory, "issue-299-ed25519-private.pem"),
  };
  if (
    resolve(config.credentialFilePath) !== expected.credential ||
    resolve(config.gateEvidencePath) !== expected.gate ||
    resolve(config.signing.privateKeyPath) !== expected.privateKey
  ) {
    return false;
  }
  try {
    const [vercel, evidence, credential, privateKey] = await Promise.all([
      lstat(resolve(process.cwd(), ".vercel")),
      lstat(evidenceDirectory),
      lstat(expected.credential),
      lstat(expected.privateKey),
    ]);
    if (
      !vercel.isDirectory() ||
      vercel.isSymbolicLink() ||
      !evidence.isDirectory() ||
      evidence.isSymbolicLink() ||
      !credential.isFile() ||
      credential.isSymbolicLink() ||
      !privateKey.isFile() ||
      privateKey.isSymbolicLink()
    ) {
      return false;
    }
    try {
      const gate = await lstat(expected.gate);
      return gate.isFile() && !gate.isSymbolicLink();
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function runCommand(command: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function gateEvidenceModeBeforeLease(
  run: { state: string; authorizationGeneration: number },
  incomingGeneration: number,
): "exact" | "renewed_authorization" {
  return run.state === "paused" && incomingGeneration > run.authorizationGeneration
    ? "renewed_authorization"
    : "exact";
}

try {
  process.exitCode = await main();
} catch {
  write({ command: process.argv[2] ?? "preflight", ok: false, safeCode: "operator_failure" });
  process.exitCode = 1;
}
