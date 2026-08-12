import { describe, expect, it } from "vitest";
import { matchesProviderTrialGateEvidence } from "@/src/server/agents/provider-trial-operator-config";

const identities = {
  digitalOceanAccount: `sha256:${"1".repeat(64)}`,
  telegramBot: `sha256:${"2".repeat(64)}`,
  telegramChat: `sha256:${"3".repeat(64)}`,
  telegramUser: `sha256:${"4".repeat(64)}`,
};

describe("Provider Trial gate evidence binding", () => {
  it("accepts a new signed gate digest only for an explicitly renewed authorization", () => {
    const configuration = {
      prerequisiteGateEvidenceDigest: `sha256:${"a".repeat(64)}`,
      digitalOceanAccountIdentityHash: identities.digitalOceanAccount,
      telegramBotIdentityHash: identities.telegramBot,
      telegramChatIdentityHash: identities.telegramChat,
      telegramUserIdentityHash: identities.telegramUser,
    };
    const renewedEvidence = {
      digest: `sha256:${"b".repeat(64)}`,
      identities,
    };

    expect(matchesProviderTrialGateEvidence(configuration, renewedEvidence, "exact")).toBe(false);
    expect(
      matchesProviderTrialGateEvidence(configuration, renewedEvidence, "renewed_authorization"),
    ).toBe(true);
  });

  it("never accepts renewed evidence for different authorized identities", () => {
    const configuration = {
      prerequisiteGateEvidenceDigest: `sha256:${"a".repeat(64)}`,
      digitalOceanAccountIdentityHash: identities.digitalOceanAccount,
      telegramBotIdentityHash: identities.telegramBot,
      telegramChatIdentityHash: identities.telegramChat,
      telegramUserIdentityHash: identities.telegramUser,
    };

    expect(
      matchesProviderTrialGateEvidence(
        configuration,
        {
          digest: `sha256:${"b".repeat(64)}`,
          identities: { ...identities, digitalOceanAccount: `sha256:${"9".repeat(64)}` },
        },
        "renewed_authorization",
      ),
    ).toBe(false);
  });
});
