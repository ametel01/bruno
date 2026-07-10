import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePlaywrightArtifactPolicy } from "@/playwright.config";

const MATRIX_PATH = "docs/TWO_USER_ACCEPTANCE.md";

const REQUIRED_DOMAINS = [
  "Clerk-to-user mapping",
  "Agents and configuration",
  "Lifecycle",
  "Logs",
  "Events",
  "Costs",
  "Approvals",
  "Backups and restores",
  "Runner reads and placement",
  "Registration tokens",
  "Credentials and heartbeat",
  "Provisioning",
] as const;

const REQUIRED_EVIDENCE_FILES = [
  "tests/unit/application-user.test.ts",
  "tests/unit/agent-user-isolation.test.ts",
  "tests/unit/operational-pages-user-isolation.test.tsx",
  "tests/unit/user-operations-isolation.test.ts",
  "tests/unit/runner-placement.test.ts",
  "tests/unit/cloud-runner-provisioning.test.ts",
  "tests/unit/runner-user-isolation-source.test.ts",
  "tests/unit/runner-registration.test.ts",
  "tests/unit/runner-registration-routes.test.ts",
  "tests/unit/runner-credential-lifecycle.test.ts",
  "tests/unit/runner-provisioning.test.ts",
  "tests/unit/runner-provisioning-route.test.ts",
  "tests/unit/clerk-proxy.test.ts",
  "tests/unit/runner-heartbeat-route.test.ts",
  "tests/unit/runner-bootstrap-events-route.test.ts",
  "tests/unit/manual-runner-adapter.test.ts",
  "tests/unit/runner-service.test.ts",
  "tests/unit/legacy-user-claim.test.ts",
  "tests/unit/clerk-auth-surfaces.test.tsx",
] as const;

describe("two-user acceptance evidence matrix", () => {
  it("keeps every user-owned domain linked to executable evidence", async () => {
    const matrix = await readFile(join(process.cwd(), MATRIX_PATH), "utf8");

    for (const domain of REQUIRED_DOMAINS) {
      expect(matrix).toContain(`| ${domain} |`);
    }

    for (const evidenceFile of REQUIRED_EVIDENCE_FILES) {
      expect(matrix).toContain(`\`${evidenceFile}\``);
      await expect(access(join(process.cwd(), evidenceFile))).resolves.toBeUndefined();
    }
  });

  it("separates credential-free proof from approval-gated provider success", async () => {
    const matrix = await readFile(join(process.cwd(), MATRIX_PATH), "utf8");

    expect(matrix).toContain("All committed checks are credential-free");
    expect(matrix).toContain(
      "Email-code, Google, Apple, current-user, and sign-out browser success",
    );
    expect(matrix).toContain("#232 approval-gated");
    expect(matrix).toContain("does not claim they passed");
    expect(matrix).not.toMatch(/(?:pk_test|sk_test|agb_reg|agb_run)_[A-Za-z0-9_-]{16,}/);
    expect(matrix).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  });

  it.each([
    [
      "explicit local development",
      {
        AGENTBAY_AUTH_MODE: "development",
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3139",
      },
      "on-first-retry",
    ],
    [
      "default credential-free loopback development",
      { NEXT_PUBLIC_APP_URL: "http://localhost:3139" },
      "on-first-retry",
    ],
    [
      "explicit Clerk",
      {
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "synthetic-publishable-presence",
        CLERK_SECRET_KEY: "synthetic-secret-presence",
      },
      "off",
    ],
    [
      "inferred Clerk on an unset Vercel preview",
      {
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "synthetic-publishable-presence",
        CLERK_SECRET_KEY: "synthetic-secret-presence",
        VERCEL_ENV: "preview",
      },
      "off",
    ],
    [
      "incomplete inferred Clerk configuration",
      {
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "synthetic-publishable-presence",
        VERCEL_ENV: "preview",
      },
      "off",
    ],
    [
      "disallowed development on a hosted domain",
      {
        AGENTBAY_AUTH_MODE: "development",
        NEXT_PUBLIC_APP_URL: "https://hosted.example.test",
      },
      "off",
    ],
    [
      "invalid explicit mode",
      {
        AGENTBAY_AUTH_MODE: "unexpected",
        NEXT_PUBLIC_APP_URL: "http://localhost:3139",
      },
      "off",
    ],
  ] as const)("uses fail-closed browser artifacts for %s", (_label, env, trace) => {
    expect(resolvePlaywrightArtifactPolicy(env)).toEqual({
      screenshot: "off",
      trace,
      video: "off",
    });
  });

  it("wires the resolved artifact policy into every Playwright project", async () => {
    const config = await readFile(join(process.cwd(), "playwright.config.ts"), "utf8");

    expect(config).toContain("resolvePlaywrightArtifactPolicy(process.env)");
    expect(config).toContain("...artifactPolicy");
  });
});
