import { readFile } from "node:fs/promises";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  agentConfigs,
  agentDeployments,
  agentDeploymentStageEnum,
  agentDesiredStatusEnum,
  agentApprovals,
  agentApprovalStatusEnum,
  agentEvents,
  agentLogs,
  agentScheduleModeEnum,
  agentSecretKindEnum,
  agentSecrets,
  agentSecretStatusEnum,
  agentUsagePeriods,
  agents,
  agentStatusEnum,
  appMetadata,
  backups,
  dockerRunnerContainers,
  localRunnerProcesses,
  localRunnerProcessStatusEnum,
  runnerCredentials,
  runnerHeartbeats,
  runnerProvisioningEvents,
  runnerRegistrationTokens,
  runners,
  users,
} from "@/src/server/db/schema";

describe("Milestone 1 agent persistence schema", () => {
  it("defines the expected tables and agent status values", () => {
    expect(getTableName(appMetadata)).toBe("app_metadata");
    expect(getTableName(users)).toBe("users");
    expect(getTableName(agents)).toBe("agents");
    expect(getTableName(backups)).toBe("backups");
    expect(getTableName(agentConfigs)).toBe("agent_configs");
    expect(getTableName(agentSecrets)).toBe("agent_secrets");
    expect(getTableName(agentDeployments)).toBe("agent_deployments");
    expect(getTableName(agentUsagePeriods)).toBe("agent_usage_periods");
    expect(getTableName(agentApprovals)).toBe("agent_approvals");
    expect(getTableName(agentEvents)).toBe("agent_events");
    expect(getTableName(runners)).toBe("runners");
    expect(getTableName(runnerProvisioningEvents)).toBe("runner_provisioning_events");
    expect(getTableName(runnerRegistrationTokens)).toBe("runner_registration_tokens");
    expect(getTableName(runnerCredentials)).toBe("runner_credentials");
    expect(getTableName(runnerHeartbeats)).toBe("runner_heartbeats");
    expect(getTableName(localRunnerProcesses)).toBe("local_runner_processes");
    expect(getTableName(dockerRunnerContainers)).toBe("docker_runner_containers");
    expect(getTableName(agentLogs)).toBe("agent_logs");
    expect(agentStatusEnum.enumValues).toEqual([
      "idle",
      "starting",
      "running",
      "stopped",
      "restarting",
      "error",
      "deleting",
    ]);
    expect(agentDesiredStatusEnum.enumValues).toEqual(["stopped", "running"]);
    expect(agentDeploymentStageEnum.enumValues).toEqual([
      "pending",
      "provisioning_runner",
      "configuring_hermes",
      "starting_gateway",
      "verifying_model",
      "connecting_telegram",
      "ready",
      "failed",
    ]);
    expect(agentScheduleModeEnum.enumValues).toEqual(["manual", "cron"]);
    expect(agentApprovalStatusEnum.enumValues).toEqual([
      "pending",
      "approved",
      "denied",
      "expired",
      "cancelled",
    ]);
    expect(agentSecretKindEnum.enumValues).toEqual([
      "openrouter_api_key",
      "telegram_bot_token",
      "telegram_allowed_users",
      "api_server_key",
    ]);
    expect(agentSecretStatusEnum.enumValues).toEqual(["active", "revoked"]);
    expect(localRunnerProcessStatusEnum.enumValues).toEqual([
      "starting",
      "running",
      "stopped",
      "exited",
      "failed",
    ]);
  });

  it("keeps internal UUID users and stores only a nullable Clerk identity", () => {
    const columns = getTableColumns(users);

    expect(Object.keys(columns)).toEqual(["id", "clerkUserId", "createdAt", "updatedAt"]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.clerkUserId.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toEqual(
      expect.arrayContaining(["email", "displayName", "sessionId", "profile"]),
    );
  });

  it("generates an additive nullable unique Clerk identity migration", async () => {
    const migration = await readFile("drizzle/0014_tiny_abomination.sql", "utf8");

    expect(migration).toContain('ALTER TABLE "users" ADD COLUMN "clerk_user_id" text');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "users_clerk_user_id_idx" ON "users" USING btree ("clerk_user_id")',
    );
    expect(migration).not.toContain('"clerk_user_id" text NOT NULL');
    expect(migration).not.toMatch(/email|display_name|session|profile/i);
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|UPDATE /);
    expect(migration.match(/ALTER TABLE/g)).toHaveLength(1);
  });

  it("defines durable usage periods without secret-bearing fields", () => {
    const columns = getTableColumns(agentUsagePeriods);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "runnerId",
      "source",
      "startedAt",
      "stoppedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.source.notNull).toBe(true);
    expect(columns.source.default).toBe("lifecycle");
    expect(columns.startedAt.notNull).toBe(true);
    expect(columns.stoppedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toContain("metadata");
    expect(Object.keys(columns)).not.toContain("endpointUrl");
    expect(Object.keys(columns)).not.toContain("credential");
    expect(Object.keys(columns)).not.toContain("providerToken");
    expect(Object.keys(columns)).not.toContain("bearerToken");
    expect(Object.keys(columns)).not.toContain("storageUri");
  });

  it("defines encrypted agent secret rows with one active value per agent and no plaintext column", () => {
    const columns = getTableColumns(agentSecrets);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "kind",
      "ciphertext",
      "iv",
      "authTag",
      "keyVersion",
      "fingerprint",
      "uniquenessFingerprint",
      "providerSubjectId",
      "providerUsername",
      "status",
      "createdAt",
      "updatedAt",
      "rotatedAt",
      "revokedAt",
    ]);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.kind.notNull).toBe(true);
    expect(columns.ciphertext.notNull).toBe(true);
    expect(columns.iv.notNull).toBe(true);
    expect(columns.authTag.notNull).toBe(true);
    expect(columns.keyVersion.notNull).toBe(true);
    expect(columns.fingerprint.notNull).toBe(true);
    expect(columns.uniquenessFingerprint.notNull).toBe(false);
    expect(columns.providerSubjectId.notNull).toBe(false);
    expect(columns.providerUsername.notNull).toBe(false);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("active");
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.rotatedAt.notNull).toBe(false);
    expect(columns.revokedAt.notNull).toBe(false);
    expect(Object.keys(columns)).not.toContain("plaintext");
    expect(Object.keys(columns)).not.toContain("value");
    expect(Object.keys(columns)).not.toContain("secret");
  });

  it("generates additive Telegram secret metadata migration SQL", async () => {
    const migration = await readFile("drizzle/0017_ambitious_tyrannus.sql", "utf8");

    expect(migration).toContain(
      'ALTER TABLE "agent_secrets" ADD COLUMN "uniqueness_fingerprint" text',
    );
    expect(migration).toContain(
      'ALTER TABLE "agent_secrets" ADD COLUMN "provider_subject_id" text',
    );
    expect(migration).toContain('ALTER TABLE "agent_secrets" ADD COLUMN "provider_username" text');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "agent_secrets_active_telegram_uniqueness_idx"',
    );
    expect(migration).toContain(
      `"agent_secrets"."kind" = 'telegram_bot_token' AND "agent_secrets"."status" = 'active'`,
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_secrets_active_telegram_subject_idx"');
    expect(migration).toContain("agent_secrets_uniqueness_fingerprint_check");
    expect(migration).toContain("agent_secrets_telegram_metadata_kind_check");
    expect(migration).toContain("agent_secrets_telegram_metadata_pair_check");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|(?:^|\n)UPDATE /);
  });

  it("generates an additive encrypted agent secret migration without plaintext fields", async () => {
    const migration = await readFile("drizzle/0015_dear_leader.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_secret_kind"');
    expect(migration).toContain('CREATE TYPE "public"."agent_secret_status"');
    expect(migration).toContain('CREATE TABLE "agent_secrets"');
    expect(migration).toContain('"ciphertext" text NOT NULL');
    expect(migration).toContain('"iv" text NOT NULL');
    expect(migration).toContain('"auth_tag" text NOT NULL');
    expect(migration).toContain('"key_version" text NOT NULL');
    expect(migration).toContain('"fingerprint" text NOT NULL');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_secrets_active_agent_kind_idx"');
    expect(migration).toContain('WHERE "agent_secrets"."status" = \'active\'');
    expect(migration).not.toMatch(/plaintext| raw_| value text|secret_value/i);
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|(?:^|\n)UPDATE /);
  });

  it("generates a durable usage-period migration with interval constraints and no secret columns", async () => {
    const migration = await readFile("drizzle/0013_mighty_firestar.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "agent_usage_periods"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"runner_id" uuid');
    expect(migration).toContain('"started_at" timestamp with time zone NOT NULL');
    expect(migration).toContain('"stopped_at" timestamp with time zone');
    expect(migration).toContain("agent_usage_periods_stopped_after_started_check");
    expect(migration).toContain(
      '"agent_usage_periods"."stopped_at" >= "agent_usage_periods"."started_at"',
    );
    expect(migration).toContain('CREATE INDEX "agent_usage_periods_agent_started_idx"');
    expect(migration).toContain('CREATE INDEX "agent_usage_periods_runner_started_idx"');
    expect(migration).toContain('CREATE INDEX "agent_usage_periods_agent_stopped_idx"');
    expect(migration).not.toMatch(
      /api[_ ]?key|token|password|secret|credential|endpoint|storage[_ ]?uri|metadata/i,
    );
  });

  it("keeps agent records owned, stopped by default, timestamped, and soft deletable", () => {
    const columns = getTableColumns(agents);

    expect(Object.keys(columns)).toEqual([
      "id",
      "userId",
      "runnerId",
      "name",
      "templateKey",
      "templateVersion",
      "templateSnapshotJson",
      "status",
      "desiredStatus",
      "statusReason",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.name.notNull).toBe(true);
    expect(columns.templateKey.notNull).toBe(true);
    expect(columns.templateVersion.notNull).toBe(true);
    expect(columns.templateVersion.default).toBe("1.0.0");
    expect(columns.templateSnapshotJson.notNull).toBe(true);
    expect(columns.templateSnapshotJson.dataType).toBe("json");
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("stopped");
    expect(columns.desiredStatus.notNull).toBe(true);
    expect(columns.desiredStatus.default).toBe("stopped");
    expect(columns.statusReason.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.deletedAt.notNull).toBe(false);
  });

  it("defines owner-bound deployment operations with durable lease and safe error fields", () => {
    const columns = getTableColumns(agentDeployments);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "userId",
      "stage",
      "configRevision",
      "idempotencyKey",
      "attemptCount",
      "errorCode",
      "errorDetail",
      "nextAttemptAt",
      "leaseOwner",
      "leaseExpiresAt",
      "startedAt",
      "completedAt",
      "failedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.stage.notNull).toBe(true);
    expect(columns.stage.default).toBe("pending");
    expect(columns.configRevision.notNull).toBe(true);
    expect(columns.idempotencyKey.notNull).toBe(true);
    expect(columns.attemptCount.notNull).toBe(true);
    expect(columns.attemptCount.default).toBe(0);
    expect(columns.errorCode.notNull).toBe(false);
    expect(columns.errorDetail.notNull).toBe(false);
    expect(columns.nextAttemptAt.notNull).toBe(false);
    expect(columns.leaseOwner.notNull).toBe(false);
    expect(columns.leaseExpiresAt.notNull).toBe(false);
    expect(columns.startedAt.notNull).toBe(false);
    expect(columns.completedAt.notNull).toBe(false);
    expect(columns.failedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("generates additive desired-state and deployment-operation migration SQL", async () => {
    const migration = await readFile("drizzle/0016_motionless_fantastic_four.sql", "utf8");

    expect(migration).toContain(
      `CREATE TYPE "public"."agent_desired_status" AS ENUM('stopped', 'running')`,
    );
    expect(migration).toContain(
      `CREATE TYPE "public"."agent_deployment_stage" AS ENUM('pending', 'provisioning_runner', 'configuring_hermes', 'starting_gateway', 'verifying_model', 'connecting_telegram', 'ready', 'failed')`,
    );
    expect(migration).toContain('CREATE TABLE "agent_deployments"');
    expect(migration).toContain(
      'ALTER TABLE "agents" ADD COLUMN "desired_status" "agent_desired_status" DEFAULT \'stopped\' NOT NULL',
    );
    expect(migration).toContain(
      'ALTER TABLE "agents" ADD CONSTRAINT "agents_id_user_id_unique" UNIQUE("id","user_id")',
    );
    expect(migration.indexOf("agents_id_user_id_unique")).toBeLessThan(
      migration.indexOf("agent_deployments_agent_owner_fk"),
    );
    expect(migration).toContain(
      'FOREIGN KEY ("agent_id","user_id") REFERENCES "public"."agents"("id","user_id")',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_deployments_user_idempotency_idx"');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_deployments_active_agent_idx"');
    expect(migration).toContain(`WHERE "agent_deployments"."stage" NOT IN ('ready', 'failed')`);
    expect(migration).toContain('CREATE INDEX "agent_deployments_user_agent_created_idx"');
    expect(migration).toContain('CREATE INDEX "agent_deployments_claim_idx"');
    expect(migration).toContain("agent_deployments_config_revision_check");
    expect(migration).toContain("agent_deployments_idempotency_key_check");
    expect(migration).toContain("agent_deployments_lease_pair_check");
    expect(migration).toContain("agent_deployments_terminal_clear_work_check");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER COLUMN|(?:^|\n)UPDATE /);
  });

  it("defines durable manual runner identity rows with soft-delete support", () => {
    const columns = getTableColumns(runners);

    expect(Object.keys(columns)).toEqual([
      "id",
      "userId",
      "name",
      "kind",
      "endpointUrl",
      "status",
      "provider",
      "providerResourceId",
      "region",
      "sizeSlug",
      "image",
      "provisioningStatus",
      "provisioningError",
      "provisioningStartedAt",
      "provisioningCompletedAt",
      "createdAt",
      "updatedAt",
      "deletedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.name.notNull).toBe(true);
    expect(columns.kind.notNull).toBe(true);
    expect(columns.kind.default).toBe("manual_vps");
    expect(columns.endpointUrl.notNull).toBe(false);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("active");
    expect(columns.provider.notNull).toBe(false);
    expect(columns.providerResourceId.notNull).toBe(false);
    expect(columns.region.notNull).toBe(false);
    expect(columns.sizeSlug.notNull).toBe(false);
    expect(columns.image.notNull).toBe(false);
    expect(columns.provisioningStatus.notNull).toBe(false);
    expect(columns.provisioningError.notNull).toBe(false);
    expect(columns.provisioningStartedAt.notNull).toBe(false);
    expect(columns.provisioningCompletedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(columns.deletedAt.notNull).toBe(false);
  });

  it("defines one-time runner registration token rows with hashes only", () => {
    const columns = getTableColumns(runnerRegistrationTokens);

    expect(Object.keys(columns)).toEqual([
      "id",
      "userId",
      "runnerId",
      "tokenHash",
      "tokenPrefix",
      "status",
      "expiresAt",
      "usedAt",
      "revokedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.userId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.tokenHash.notNull).toBe(true);
    expect(columns.tokenPrefix.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("pending");
    expect(columns.expiresAt.notNull).toBe(true);
    expect(columns.usedAt.notNull).toBe(false);
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toContain("token");
    expect(Object.keys(columns)).not.toContain("rawToken");
  });

  it("defines runner provisioning event rows with safe metadata snapshots", () => {
    const columns = getTableColumns(runnerProvisioningEvents);

    expect(Object.keys(columns)).toEqual([
      "id",
      "runnerId",
      "phase",
      "status",
      "message",
      "metadata",
      "createdAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(true);
    expect(columns.phase.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.createdAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toContain("registrationToken");
    expect(Object.keys(columns)).not.toContain("credential");
    expect(Object.keys(columns)).not.toContain("providerToken");
  });

  it("defines runner credential rows with credential hashes only", () => {
    const columns = getTableColumns(runnerCredentials);

    expect(Object.keys(columns)).toEqual([
      "id",
      "runnerId",
      "credentialHash",
      "credentialPrefix",
      "status",
      "lastUsedAt",
      "expiresAt",
      "revokedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(true);
    expect(columns.credentialHash.notNull).toBe(true);
    expect(columns.credentialPrefix.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("active");
    expect(columns.lastUsedAt.notNull).toBe(false);
    expect(columns.expiresAt.notNull).toBe(false);
    expect(columns.revokedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
    expect(Object.keys(columns)).not.toContain("credential");
    expect(Object.keys(columns)).not.toContain("rawCredential");
  });

  it("defines runner heartbeat history rows scoped to a runner", () => {
    const columns = getTableColumns(runnerHeartbeats);

    expect(Object.keys(columns)).toEqual([
      "id",
      "runnerId",
      "status",
      "metadata",
      "observedAt",
      "createdAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.observedAt.notNull).toBe(true);
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("defines one typed config row per agent with safe non-secret defaults", () => {
    const columns = getTableColumns(agentConfigs);

    expect(Object.keys(columns)).toEqual([
      "agentId",
      "systemPrompt",
      "modelProvider",
      "modelName",
      "maxDailySpendCents",
      "scheduleMode",
      "scheduleCron",
      "timezone",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.systemPrompt.notNull).toBe(true);
    expect(columns.modelProvider.notNull).toBe(true);
    expect(columns.modelProvider.default).toBe("not_configured");
    expect(columns.modelName.notNull).toBe(true);
    expect(columns.modelName.default).toBe("not_configured");
    expect(columns.maxDailySpendCents.notNull).toBe(true);
    expect(columns.maxDailySpendCents.default).toBe(0);
    expect(columns.maxDailySpendCents.dataType).toBe("number");
    expect(columns.scheduleMode.notNull).toBe(true);
    expect(columns.scheduleMode.default).toBe("manual");
    expect(columns.scheduleCron.notNull).toBe(false);
    expect(columns.timezone.notNull).toBe(true);
    expect(columns.timezone.default).toBe("UTC");
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("defines backup rows with safe manifest storage and restore lifecycle columns", () => {
    const columns = getTableColumns(backups);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "runnerId",
      "status",
      "storageUri",
      "manifestJson",
      "createdBy",
      "createdAt",
      "restoredAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("pending");
    expect(columns.storageUri.notNull).toBe(false);
    expect(columns.manifestJson.notNull).toBe(true);
    expect(columns.manifestJson.dataType).toBe("json");
    expect(columns.createdBy.notNull).toBe(true);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.restoredAt.notNull).toBe(false);
    expect(Object.keys(columns)).not.toContain("secret");
    expect(Object.keys(columns)).not.toContain("token");
    expect(Object.keys(columns)).not.toContain("password");
    expect(Object.keys(columns)).not.toContain("credential");
  });

  it("supports agent.created audit event rows with JSON metadata", () => {
    const columns = getTableColumns(agentEvents);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "actorUserId",
      "type",
      "message",
      "metadata",
      "createdAt",
    ]);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.actorUserId.notNull).toBe(true);
    expect(columns.type.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("defines durable agent log rows scoped by agent and sequence", () => {
    const columns = getTableColumns(agentLogs);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "runnerId",
      "localRunnerProcessId",
      "dockerRunnerContainerId",
      "source",
      "stream",
      "level",
      "message",
      "metadata",
      "sequence",
      "createdAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.runnerId.notNull).toBe(false);
    expect(columns.localRunnerProcessId.notNull).toBe(false);
    expect(columns.dockerRunnerContainerId.notNull).toBe(false);
    expect(columns.source.notNull).toBe(true);
    expect(columns.source.default).toBe("simulator");
    expect(columns.stream.notNull).toBe(true);
    expect(columns.level.notNull).toBe(true);
    expect(columns.message.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.sequence.notNull).toBe(true);
    expect(columns.sequence.dataType).toBe("number");
    expect(columns.createdAt.notNull).toBe(true);
  });

  it("defines Docker runner container metadata rows scoped to agents", () => {
    const columns = getTableColumns(dockerRunnerContainers);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "containerId",
      "containerName",
      "image",
      "observedStatus",
      "metadata",
      "observedAt",
      "startedAt",
      "finishedAt",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.containerId.notNull).toBe(true);
    expect(columns.containerName.notNull).toBe(true);
    expect(columns.image.notNull).toBe(true);
    expect(columns.observedStatus.notNull).toBe(true);
    expect(columns.metadata.notNull).toBe(true);
    expect(columns.metadata.dataType).toBe("json");
    expect(columns.observedAt.notNull).toBe(true);
    expect(columns.startedAt.notNull).toBe(false);
    expect(columns.finishedAt.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("defines local runner process metadata rows scoped to agents", () => {
    const columns = getTableColumns(localRunnerProcesses);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "pid",
      "commandMetadata",
      "status",
      "startedAt",
      "stoppedAt",
      "exitCode",
      "signal",
      "lastError",
      "createdAt",
      "updatedAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.pid.notNull).toBe(true);
    expect(columns.pid.dataType).toBe("number");
    expect(columns.commandMetadata.notNull).toBe(true);
    expect(columns.commandMetadata.dataType).toBe("json");
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("running");
    expect(columns.startedAt.notNull).toBe(true);
    expect(columns.stoppedAt.notNull).toBe(false);
    expect(columns.exitCode.notNull).toBe(false);
    expect(columns.signal.notNull).toBe(false);
    expect(columns.lastError.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.updatedAt.notNull).toBe(true);
  });

  it("defines pending approval rows without exposing raw payload through display contracts", () => {
    const columns = getTableColumns(agentApprovals);

    expect(Object.keys(columns)).toEqual([
      "id",
      "agentId",
      "title",
      "description",
      "status",
      "payloadJson",
      "requestedBy",
      "resolvedBy",
      "createdAt",
      "resolvedAt",
      "expiresAt",
    ]);
    expect(columns.id.notNull).toBe(true);
    expect(columns.agentId.notNull).toBe(true);
    expect(columns.title.notNull).toBe(true);
    expect(columns.description.notNull).toBe(true);
    expect(columns.status.notNull).toBe(true);
    expect(columns.status.default).toBe("pending");
    expect(columns.payloadJson.notNull).toBe(true);
    expect(columns.payloadJson.dataType).toBe("json");
    expect(columns.requestedBy.notNull).toBe(true);
    expect(columns.resolvedBy.notNull).toBe(false);
    expect(columns.createdAt.notNull).toBe(true);
    expect(columns.resolvedAt.notNull).toBe(false);
    expect(columns.expiresAt.notNull).toBe(false);
  });

  it("generates a migration for the enum and Milestone 1 tables without changing app_metadata", async () => {
    const migration = await readFile("drizzle/0001_optimal_texas_twister.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_status"');
    expect(migration).toContain('CREATE TABLE "users"');
    expect(migration).toContain('CREATE TABLE "agents"');
    expect(migration).toContain('CREATE TABLE "agent_events"');
    expect(migration).toContain('"status" "agent_status" DEFAULT \'stopped\' NOT NULL');
    expect(migration).toContain("\"metadata\" jsonb DEFAULT '{}'::jsonb NOT NULL");
    expect(migration).toContain('FOREIGN KEY ("user_id") REFERENCES "public"."users"("id")');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive agent_logs migration without rewriting existing tables or enums", async () => {
    const migration = await readFile("drizzle/0002_icy_star_brand.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "agent_logs"');
    expect(migration).toContain('"runner_id" uuid');
    expect(migration).toContain('"sequence" integer NOT NULL');
    expect(migration).toContain('CONSTRAINT "agent_logs_sequence_positive_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain('CREATE UNIQUE INDEX "agent_logs_agent_sequence_idx"');
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TYPE "public"."agent_status"');
    expect(migration).not.toContain('ALTER TABLE "agents"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toContain('ALTER TABLE "users"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive agent_configs migration with active-agent backfill and no secret columns", async () => {
    const migration = await readFile("drizzle/0003_mature_sandman.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_schedule_mode"');
    expect(migration).toContain('CREATE TABLE "agent_configs"');
    expect(migration).toContain('"agent_id" uuid PRIMARY KEY NOT NULL');
    expect(migration).toContain('"system_prompt" text NOT NULL');
    expect(migration).toContain("\"model_provider\" text DEFAULT 'not_configured' NOT NULL");
    expect(migration).toContain("\"model_name\" text DEFAULT 'not_configured' NOT NULL");
    expect(migration).toContain('"max_daily_spend_cents" integer DEFAULT 0 NOT NULL');
    expect(migration).toContain(
      '"schedule_mode" "agent_schedule_mode" DEFAULT \'manual\' NOT NULL',
    );
    expect(migration).toContain('"schedule_cron" text');
    expect(migration).toContain("\"timezone\" text DEFAULT 'UTC' NOT NULL");
    expect(migration).toContain('CONSTRAINT "agent_configs_max_daily_spend_nonnegative_check"');
    expect(migration).toContain('CONSTRAINT "agent_configs_schedule_cron_mode_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain('INSERT INTO "agent_configs"');
    expect(migration).toContain('FROM "agents"');
    expect(migration).toContain('WHERE "agents"."deleted_at" IS NULL');
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret/i);
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
  });

  it("generates an additive agent_approvals migration with exact lifecycle statuses", async () => {
    const migration = await readFile("drizzle/0004_careless_santa_claus.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."agent_approval_status"');
    expect(migration).toContain("'pending'");
    expect(migration).toContain("'approved'");
    expect(migration).toContain("'denied'");
    expect(migration).toContain("'expired'");
    expect(migration).toContain("'cancelled'");
    expect(migration).toContain('CREATE TABLE "agent_approvals"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"title" text NOT NULL');
    expect(migration).toContain('"description" text NOT NULL');
    expect(migration).toContain('"status" "agent_approval_status" DEFAULT \'pending\' NOT NULL');
    expect(migration).toContain('"payload_json" jsonb NOT NULL');
    expect(migration).toContain('"requested_by" text NOT NULL');
    expect(migration).toContain('"resolved_by" text');
    expect(migration).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(migration).toContain('"resolved_at" timestamp with time zone');
    expect(migration).toContain('"expires_at" timestamp with time zone');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "agent_configs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "agents"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toContain('ALTER TABLE "agent_logs"');
    expect(migration).not.toContain('ALTER TABLE "agent_configs"');
    expect(migration).not.toContain('ALTER TABLE "users"');
    expect(migration).not.toContain('ALTER TABLE "app_metadata"');
  });

  it("generates an additive local runner state migration without merging logs into audit events", async () => {
    const migration = await readFile("drizzle/0005_local_runner_state.sql", "utf8");

    expect(migration).toContain('CREATE TYPE "public"."local_runner_process_status"');
    expect(migration).toContain("'starting'");
    expect(migration).toContain("'running'");
    expect(migration).toContain("'stopped'");
    expect(migration).toContain("'exited'");
    expect(migration).toContain("'failed'");
    expect(migration).toContain('CREATE TABLE "local_runner_processes"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"pid" integer NOT NULL');
    expect(migration).toContain('"command_metadata" jsonb NOT NULL');
    expect(migration).toContain(
      '"status" "local_runner_process_status" DEFAULT \'running\' NOT NULL',
    );
    expect(migration).toContain('"started_at" timestamp with time zone NOT NULL');
    expect(migration).toContain('"stopped_at" timestamp with time zone');
    expect(migration).toContain('"exit_code" integer');
    expect(migration).toContain('"signal" text');
    expect(migration).toContain('"last_error" text');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_pid_positive_check"');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_exit_code_nonnegative_check"');
    expect(migration).toContain('CONSTRAINT "local_runner_processes_stopped_after_started_check"');
    expect(migration).toContain('ALTER TABLE "agent_logs" ADD COLUMN "local_runner_process_id"');
    expect(migration).toContain('CONSTRAINT "agent_logs_stream_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain(
      'FOREIGN KEY ("local_runner_process_id") REFERENCES "public"."local_runner_processes"("id")',
    );
    expect(migration).not.toContain('DROP TABLE "agents"');
    expect(migration).not.toContain('DROP TABLE "agent_events"');
    expect(migration).not.toContain('DROP TABLE "agent_logs"');
    expect(migration).not.toContain('DROP TABLE "agent_approvals"');
    expect(migration).not.toContain('DROP TABLE "agent_configs"');
    expect(migration).not.toContain('DROP TABLE "users"');
    expect(migration).not.toContain('DROP TABLE "app_metadata"');
    expect(migration).not.toContain('ALTER TABLE "agent_events"');
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });

  it("generates an additive manual runner persistence migration", async () => {
    const migration = await readFile("drizzle/0008_equal_zarek.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "runners"');
    expect(migration).toContain("\"kind\" text DEFAULT 'manual_vps' NOT NULL");
    expect(migration).toContain("\"status\" text DEFAULT 'active' NOT NULL");
    expect(migration).toContain('ALTER TABLE "agents" ADD COLUMN "runner_id" uuid');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "runners_active_user_endpoint_idx" ON "runners"',
    );
    expect(migration).toContain('WHERE "runners"."deleted_at" IS NULL');
    expect(migration).toContain(
      'ALTER TABLE "agents" ADD CONSTRAINT "agents_runner_id_runners_id_fk"',
    );
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).not.toContain("DROP COLUMN");
    expect(migration).not.toContain("ALTER COLUMN");
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });

  it("generates an additive runner auth persistence migration with hashed storage only", async () => {
    const migration = await readFile("drizzle/0009_worried_switch.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "runner_registration_tokens"');
    expect(migration).toContain('CREATE TABLE "runner_credentials"');
    expect(migration).toContain('CREATE TABLE "runner_heartbeats"');
    expect(migration).toContain('"token_hash" text NOT NULL');
    expect(migration).toContain('"token_prefix" text NOT NULL');
    expect(migration).toContain('"credential_hash" text NOT NULL');
    expect(migration).toContain('"credential_prefix" text NOT NULL');
    expect(migration).toContain('"expires_at" timestamp with time zone NOT NULL');
    expect(migration).toContain('"used_at" timestamp with time zone');
    expect(migration).toContain('"revoked_at" timestamp with time zone');
    expect(migration).toContain('"observed_at" timestamp with time zone NOT NULL');
    expect(migration).toContain("'registering'");
    expect(migration).toContain("'online'");
    expect(migration).toContain("'offline'");
    expect(migration).toContain("'degraded'");
    expect(migration).toContain("'provisioning'");
    expect(migration).toContain("'provision_failed'");
    expect(migration).toContain("'deleting'");
    expect(migration).toContain("'deleted'");
    expect(migration).toContain('CREATE UNIQUE INDEX "runner_registration_tokens_hash_idx"');
    expect(migration).toContain(
      'CREATE INDEX "runner_registration_tokens_user_status_expires_idx"',
    );
    expect(migration).toContain('CREATE UNIQUE INDEX "runner_credentials_hash_idx"');
    expect(migration).toContain('CREATE INDEX "runner_credentials_runner_status_idx"');
    expect(migration).toContain('CREATE INDEX "runner_heartbeats_runner_observed_idx"');
    expect(migration).toContain('CREATE INDEX "agents_runner_id_idx"');
    expect(migration).toContain('FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id")');
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).not.toContain("DROP COLUMN");
    expect(migration).not.toContain("ALTER COLUMN");
    expect(migration).not.toContain('"token" text');
    expect(migration).not.toContain('"credential" text');
    expect(migration).not.toContain("raw_token");
    expect(migration).not.toContain("raw_credential");
  });

  it("generates a durable cloud runner provisioning migration without secret columns", async () => {
    const migration = await readFile("drizzle/0010_quick_warbird.sql", "utf8");

    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "provider" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "provider_resource_id" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "region" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "size_slug" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "image" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "provisioning_status" text');
    expect(migration).toContain('ALTER TABLE "runners" ADD COLUMN "provisioning_error" text');
    expect(migration).toContain(
      'ALTER TABLE "runners" ADD COLUMN "provisioning_started_at" timestamp with time zone',
    );
    expect(migration).toContain(
      'ALTER TABLE "runners" ADD COLUMN "provisioning_completed_at" timestamp with time zone',
    );
    expect(migration).toContain('DROP CONSTRAINT "runners_kind_manual_vps_check"');
    expect(migration).toContain('CONSTRAINT "runners_kind_check"');
    expect(migration).toContain("'manual_vps'");
    expect(migration).toContain("'digitalocean'");
    expect(migration).toContain('CONSTRAINT "runners_digitalocean_provider_fields_check"');
    expect(migration).toContain("'firewall_configuring'");
    expect(migration).toContain("'waiting_for_runner'");
    expect(migration).toContain('CREATE INDEX "runners_provider_resource_idx"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "runners_active_user_endpoint_idx" ON "runners"',
    );
    expect(migration).toContain('WHERE "runners"."deleted_at" IS NULL');
    expect(migration).toContain('"runners"."endpoint_url" IS NOT NULL');
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });

  it("generates durable cloud runner provisioning event migration without secret columns", async () => {
    const migration = await readFile("drizzle/0011_blushing_brother_voodoo.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "runner_provisioning_events"');
    expect(migration).toContain('"phase" text NOT NULL');
    expect(migration).toContain('"status" text NOT NULL');
    expect(migration).toContain("\"metadata\" jsonb DEFAULT '{}'::jsonb NOT NULL");
    expect(migration).toContain("'bootstrapping'");
    expect(migration).toContain("'waiting_for_runner'");
    expect(migration).toContain("'ready'");
    expect(migration).toContain('"runner_provisioning_events_runner_created_idx"');
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });

  it("generates an additive backup manifest migration without raw secret columns", async () => {
    const migration = await readFile("drizzle/0012_curly_franklin_storm.sql", "utf8");

    expect(migration).toContain('CREATE TABLE "backups"');
    expect(migration).toContain('"agent_id" uuid NOT NULL');
    expect(migration).toContain('"runner_id" uuid');
    expect(migration).toContain("\"status\" text DEFAULT 'pending' NOT NULL");
    expect(migration).toContain('"storage_uri" text');
    expect(migration).toContain('"manifest_json" jsonb NOT NULL');
    expect(migration).toContain('"created_by" uuid NOT NULL');
    expect(migration).toContain('"created_at" timestamp with time zone DEFAULT now() NOT NULL');
    expect(migration).toContain('"restored_at" timestamp with time zone');
    expect(migration).toContain('CONSTRAINT "backups_status_check"');
    expect(migration).toContain("'pending'");
    expect(migration).toContain("'uploading'");
    expect(migration).toContain("'ready'");
    expect(migration).toContain("'failed'");
    expect(migration).toContain("'restoring'");
    expect(migration).toContain("'restored'");
    expect(migration).toContain('CONSTRAINT "backups_storage_uri_not_empty_check"');
    expect(migration).toContain('CONSTRAINT "backups_restored_at_status_check"');
    expect(migration).toContain('FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id")');
    expect(migration).toContain('FOREIGN KEY ("runner_id") REFERENCES "public"."runners"("id")');
    expect(migration).toContain('FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")');
    expect(migration).toContain('CREATE INDEX "backups_agent_created_idx"');
    expect(migration).toContain('CREATE INDEX "backups_runner_idx"');
    expect(migration).toContain('CREATE INDEX "backups_created_by_idx"');
    expect(migration).toContain('CREATE INDEX "backups_status_idx"');
    expect(migration).not.toContain("DROP TABLE");
    expect(migration).not.toContain("DROP COLUMN");
    expect(migration).not.toContain("ALTER COLUMN");
    expect(migration).not.toMatch(/api[_ ]?key|token|password|secret|credential/i);
  });
});
