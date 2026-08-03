import { describe, expect, it } from "vitest";
import { redactSecretText } from "@/src/shared/secret-redaction";

describe("secret redaction", () => {
  it("redacts raw and percent-encoded Telegram bot API URLs while keeping token redaction", () => {
    const rawUrl = "https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/getMe";
    const encodedUrl = "https://api.telegram.org/bot123456%3Aabcdefghijklmnopqrstuvwxyz/getMe";
    const text = `${rawUrl} ${encodedUrl} token=123456:abcdefghijklmnopqrstuvwxyz`;

    const redacted = redactSecretText(text);

    expect(redacted).toContain("[redacted-telegram-url]");
    expect(redacted).toContain("[redacted-telegram-token]");
    expect(redacted).not.toContain(rawUrl);
    expect(redacted).not.toContain(encodedUrl);
    expect(redacted).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
    expect(redacted).not.toContain("123456%3Aabcdefghijklmnopqrstuvwxyz");
  });
});
