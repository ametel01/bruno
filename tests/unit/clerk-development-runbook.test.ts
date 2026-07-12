import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNBOOK_PATH = "docs/CLERK_DEVELOPMENT.md";

describe("Clerk development runbook", () => {
  it("pins the approved local-only development workflow and evidence boundary", async () => {
    const runbook = await readFile(join(process.cwd(), RUNBOOK_PATH), "utf8");

    for (const requiredText of [
      "de322ae8-c258-440e-a679-b74bafb61048",
      "AgentBay development",
      "host-auth-blocked",
      "clerk auth login",
      "clerk apps list",
      'clerk apps create "AgentBay Development"',
      "clerk link --app <app-id>",
      "git check-ignore -q .env.local",
      "touch .env.local",
      "chmod 600 .env.local",
      "clerk env pull --instance dev --file .env.local",
      "clerk doctor --json",
      "verified email code",
      "development Google and Apple",
    ]) {
      expect(runbook).toContain(requiredText);
    }

    expect(runbook).toContain("does not include Ask Siargao");
    expect(runbook).toContain("any production instance");
    expect(runbook).toContain("Vercel configuration");
    expect(runbook).toContain("issue #240");
    expect(runbook).toContain("intermediate evidence only");
    expect(runbook).toContain("`clerk whoami` confirms");
    expect(runbook).toContain("not the linked application");
    expect(runbook.indexOf("chmod 600 .env.local")).toBeLessThan(
      runbook.indexOf("clerk env pull --instance dev --file .env.local"),
    );
    expect(runbook).not.toContain("clerk doctor --fix");
    expect(runbook).not.toContain("clerk env pull --instance prod");
  });

  it("documents every production Google and Apple prerequisite from issue 232", async () => {
    const runbook = await readFile(join(process.cwd(), RUNBOOK_PATH), "utf8");

    for (const requiredText of [
      "Web application",
      "client ID and client secret",
      "authorized redirect URI",
      "OAuth consent screen",
      "Services ID",
      "Apple Team ID",
      "Apple Key ID",
      "private key file",
      "website domain",
      "exact return URL",
      "private email relay",
      "SPF DNS record",
    ]) {
      expect(runbook).toContain(requiredText);
    }

    expect(runbook).toContain(
      "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google",
    );
    expect(runbook).toContain(
      "https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple",
    );
    expect(runbook).toContain(
      "https://developer.apple.com/help/account/configure-app-capabilities/configure-private-email-relay-service",
    );
  });

  it("is linked from the auth and provider-acceptance docs without embedded secret or identity data", async () => {
    const [runbook, auth, acceptance] = await Promise.all([
      readFile(join(process.cwd(), RUNBOOK_PATH), "utf8"),
      readFile(join(process.cwd(), "docs/AUTHENTICATION.md"), "utf8"),
      readFile(join(process.cwd(), "docs/TWO_USER_ACCEPTANCE.md"), "utf8"),
    ]);

    await expect(access(join(process.cwd(), RUNBOOK_PATH))).resolves.toBeUndefined();
    expect(auth).toContain("./CLERK_DEVELOPMENT.md");
    expect(acceptance).toContain("./CLERK_DEVELOPMENT.md");

    const trackedDocumentation = `${runbook}\n${auth}\n${acceptance}`;
    expect(trackedDocumentation).not.toMatch(/(?:pk_test|sk_test)_[A-Za-z0-9_-]{16,}/);
    expect(trackedDocumentation).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(trackedDocumentation).not.toMatch(/[?&](?:state|code|token)=/i);
    expect(trackedDocumentation).not.toContain("-----BEGIN PRIVATE KEY-----");
  });
});
