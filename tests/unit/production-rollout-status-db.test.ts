import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentDeploymentForUser } from "@/src/server/agents/agent-deployments";
import { captureAgentDeploymentChoicesFromEnvironment } from "@/src/server/agents/agent-deployment-choices";
import { readProductionRolloutStatus } from "@/src/server/agents/production-rollout-status";
import { getAgentTemplateSnapshot } from "@/src/server/agents/templates";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agents, users } from "@/src/server/db/schema";

const USER_ID = "00000000-0000-4000-8000-000000003001";
const AGENT_ID = "00000000-0000-4000-8000-000000003002";
const RUNNER_IMAGE = `ghcr.io/ametel01/bruno-runner:${"a".repeat(40)}@sha256:${"b".repeat(64)}`;
const BASELINE_ENV = {
  BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION: "v1",
  BRUNO_AGENT_SECRET_KEYS_JSON: JSON.stringify({
    v1: Buffer.alloc(32, 7).toString("base64"),
  }),
  BRUNO_COLD_PROVISIONING_HALT_REASON: "rollout_exercise",
  BRUNO_DEPLOYMENT_DISPATCH_MODE: "cron",
  BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS: "12",
  BRUNO_DIGITALOCEAN_IMAGE_MODE: "stock",
  BRUNO_DIGITALOCEAN_PROVIDER_MODE: "digitalocean",
  BRUNO_DIGITALOCEAN_REGION: "sfo3",
  BRUNO_DIGITALOCEAN_SIZE_SLUG: "s-2vcpu-2gb",
  BRUNO_DIGITALOCEAN_TOKEN: "provider-secret-present",
  BRUNO_ROLLOUT_CONFIGURATION_GENERATION: "2",
  BRUNO_RUNNER_BEARER_TOKEN: "runner-secret-present",
  BRUNO_RUNNER_BOOT_VALIDATION_MODE: "full",
  BRUNO_RUNNER_IMAGE: RUNNER_IMAGE,
};

describe("production rollout status persistence", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
    await connection.db.insert(users).values({ id: USER_ID });
    await connection.db.insert(agents).values({
      id: AGENT_ID,
      userId: USER_ID,
      name: "Pinned rollout agent",
      templateKey: "research_agent",
      templateSnapshotJson: getAgentTemplateSnapshot("research_agent"),
    });
  });

  afterEach(async () => {
    await connection.client`truncate table agent_deployments, agents, users restart identity cascade`;
    await connection.close();
  });

  it("reports counts by pinned active generation without identities or credentials", async () => {
    const choices = captureAgentDeploymentChoicesFromEnvironment(BASELINE_ENV, 2);
    const inserted = await connection.db.transaction((tx) =>
      createAgentDeploymentForUser({
        db: tx,
        userId: USER_ID,
        agentId: AGENT_ID,
        configRevision: "cfg-rollout-status",
        idempotencyKey: "rollout-status",
        deploymentEnvironment: "production",
        deploymentChoices: choices,
        rolloutConfigurationGeneration: 2,
      }),
    );
    expect(inserted).toMatchObject({ ok: true, inserted: true });

    const status = await readProductionRolloutStatus(connection, BASELINE_ENV);
    expect(status).toEqual({
      schemaVersion: "bruno.production-rollout.status.v1",
      current: {
        generation: 2,
        dispatchMode: "cron",
        recoveryMaxPublishAttempts: 12,
        imageMode: "stock",
        validationMode: "full",
        runnerSizeSlug: "s-2vcpu-2gb",
        credentialConfigurationValid: true,
        coldProvisioning: { enabled: false, reason: "rollout_exercise" },
      },
      activeDeployments: {
        count: 1,
        generationCounts: [{ generation: 2, count: 1 }],
        pinnedChoicesValid: true,
      },
    });
    expect(JSON.stringify(status)).not.toContain(USER_ID);
    expect(JSON.stringify(status)).not.toContain("secret-present");
  });
});
