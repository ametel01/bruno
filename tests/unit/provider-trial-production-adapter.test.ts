import { describe, expect, it } from "vitest";
import {
  createProviderTrialProductionDriverDependencies,
  waitForProviderTrialOwnedSetState,
  toProviderTrialAbsenceDiscoveryTag,
  toProviderTrialOwnedSetExpectation,
} from "@/src/server/agents/provider-trial-production-adapter";
import type { DigitalOceanOwnedSetProvider } from "@/src/server/runners/digitalocean-provider";

const ATTEMPT = {
  cohortId: "00000000-0000-4000-8000-000000002991",
  slotId: "00000000-0000-4000-8000-000000002992",
  slotNumber: 1,
  requestAttemptId: "00000000-0000-4000-8000-000000002993",
  requestStartedAt: "2026-08-11T12:00:00.000Z",
};

describe("DigitalOcean Provider Trial production adapter", () => {
  it("polls bounded provider convergence after a successful deletion", async () => {
    let observations = 0;
    const waits: number[] = [];
    const provider = {
      async observeOwnedSet() {
        observations += 1;
        return {
          ok: true as const,
          value:
            observations < 3
              ? {
                  state: "owned" as const,
                  droplet: "present" as const,
                  firewall: "absent" as const,
                }
              : {
                  state: "absent" as const,
                  droplet: "absent" as const,
                  firewall: "absent" as const,
                },
        };
      },
    } as Pick<DigitalOceanOwnedSetProvider, "observeOwnedSet">;

    await expect(
      waitForProviderTrialOwnedSetState({
        provider,
        expectation: {
          operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
          providerResourceId: "592041488",
          providerFirewallId: "2a18501d-ad3c-45b3-989e-8203bd165797",
          expectedName: "bruno-deploy-05d73ff0d570484087452896791ab651",
          expectedRegion: "sfo3",
          expectedSizeSlug: "s-1vcpu-2gb",
          expectedFirewallName: "bruno-runners-592041488",
        },
        signal: new AbortController().signal,
        matches: (value) => value.state === "absent",
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
      }),
    ).resolves.toBe(true);
    expect(observations).toBe(3);
    expect(waits).toEqual([1_000, 1_000]);
  });

  it("fails closed when provider convergence remains unproven", async () => {
    let observations = 0;
    const provider = {
      async observeOwnedSet() {
        observations += 1;
        return {
          ok: true as const,
          value: {
            state: "owned" as const,
            droplet: "present" as const,
            firewall: "absent" as const,
          },
        };
      },
    } as Pick<DigitalOceanOwnedSetProvider, "observeOwnedSet">;

    await expect(
      waitForProviderTrialOwnedSetState({
        provider,
        expectation: {
          operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
          providerResourceId: "592041488",
          providerFirewallId: "2a18501d-ad3c-45b3-989e-8203bd165797",
          expectedName: "bruno-deploy-05d73ff0d570484087452896791ab651",
          expectedRegion: "sfo3",
          expectedSizeSlug: "s-1vcpu-2gb",
          expectedFirewallName: "bruno-runners-592041488",
        },
        signal: new AbortController().signal,
        matches: (value) => value.state === "absent",
        attempts: 3,
        wait: async () => undefined,
      }),
    ).resolves.toBe(false);
    expect(observations).toBe(3);
  });

  it("permits authoritative tag discovery for a terminal pre-provider failure", () => {
    expect(
      toProviderTrialAbsenceDiscoveryTag({
        slotNumber: 1,
        origin: "operator_trial",
        userId: "00000000-0000-4000-8000-000000002994",
        agentId: "00000000-0000-4000-8000-000000002995",
        agentDeletedAt: null,
        deploymentErrorCode: "runner_provisioning_unavailable",
        runnerId: "00000000-0000-4000-8000-000000002996",
        runnerName: "Bruno Deployment Runner",
        runnerKind: "digitalocean",
        runnerProvider: "digitalocean",
        runnerRegion: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        runnerProvisioningStatus: "failed",
        provisioningCleanupRequired: false,
        operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
        providerResourceId: null,
        providerFirewallId: null,
      }),
    ).toBe("bruno-deploy-05d73ff0d570484087452896791ab651");
  });

  it("rejects absence discovery when provider cleanup might be required", () => {
    expect(
      toProviderTrialAbsenceDiscoveryTag({
        slotNumber: 1,
        origin: "operator_trial",
        userId: "00000000-0000-4000-8000-000000002994",
        agentId: "00000000-0000-4000-8000-000000002995",
        agentDeletedAt: null,
        deploymentErrorCode: "runner_provisioning_unavailable",
        runnerId: "00000000-0000-4000-8000-000000002996",
        runnerName: "Bruno Deployment Runner",
        runnerKind: "digitalocean",
        runnerProvider: "digitalocean",
        runnerRegion: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        runnerProvisioningStatus: "failed",
        provisioningCleanupRequired: true,
        operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
        providerResourceId: null,
        providerFirewallId: null,
      }),
    ).toBeNull();
  });

  it("re-verifies provider absence for a previously cleaned runner", () => {
    expect(
      toProviderTrialAbsenceDiscoveryTag({
        slotNumber: 1,
        origin: "operator_trial",
        userId: "00000000-0000-4000-8000-000000002994",
        agentId: "00000000-0000-4000-8000-000000002995",
        agentDeletedAt: new Date("2026-08-11T12:01:00.000Z"),
        deploymentErrorCode: "runner_provisioning_unavailable",
        runnerId: "00000000-0000-4000-8000-000000002996",
        runnerName: "Bruno Deployment Runner",
        runnerKind: "digitalocean",
        runnerProvider: "digitalocean",
        runnerRegion: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        runnerProvisioningStatus: "deleted",
        provisioningCleanupRequired: false,
        operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
        providerResourceId: null,
        providerFirewallId: null,
      }),
    ).toBe("bruno-deploy-05d73ff0d570484087452896791ab651");
  });

  it("binds cleanup ownership to the provider operation name instead of the runner label", () => {
    expect(
      toProviderTrialOwnedSetExpectation({
        slotNumber: 1,
        origin: "operator_trial",
        userId: "00000000-0000-4000-8000-000000002994",
        agentId: "00000000-0000-4000-8000-000000002995",
        agentDeletedAt: null,
        deploymentErrorCode: null,
        runnerId: "00000000-0000-4000-8000-000000002996",
        runnerName: "Bruno Deployment Runner",
        runnerKind: "digitalocean",
        runnerProvider: "digitalocean",
        runnerRegion: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        runnerProvisioningStatus: "ready",
        provisioningCleanupRequired: null,
        operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
        providerResourceId: "592041488",
        providerFirewallId: "2a18501d-ad3c-45b3-989e-8203bd165797",
      }),
    ).toEqual({
      operationTag: "bruno-deploy-05d73ff0d570484087452896791ab651",
      providerResourceId: "592041488",
      providerFirewallId: "2a18501d-ad3c-45b3-989e-8203bd165797",
      expectedName: "bruno-deploy-05d73ff0d570484087452896791ab651",
      expectedRegion: "sfo3",
      expectedSizeSlug: "s-1vcpu-2gb",
      expectedFirewallName: "bruno-runners-592041488",
    });
  });

  it("commits through the existing driver port with operator-trial identity and reserved cost", async () => {
    const dependencies = createProviderTrialProductionDriverDependencies({
      ownerUserId: "00000000-0000-4000-8000-000000002994",
      fixture: {
        assistant: "chatgpt",
        modelApiKey: `sk-${"a".repeat(24)}`,
        telegramBotToken: `123456:${"b".repeat(20)}`,
        telegramUserId: "123456",
      },
      async createReadyDeployment(input) {
        if (
          input.identity.origin !== "operator_trial" ||
          input.identity.environment !== "non_production" ||
          input.idempotencyKey !== "provider-trial:00000000-0000-4000-8000-000000002993"
        ) {
          return { state: "rejected" };
        }
        return {
          state: "committed",
          deploymentId: "00000000-0000-4000-8000-000000002995",
          activeProviderResources: 1,
        };
      },
    });
    const result = await dependencies.executeSlot(ATTEMPT, {
      idempotencyKey: "provider-trial:00000000-0000-4000-8000-000000002993",
      signal: new AbortController().signal,
      deadlineAt: "2026-08-11T12:15:00.000Z",
      timeoutMs: 900_000,
      maxCostCents: 16,
      maxProviderResources: 1,
      authorizationScope: {
        cohortId: ATTEMPT.cohortId,
        region: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        deploymentChoicesDigest: `sha256:${"c".repeat(64)}`,
        benchmarkOwnerIdentityHash: `sha256:${"d".repeat(64)}`,
        benchmarkTelegramIdentityHash: `sha256:${"e".repeat(64)}`,
      },
    });

    expect(result).toEqual({
      outcome: "committed",
      deploymentId: "00000000-0000-4000-8000-000000002995",
      costCents: 16,
      activeProviderResources: 1,
    });
  });

  it("reconciles the original request, observes its terminal deployment, and cleans the exact cohort", async () => {
    const dependencies = createProviderTrialProductionDriverDependencies({
      ownerUserId: "00000000-0000-4000-8000-000000002994",
      fixture: {
        assistant: "chatgpt",
        modelApiKey: `sk-${"a".repeat(24)}`,
        telegramBotToken: `123456:${"b".repeat(20)}`,
        telegramUserId: "123456",
      },
      async createReadyDeployment() {
        return { state: "rejected" };
      },
      async findDeployment(input) {
        return input.idempotencyKey.endsWith(ATTEMPT.requestAttemptId)
          ? {
              state: "found",
              deploymentId: "00000000-0000-4000-8000-000000002995",
              activeProviderResources: 1,
            }
          : { state: "conflict" };
      },
      async observeDeployment(input) {
        return input.deploymentId === "00000000-0000-4000-8000-000000002995"
          ? { state: "ready" }
          : { state: "conflict" };
      },
      async cleanupCohort(input) {
        return input.cohortId === ATTEMPT.cohortId
          ? { ok: true, authoritative: true, remainingResourceIds: [] }
          : { ok: false, authoritative: true, remainingResourceIds: ["cohort-mismatch"] };
      },
      now: () => new Date("2026-08-11T12:00:01.000Z"),
    });
    const context = {
      idempotencyKey: "provider-trial:00000000-0000-4000-8000-000000002993",
      signal: new AbortController().signal,
      deadlineAt: "2026-08-11T12:15:00.000Z",
      timeoutMs: 900_000,
      maxCostCents: 16,
      maxProviderResources: 1,
      authorizationScope: {
        cohortId: ATTEMPT.cohortId,
        region: "sfo3",
        runnerSizeSlug: "s-1vcpu-2gb",
        deploymentChoicesDigest: `sha256:${"c".repeat(64)}`,
        benchmarkOwnerIdentityHash: `sha256:${"d".repeat(64)}`,
        benchmarkTelegramIdentityHash: `sha256:${"e".repeat(64)}`,
      },
    } as const;

    await expect(dependencies.reconcileRequest?.(ATTEMPT, context)).resolves.toEqual({
      outcome: "committed",
      deploymentId: "00000000-0000-4000-8000-000000002995",
      costCents: 16,
      activeProviderResources: 1,
    });
    await expect(
      dependencies.observeCommittedSlot?.(ATTEMPT, {
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        timeoutMs: context.timeoutMs,
      }),
    ).resolves.toBe("observe_deployment");
    await expect(
      dependencies.cleanup?.({
        cohortId: ATTEMPT.cohortId,
        signal: context.signal,
        deadlineAt: "2026-08-11T12:20:00.000Z",
        timeoutMs: 300_000,
      }),
    ).resolves.toEqual({ ok: true, authoritative: true, remainingResourceIds: [] });
  });
});
