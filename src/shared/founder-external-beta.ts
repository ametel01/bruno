export const FOUNDER_EXTERNAL_BETA_CAPABILITIES = [
  "openai",
  "anthropic",
  "calendar_reading",
  "gmail_reading",
  "gmail_sending",
] as const;

export type FounderExternalBetaCapability = (typeof FOUNDER_EXTERNAL_BETA_CAPABILITIES)[number];

export function founderExternalBetaCapabilityLabel(
  capability: FounderExternalBetaCapability,
): string {
  return {
    openai: "OpenAI",
    anthropic: "Anthropic",
    calendar_reading: "Calendar reading",
    gmail_reading: "Gmail reading",
    gmail_sending: "one-to-one Gmail sending",
  }[capability];
}
