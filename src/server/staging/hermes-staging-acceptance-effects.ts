import "server-only";

import type {
  HermesStagingAcceptanceEffectKind,
  HermesStagingAcceptanceEffectResult,
} from "@/src/server/staging/hermes-staging-acceptance-state";
import type { HermesStagingAcceptanceEvidenceMutation } from "@/src/server/staging/hermes-staging-acceptance-store";
import type { HermesStagingAttestationChallenge } from "@/src/shared/hermes-staging-attestation-protocol";

export type HermesStagingAcceptanceHumanChallenge = HermesStagingAttestationChallenge;

/**
 * The deliberately narrow, internal context available to a single staging
 * acceptance effect. It contains durable correlation identifiers, never raw
 * credentials or provider response bodies.
 */
export type HermesStagingAcceptanceEffectContext = {
  runId: string;
  ownerUserId: string;
  idempotencyKey: string;
  generation: number;
  attemptCount: number;
  deploymentStageIndex: number;
  expectedSourceRevision: string;
  expectedPublishWorkflowRunId: string;
  expectedImageDigest: string;
  observedImageDigest: string | null;
  agentId: string | null;
  deploymentId: string | null;
  runnerId: string | null;
  providerResourceId: string | null;
  providerFirewallId: string | null;
  restartRequestedAt: Date | null;
  challenge: HermesStagingAcceptanceHumanChallenge | null;
};

export type HermesStagingAcceptanceEffectExecution = {
  result: HermesStagingAcceptanceEffectResult;
  evidence?: HermesStagingAcceptanceEvidenceMutation;
};

export type HermesStagingAcceptanceEffectExecutor = {
  execute(
    effect: HermesStagingAcceptanceEffectKind,
    context: HermesStagingAcceptanceEffectContext,
    signal: AbortSignal,
  ): Promise<HermesStagingAcceptanceEffectExecution>;
};
