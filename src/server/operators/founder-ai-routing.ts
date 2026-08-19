import "server-only";

import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { operatorAiConnections } from "@/src/server/db/schema";

type FounderAiRoutingTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_AI_PROVIDERS = ["openai", "anthropic"] as const;
export type FounderAiProvider = (typeof FOUNDER_AI_PROVIDERS)[number];

export const FOUNDER_AI_PROVIDER_STALE_AFTER_MS = 15 * 60 * 1000;

export type FounderAiCompatibilityPolicy = {
  version: number;
  providers: Readonly<
    Record<
      FounderAiProvider,
      {
        released: boolean;
        priority: number;
        defaultModelAssignment: string;
        approvedModelAssignments: readonly string[];
      }
    >
  >;
};

/**
 * This is deliberately a server-owned release policy. A connected account can
 * become eligible only when its provider is present here and its assignment is
 * one of the approved assignments for that provider.
 */
export const ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY: FounderAiCompatibilityPolicy = {
  version: 1,
  providers: {
    openai: {
      released: true,
      priority: 10,
      defaultModelAssignment: "openai-codex",
      approvedModelAssignments: ["openai-codex"],
    },
    anthropic: {
      // Anthropic becomes routable only when its gated connection release is
      // enabled by a later compatibility policy (currently #353).
      released: false,
      priority: 20,
      defaultModelAssignment: "anthropic-claude",
      approvedModelAssignments: ["anthropic-claude", "claude-sonnet-4-6", "claude-3-7-sonnet"],
    },
  },
};

export type FounderAiRoutingCandidate = {
  id: string;
  provider: string;
  providerSubjectId: string | null;
  accountLabel: string | null;
  status: string;
  authorizationState: string;
  capacityState: string;
  inferenceState: string;
  eligibleAccount: boolean;
  authorizationPersisted: boolean;
  approvedModelAssignment: string | null;
  authorizationGeneration: number;
  lastVerifiedAt: Date | null;
  revokedAt: Date | null;
  disconnectedAt: Date | null;
  updatedAt: Date;
};

export type FounderAiRoutingDecision = {
  connectionId: string;
  provider: FounderAiProvider;
  providerSubjectId: string;
  accountLabel: string;
  approvedModelAssignment: string;
  authorizationGeneration: number;
  policyVersion: number;
};

export type FounderAiRoutingOptions = {
  now?: Date;
  excludedProviders?: readonly FounderAiProvider[];
  policy?: FounderAiCompatibilityPolicy;
  staleAfterMs?: number;
};

export function selectFounderAiProvider(
  candidates: readonly FounderAiRoutingCandidate[],
  options: FounderAiRoutingOptions = {},
): FounderAiRoutingDecision | null {
  const now = options.now ?? new Date();
  const policy = options.policy ?? ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY;
  const excluded = new Set(options.excludedProviders ?? []);
  const staleAfterMs = options.staleAfterMs ?? FOUNDER_AI_PROVIDER_STALE_AFTER_MS;

  const selected = candidates
    .filter(
      (candidate): candidate is FounderAiRoutingCandidate & { provider: FounderAiProvider } =>
        isEligibleFounderAiConnection(candidate, { ...options, now, policy, staleAfterMs }) &&
        !excluded.has(candidate.provider as FounderAiProvider),
    )
    .sort((left, right) => {
      const leftPolicy = policy.providers[left.provider as FounderAiProvider];
      const rightPolicy = policy.providers[right.provider as FounderAiProvider];
      const priority =
        (leftPolicy?.priority ?? Number.MAX_SAFE_INTEGER) -
        (rightPolicy?.priority ?? Number.MAX_SAFE_INTEGER);
      if (priority !== 0) return priority;
      const updated = right.updatedAt.getTime() - left.updatedAt.getTime();
      if (updated !== 0) return updated;
      return left.id.localeCompare(right.id);
    })[0];

  if (!selected) return null;
  return {
    connectionId: selected.id,
    provider: selected.provider as FounderAiProvider,
    providerSubjectId: selected.providerSubjectId as string,
    accountLabel: selected.accountLabel as string,
    approvedModelAssignment:
      policy.providers[selected.provider as FounderAiProvider].defaultModelAssignment,
    authorizationGeneration: selected.authorizationGeneration,
    policyVersion: policy.version,
  };
}

/**
 * Provider changes are an explicit checkpoint decision. Callers must invoke
 * this only after the current work has been durably paused; it never retries a
 * provider speculatively while a work unit is still in flight.
 */
export function selectFounderAiProviderAtCheckpoint(
  candidates: readonly FounderAiRoutingCandidate[],
  failedProvider: FounderAiProvider,
  options: Omit<FounderAiRoutingOptions, "excludedProviders"> = {},
): FounderAiRoutingDecision | null {
  return selectFounderAiProvider(candidates, {
    ...options,
    excludedProviders: [failedProvider],
  });
}

export function isEligibleFounderAiConnection(
  candidate: FounderAiRoutingCandidate,
  options: Pick<FounderAiRoutingOptions, "now" | "policy" | "staleAfterMs"> = {},
): boolean {
  const policy = options.policy ?? ACTIVE_FOUNDER_AI_COMPATIBILITY_POLICY;
  const provider = candidate.provider as FounderAiProvider;
  const providerPolicy = policy.providers[provider];
  if (!providerPolicy?.released) return false;
  if (candidate.status !== "ready") return false;
  if (candidate.authorizationState !== "authorized") return false;
  if (candidate.capacityState !== "available" || candidate.inferenceState !== "passed")
    return false;
  if (!candidate.eligibleAccount || !candidate.authorizationPersisted) return false;
  if (candidate.revokedAt || candidate.disconnectedAt) return false;
  if (!candidate.providerSubjectId || !candidate.accountLabel) return false;
  if (
    !candidate.approvedModelAssignment ||
    !providerPolicy.approvedModelAssignments.includes(candidate.approvedModelAssignment)
  ) {
    return false;
  }
  const lastVerifiedAt = candidate.lastVerifiedAt;
  if (!lastVerifiedAt) return false;
  const staleAfterMs = options.staleAfterMs ?? FOUNDER_AI_PROVIDER_STALE_AFTER_MS;
  const now = options.now ?? new Date();
  return now.getTime() - lastVerifiedAt.getTime() <= staleAfterMs;
}

export async function routeFounderAiProvider(
  tx: FounderAiRoutingTransaction,
  operatorId: string,
  options: FounderAiRoutingOptions = {},
): Promise<FounderAiRoutingDecision | null> {
  const connections = await tx
    .select()
    .from(operatorAiConnections)
    .where(eq(operatorAiConnections.operatorId, operatorId))
    .orderBy(desc(operatorAiConnections.updatedAt), desc(operatorAiConnections.id));
  return selectFounderAiProvider(connections, options);
}
