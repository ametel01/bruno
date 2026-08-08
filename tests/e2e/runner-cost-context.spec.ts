import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const DEVELOPMENT_USER_E2E_LOCK_KEY = 125_226;
const DAY_MS = 24 * 60 * 60 * 1_000;

type RunnerCostFixture = {
  agentId: string;
  runnerId: string;
  userId: string;
};

test("assigned detail and cloud runner card show safe raw-compute estimates", async ({
  isMobile,
  page,
}) => {
  test.skip(isMobile, "focused runner-cost proof runs once on desktop");

  const fixture = await seedPricedCloudFixture();

  try {
    await withPinnedDevelopmentUser(fixture.userId, async () => {
      await page.goto(`/agents/${fixture.agentId}`);

      const assignedRunner = page.locator(".manual-runner-panel", {
        hasText: "Assigned runner",
      });
      await expect(assignedRunner).toContainText("Runner Cost Cloud");
      await expect(assignedRunner).toContainText("online");
      await expect(assignedRunner).toContainText("1 / 4 agents running");
      await expect(assignedRunner).toContainText("42%");
      await expect(assignedRunner).toContainText("Estimated monthly runner cost");
      await expect(assignedRunner).toContainText("$6.00 estimated");
      await expect(assignedRunner).toContainText("Estimated 30-day infrastructure cost");
      await expect(assignedRunner).toContainText("$3.00 estimated");
      await expect(assignedRunner).toContainText("Estimated 30-day cost per active agent");
      await expect(assignedRunner).toContainText("Running now");
      await expect(assignedRunner).toContainText("Active in window");
      await expect(assignedRunner).toContainText(
        "A plan can cost more because it may also include orchestration, monitoring, backups, support, and margin.",
      );
      await expect(assignedRunner).not.toContainText(fixture.runnerId);
      await expect(assignedRunner).not.toContainText("apiToken");
      await expect(assignedRunner).not.toContainText("must-not-render");

      await page.goto("/settings");

      const cloudRunnerCard = page.locator(".cloud-runner-item", {
        hasText: "Runner Cost Cloud",
      });
      await expect(cloudRunnerCard).toContainText("Runner heartbeat is online and ready for work.");
      await expect(cloudRunnerCard).toContainText("s-1vcpu-1gb");
      await expect(cloudRunnerCard).toContainText("Estimated monthly runner cost");
      await expect(cloudRunnerCard).toContainText("$6.00 estimated");
      await expect(cloudRunnerCard).toContainText("$3.00 estimated");
      await expect(cloudRunnerCard).toContainText("Running now");
      await expect(cloudRunnerCard).not.toContainText(fixture.runnerId);
      await expect(cloudRunnerCard).not.toContainText("must-not-render");
    });
  } finally {
    await deleteFixture(fixture);
  }
});

async function seedPricedCloudFixture(): Promise<RunnerCostFixture> {
  return withDatabase(async (sql) => {
    const now = new Date();
    const startedAt = new Date(now.getTime() - 15 * DAY_MS);
    const userId = randomUUID();
    const agentId = randomUUID();
    const runnerId = randomUUID();

    await sql`insert into users (id, created_at, updated_at) values (${userId}, ${now}, ${now})`;
    await sql`
      insert into runners (
        id,
        user_id,
        name,
        kind,
        endpoint_url,
        status,
        provider,
        provider_resource_id,
        region,
        size_slug,
        image,
        provisioning_status,
        provisioning_started_at,
        provisioning_completed_at,
        created_at,
        updated_at
      )
      values (
        ${runnerId},
        ${userId},
        'Runner Cost Cloud',
        'digitalocean',
        'https://runner-cost.example.com',
        'online',
        'digitalocean',
        'do-safe-226',
        'sgp1',
        's-1vcpu-1gb',
        'ubuntu-24-04-x64',
        'ready',
        ${startedAt},
        ${now},
        ${startedAt},
        ${now}
      )
    `;
    await sql`
      insert into agents (
        id,
        user_id,
        runner_id,
        name,
        template_key,
        status,
        created_at,
        updated_at
      )
      values (
        ${agentId},
        ${userId},
        ${runnerId},
        ${`Runner Cost Agent ${randomUUID().slice(0, 8)}`},
        'research_agent',
        'running',
        ${now},
        ${now}
      )
    `;
    await sql`
      insert into agent_configs (
        agent_id,
        system_prompt,
        model_provider,
        model_name,
        schedule_mode,
        timezone,
        created_at,
        updated_at
      )
      values (
        ${agentId},
        'Gather source notes safely.',
        'not_configured',
        'not_configured',
        'manual',
        'UTC',
        ${now},
        ${now}
      )
    `;
    await sql`
      insert into agent_usage_periods (agent_id, runner_id, source, started_at, created_at, updated_at)
      values (${agentId}, ${runnerId}, 'lifecycle', ${startedAt}, ${startedAt}, ${now})
    `;
    await sql`
      insert into runner_heartbeats (runner_id, status, metadata, observed_at, created_at)
      values (
        ${runnerId},
        'online',
        ${sql.json({
          version: "bruno-runner/e2e-cost",
          metrics: {
            maxAgents: 4,
            runningAgents: 1,
            cpuPercent: 42,
            memoryUsedMb: 512,
            memoryTotalMb: 2048,
            apiToken: "must-not-render",
          },
        })},
        ${now},
        ${now}
      )
    `;

    return { agentId, runnerId, userId };
  });
}

async function withPinnedDevelopmentUser<T>(userId: string, run: () => Promise<T>): Promise<T> {
  return withDatabase(async (sql) => {
    await sql`select pg_advisory_lock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;

    try {
      const [previous] = await sql<{ value: string }[]>`
        select value from app_metadata where key = 'local_development_user_id'
      `;
      await sql`
        insert into app_metadata (key, value)
        values ('local_development_user_id', ${userId})
        on conflict (key) do update
        set value = excluded.value, updated_at = now()
      `;

      try {
        return await run();
      } finally {
        if (previous) {
          await sql`
            update app_metadata
            set value = ${previous.value}, updated_at = now()
            where key = 'local_development_user_id'
          `;
        } else {
          await sql`delete from app_metadata where key = 'local_development_user_id'`;
        }
      }
    } finally {
      await sql`select pg_advisory_unlock(${DEVELOPMENT_USER_E2E_LOCK_KEY})`;
    }
  });
}

async function deleteFixture(fixture: RunnerCostFixture): Promise<void> {
  await withDatabase(async (sql) => {
    await sql`delete from agent_usage_periods where agent_id = ${fixture.agentId}`;
    await sql`delete from backups where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_approvals where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_logs where agent_id = ${fixture.agentId}`;
    await sql`delete from docker_runner_containers where agent_id = ${fixture.agentId}`;
    await sql`delete from local_runner_processes where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_events where agent_id = ${fixture.agentId}`;
    await sql`delete from agent_configs where agent_id = ${fixture.agentId}`;
    await sql`delete from agents where id = ${fixture.agentId}`;
    await sql`delete from runner_provisioning_events where runner_id = ${fixture.runnerId}`;
    await sql`delete from runner_heartbeats where runner_id = ${fixture.runnerId}`;
    await sql`delete from runner_credentials where runner_id = ${fixture.runnerId}`;
    await sql`delete from runners where id = ${fixture.runnerId}`;
    await sql`delete from users where id = ${fixture.userId}`;
  });
}

async function withDatabase<T>(run: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL ?? "postgres://bruno:bruno@127.0.0.1:54329/bruno";
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
  });

  try {
    return await run(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
