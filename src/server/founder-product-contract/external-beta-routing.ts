import "server-only";

import type { FounderExternalBetaManifest } from "./external-beta-manifest";
import {
  type FounderAiProvider,
  type FounderAiRoutingCandidate,
  type FounderAiRoutingDecision,
  type FounderAiRoutingOptions,
  selectFounderAiProvider,
  selectFounderAiProviderAtCheckpoint,
} from "@/src/server/operators/founder-ai-routing";

export function selectFounderExternalBetaAiProvider(
  candidates: readonly FounderAiRoutingCandidate[],
  authority: { admitted: boolean; manifest: FounderExternalBetaManifest },
  options: Omit<FounderAiRoutingOptions, "allowedProviders"> = {},
): FounderAiRoutingDecision | null {
  if (!authority.admitted) return null;
  return selectFounderAiProvider(candidates, {
    ...options,
    allowedProviders: qualifiedAiProviders(authority.manifest),
  });
}

export function selectFounderExternalBetaAiProviderAtCheckpoint(
  candidates: readonly FounderAiRoutingCandidate[],
  failedProvider: FounderAiProvider,
  authority: { admitted: boolean; manifest: FounderExternalBetaManifest },
  options: Omit<FounderAiRoutingOptions, "allowedProviders" | "excludedProviders"> = {},
): FounderAiRoutingDecision | null {
  if (!authority.admitted) return null;
  const qualifiedProviders = qualifiedAiProviders(authority.manifest);
  return selectFounderAiProviderAtCheckpoint(candidates, failedProvider, {
    ...options,
    allowedProviders: qualifiedProviders,
  });
}

function qualifiedAiProviders(manifest: FounderExternalBetaManifest): readonly FounderAiProvider[] {
  return [
    ...(manifest.qualifiedCapabilities.includes("openai") ? (["openai"] as const) : []),
    ...(manifest.qualifiedCapabilities.includes("anthropic") ? (["anthropic"] as const) : []),
  ];
}
