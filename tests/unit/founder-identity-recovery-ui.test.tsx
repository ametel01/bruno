import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdentityRecoverySurface } from "@/app/identity-recovery/identity-recovery-surface";

describe("Founder identity recovery surface", () => {
  it("states the identity, commerce, retirement, refund, and Account Closure boundaries", () => {
    const html = renderToStaticMarkup(<IdentityRecoverySurface />);
    expect(html).toContain("Reconnect to the same Founder workspace");
    expect(html).toContain("does not cancel payment");
    expect(html).toContain("begin Infrastructure Retirement");
    expect(html).toContain("request Account");
    expect(html).toContain("Closure");
    expect(html).toContain("Refunds remain a separate commerce decision");
    expect(html).toContain("Email, checkout details, a new Clerk ID");
    expect(html).toContain("Identity Recovery code");
    expect(html).toContain("Identity Recovery receipts");
    expect(html).toContain("Account Closure stays separate");
    expect(html).toContain('href="/sign-in?continue=identity-recovery"');
    expect(html).toContain('aria-label="Account Closure boundary"');
  });
});
