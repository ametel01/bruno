import { describe, expect, it } from "vitest";
import {
  parseAgentLaunchSpec,
  parseAgentLaunchSpecJson,
  redactAgentLaunchSpec,
  serializeAgentLaunchSpec,
  serializeRedactedAgentLaunchSpec,
} from "@/src/server/agents/agent-launch-spec";
import {
  sampleDirectManagedLaunchSpec,
  sampleLaunchSpec,
  sampleManagedLaunchSpec,
} from "@/tests/helpers/agent-launch-spec";

describe("AgentLaunchSpec", () => {
  it("accepts the versioned Hermes launch contract and redacts inline secrets", () => {
    const spec = sampleLaunchSpec();
    const parsed = parseAgentLaunchSpec(spec);

    expect(parsed).toEqual({ ok: true, spec });
    expect(redactAgentLaunchSpec(spec)).toMatchObject({
      secrets: {
        apiServerKey: "[secret]",
      },
    });
    expect(JSON.stringify(redactAgentLaunchSpec(spec))).not.toContain(spec.secrets.apiServerKey);
  });

  it("rejects stale versions, unknown fields, legacy secret fields, and oversized JSON", () => {
    const stale = {
      ...sampleLaunchSpec(),
      version: "agentbay.hermes.launch.v0",
      unexpected: true,
      secrets: {
        ...sampleLaunchSpec().secrets,
        openrouterApiKey: "legacy-secret",
      },
    };
    const parsed = parseAgentLaunchSpec(stale);

    expect(parsed.ok).toBe(false);
    expect(parsed).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ path: "$.version" }),
        expect.objectContaining({ path: "$.unexpected" }),
        expect.objectContaining({ path: "$.secrets.openrouterApiKey" }),
      ]),
    });

    expect(parseAgentLaunchSpecJson("{")).toMatchObject({ ok: false });
    expect(parseAgentLaunchSpecJson(JSON.stringify({ value: "x".repeat(70 * 1024) }))).toEqual({
      ok: false,
      issues: [{ path: "$", message: "Launch spec body is too large." }],
    });
  });

  it("accepts exact managed v3 and redacts all credentials and Telegram IDs", () => {
    const spec = sampleManagedLaunchSpec();
    const parsed = parseAgentLaunchSpec(spec);

    expect(parsed).toEqual({ ok: true, spec });
    expect(JSON.parse(serializeAgentLaunchSpec(spec))).toMatchObject({
      version: "agentbay.hermes.launch.v3",
      platforms: {
        required: ["api_server", "telegram"],
      },
      secrets: {
        telegramAllowedUsers: ["1", "222222"],
      },
    });

    const redacted = serializeRedactedAgentLaunchSpec(spec);

    expect(redacted).toContain('"telegramAllowedUsers":["[secret]"]');
    expect(redactAgentLaunchSpec(spec).secrets.telegramAllowedUsers).toEqual(["[secret]"]);
    for (const canary of [
      spec.secrets.openrouterApiKey,
      spec.secrets.telegramBotToken,
      spec.secrets.apiServerKey,
    ]) {
      expect(redacted).not.toContain(canary);
      expect(JSON.stringify(redactAgentLaunchSpec(spec))).not.toContain(canary);
    }
  });

  it.each([
    "openai-api",
    "anthropic",
  ] as const)("accepts and redacts direct %s managed credentials", (provider) => {
    const spec = sampleDirectManagedLaunchSpec(provider);
    const parsed = parseAgentLaunchSpec(spec);

    expect(parsed).toEqual({ ok: true, spec });
    const serialized = serializeAgentLaunchSpec(spec);
    const redacted = serializeRedactedAgentLaunchSpec(spec);

    expect(serialized).toContain(`"provider":"${provider}"`);
    expect(serialized).toContain('"modelApiKey"');
    expect(serialized).not.toContain("openrouterApiKey");
    expect(redacted).not.toContain(spec.secrets.modelApiKey);
    expect(redacted).toContain('"modelApiKey":"[secret]"');
  });

  it("rejects provider/key mismatches and legacy OpenRouter fields on direct providers", () => {
    const direct = sampleDirectManagedLaunchSpec("anthropic");
    const wrongKey = {
      ...direct,
      secrets: { ...direct.secrets, modelApiKey: `sk-${"a".repeat(32)}` },
    };
    const legacyField = {
      ...direct,
      secrets: { ...direct.secrets, openrouterApiKey: `sk-or-v1-${"b".repeat(32)}` },
    };

    expect(parseAgentLaunchSpec(wrongKey)).toMatchObject({ ok: false });
    expect(parseAgentLaunchSpec(legacyField)).toMatchObject({ ok: false });
  });

  it("rejects managed v3 token, allowlist, prototype, and exact-key hazards safely", () => {
    const leadingZeroToken = sampleManagedLaunchSpec({
      secrets: {
        ...sampleManagedLaunchSpec().secrets,
        telegramBotToken: "0123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      },
    });
    const overlongToken = sampleManagedLaunchSpec({
      secrets: {
        ...sampleManagedLaunchSpec().secrets,
        telegramBotToken: "123456789012345678901:ABCDEFGHIJKLMNOPQRSTUVWXYZ12",
      },
    });
    const duplicateAllowlist = sampleManagedLaunchSpec({
      secrets: {
        ...sampleManagedLaunchSpec().secrets,
        telegramAllowedUsers: ["1", "1"],
      },
    });
    const withUnknownNested = {
      ...sampleManagedLaunchSpec(),
      platforms: {
        ...sampleManagedLaunchSpec().platforms,
        telegram: {
          ...sampleManagedLaunchSpec().platforms.telegram,
          token: "must-not-be-accepted",
        },
      },
    };
    const polluted = Object.create({ inherited: true });
    Object.assign(polluted, sampleManagedLaunchSpec());

    for (const candidate of [
      leadingZeroToken,
      overlongToken,
      duplicateAllowlist,
      withUnknownNested,
      polluted,
    ]) {
      const parsed = parseAgentLaunchSpec(candidate);

      expect(parsed.ok).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ12");
    }
  });
});
