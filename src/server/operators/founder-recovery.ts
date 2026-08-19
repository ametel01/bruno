/**
 * Founder-facing recovery is deliberately derived from durable application state.
 * Browser polling may refresh this projection, but it cannot create an exhausted
 * recovery state by itself.
 */

export const FOUNDER_RECOVERY_CAPABILITIES = [
  "ai",
  "calendar",
  "mail",
  "mail_sending",
  "brief",
  "conversation",
  "external_effect",
] as const;

export type FounderRecoveryCapability = (typeof FOUNDER_RECOVERY_CAPABILITIES)[number];

export const FOUNDER_INTERRUPTION_STATES = [
  "recovering",
  "waiting_on_provider",
  "needs_you",
  "outcome_uncertain",
  "recovery_exhausted",
] as const;

export type FounderInterruptionState = (typeof FOUNDER_INTERRUPTION_STATES)[number];

export type FounderRecoveryAction = {
  label: string;
  href: string | null;
};

export type FounderRecoveryDto = {
  capability: FounderRecoveryCapability;
  state: FounderInterruptionState;
  attemptCount: number;
  maxAttempts: number;
  elapsedMs: number;
  maxElapsedMs: number;
  startedAt: string | null;
  nextAttemptAt: string | null;
  message: string | null;
  /** Needs you has exactly one action. Every other state has no action. */
  action: FounderRecoveryAction | null;
};

export type FounderRecoveryBudget = {
  maxAttempts: number;
  maxElapsedMs: number;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Explicit, capability-specific safety budgets. */
export const FOUNDER_RECOVERY_BUDGETS: Readonly<
  Record<FounderRecoveryCapability, FounderRecoveryBudget>
> = {
  ai: { maxAttempts: 3, maxElapsedMs: 15 * MINUTE_MS },
  calendar: { maxAttempts: 3, maxElapsedMs: 20 * MINUTE_MS },
  mail: { maxAttempts: 3, maxElapsedMs: 20 * MINUTE_MS },
  mail_sending: { maxAttempts: 2, maxElapsedMs: 15 * MINUTE_MS },
  brief: { maxAttempts: 2, maxElapsedMs: 15 * MINUTE_MS },
  conversation: { maxAttempts: 3, maxElapsedMs: 15 * MINUTE_MS },
  external_effect: { maxAttempts: 1, maxElapsedMs: HOUR_MS },
};

export type FounderRecoveryDerivationInput = {
  capability: FounderRecoveryCapability;
  now?: Date;
  startedAt?: Date | string | null;
  nextAttemptAt?: Date | string | null;
  attemptCount?: number;
  /** True only when the source row records a durable failure or work unit. */
  durableFailure?: boolean;
  waitingOnProvider?: boolean;
  needsFounder?: boolean;
  outcomeUncertain?: boolean;
  /** Safe automatic retry remains available when true. */
  safeToRetry?: boolean;
  message?: string | null;
  action?: FounderRecoveryAction | null;
};

const DEFAULT_ACTIONS: Readonly<Record<FounderRecoveryCapability, FounderRecoveryAction>> = {
  ai: { label: "Reconnect AI", href: "/operator#connections" },
  calendar: { label: "Review Calendar access", href: "/operator#calendar" },
  mail: { label: "Review Mail access", href: "/operator#mail" },
  mail_sending: { label: "Review Mail Sending", href: "/operator#mail-sending" },
  brief: { label: "Review connections", href: "/operator#connections" },
  conversation: { label: "Resume from checkpoint", href: null },
  external_effect: { label: "Review Action Inbox", href: "/operator#action-inbox" },
};

export function founderRecoveryLabel(state: FounderInterruptionState): string {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function deriveFounderRecovery(
  input: FounderRecoveryDerivationInput,
): FounderRecoveryDto | null {
  const budget = FOUNDER_RECOVERY_BUDGETS[input.capability];
  const now = input.now ?? new Date();
  const startedAt = parseDate(input.startedAt);
  const nextAttemptAt = parseDate(input.nextAttemptAt);
  const attemptCount = Math.max(0, Math.trunc(input.attemptCount ?? 0));
  const elapsedMs = startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : 0;
  const durableFailure = input.durableFailure === true;

  if (!durableFailure && !input.waitingOnProvider && !input.outcomeUncertain && !input.needsFounder)
    return null;

  let state: FounderInterruptionState;
  if (input.outcomeUncertain) {
    state = "outcome_uncertain";
  } else if (input.waitingOnProvider && input.safeToRetry === false) {
    // An in-flight external effect remains provider-owned until its durable
    // lease/reconciliation path records an outcome; never turn it into a retry.
    state = "waiting_on_provider";
  } else if (
    durableFailure &&
    (attemptCount >= budget.maxAttempts || elapsedMs >= budget.maxElapsedMs)
  ) {
    state = "recovery_exhausted";
  } else if (input.waitingOnProvider) {
    state = "waiting_on_provider";
  } else if (input.needsFounder) {
    state = "needs_you";
  } else if (input.safeToRetry !== false) {
    state = "recovering";
  } else {
    state = "needs_you";
  }

  return {
    capability: input.capability,
    state,
    attemptCount,
    maxAttempts: budget.maxAttempts,
    elapsedMs,
    maxElapsedMs: budget.maxElapsedMs,
    startedAt: startedAt?.toISOString() ?? null,
    nextAttemptAt: nextAttemptAt?.toISOString() ?? null,
    message: input.message ?? null,
    action: state === "needs_you" ? (input.action ?? DEFAULT_ACTIONS[input.capability]) : null,
  };
}

/**
 * Shared projection for connection-like durable rows. Status names stay local
 * to each capability while Founder presentation remains one vocabulary.
 */
export function deriveFounderConnectionRecovery(input: {
  capability: Extract<FounderRecoveryCapability, "ai" | "calendar" | "mail" | "mail_sending">;
  status: string;
  evidenceState?: string | null;
  failureCode?: string | null;
  recoveryMessage?: string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  now?: Date;
  attemptCount?: number;
}): FounderRecoveryDto | null {
  const failureCode = input.failureCode?.trim() || null;
  const message = input.recoveryMessage?.trim() || null;
  const providerWait =
    input.status === "verifying" ||
    input.failureCode === "capacity_unavailable" ||
    input.failureCode === "provider_unavailable" ||
    input.evidenceState === "unavailable";
  const founderAction = ["authorizing", "selecting", "needs_attention", "disconnected"].includes(
    input.status,
  );
  const durableFailure = Boolean(failureCode || message || providerWait);
  // A connection's recovery window begins at its durable failure update, not
  // at the age of the account record itself.
  const startedAt = input.updatedAt ?? input.createdAt ?? null;
  return deriveFounderRecovery({
    capability: input.capability,
    now: input.now ?? parseDate(input.updatedAt) ?? new Date(),
    startedAt,
    attemptCount: input.attemptCount ?? (durableFailure ? 1 : 0),
    durableFailure,
    waitingOnProvider: providerWait && !founderAction,
    needsFounder: founderAction,
    safeToRetry: !input.failureCode?.includes("uncertain"),
    message,
  });
}

export function deriveFounderConversationRecovery(input: {
  state: "running" | "completed" | "paused" | "failed";
  externalEffectStarted: boolean;
  startedAt?: Date | string | null;
  attemptCount?: number;
  recoveryMessage?: string | null;
  now?: Date;
}): FounderRecoveryDto | null {
  const interrupted = input.state === "paused" || input.state === "failed";
  if (!interrupted && !input.externalEffectStarted) return null;
  return deriveFounderRecovery({
    capability: "conversation",
    ...(input.now ? { now: input.now } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    attemptCount: Math.max(input.attemptCount ?? 0, interrupted ? 1 : 0),
    durableFailure: input.state === "paused" || input.state === "failed",
    outcomeUncertain: interrupted && input.externalEffectStarted,
    needsFounder: interrupted && !input.externalEffectStarted,
    safeToRetry: !input.externalEffectStarted,
    message: input.recoveryMessage ?? null,
    action: { label: "Resume from checkpoint", href: null },
  });
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
