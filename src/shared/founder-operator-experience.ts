import type { AuthModeDecision } from "@/src/auth/auth-mode";

export const FOUNDER_OPERATOR_LEGACY_COMPATIBILITY_EXPERIENCE = "legacy_compatibility" as const;

export type FounderOperatorExperience = "owner_preview" | "legacy_compatibility";

export function resolveFounderOperatorExperience(input: {
  authMode: AuthModeDecision["mode"];
  nodeEnvironment: string | undefined;
  requestedExperience: string | undefined;
}): FounderOperatorExperience {
  return input.authMode === "development" &&
    input.nodeEnvironment === "development" &&
    input.requestedExperience === FOUNDER_OPERATOR_LEGACY_COMPATIBILITY_EXPERIENCE
    ? FOUNDER_OPERATOR_LEGACY_COMPATIBILITY_EXPERIENCE
    : "owner_preview";
}
