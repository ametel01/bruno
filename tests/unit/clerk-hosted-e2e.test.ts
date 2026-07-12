import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  CLERK_HOSTED_CAPABILITY_MESSAGE,
  CLERK_HOSTED_SETUP_FAILURE_MESSAGE,
  planClerkHostedCommand,
  runClerkHostedE2E,
} from "@/scripts/run-clerk-e2e";

const COMPLETE_ENV = {
  CLERK_PUBLISHABLE_KEY: "publishable-value-must-not-print",
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-value-must-not-print",
  CLERK_SECRET_KEY: "secret-value-must-not-print",
  AGENTBAY_OPERATOR_USERNAME: "operator-user-must-not-print",
  AGENTBAY_OPERATOR_PASSWORD: "operator-password-must-not-print",
  E2E_CLERK_TEST_USER_A_EMAIL: "user-a+clerk_test@example.invalid",
  E2E_CLERK_TEST_USER_B_EMAIL: "user-b+clerk_test@example.invalid",
};
const PORT_EXPANSION = ["$", "{PORT:-3200}"].join("");
const CONFIG_PORT = ["$", "{port}"].join("");

describe("optional hosted Clerk E2E gate", () => {
  it("fails before launching Playwright when capability values are missing", async () => {
    const commands: unknown[] = [];
    const errors: string[] = [];

    await expect(
      runClerkHostedE2E(
        {
          CLERK_PUBLISHABLE_KEY: "publishable-value-must-not-print",
          E2E_CLERK_TEST_USER_A_EMAIL: "user-a+clerk_test@example.invalid",
        },
        {
          cwd: "/repo",
          platform: "linux",
          runCommand: async (command) => {
            commands.push(command);
            return 0;
          },
          writeError: (message) => errors.push(message),
        },
      ),
    ).resolves.toBe(1);

    expect(commands).toEqual([]);
    expect(errors[0]).toContain(CLERK_HOSTED_CAPABILITY_MESSAGE);
    expect(errors[0]).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY");
    expect(errors[0]).toContain("CLERK_SECRET_KEY");
    expect(errors.join(" ")).not.toContain("must-not-print");
  });

  it("rejects duplicate or non-test identities without echoing them", async () => {
    const errors: string[] = [];

    await expect(
      runClerkHostedE2E(
        {
          ...COMPLETE_ENV,
          E2E_CLERK_TEST_USER_B_EMAIL: COMPLETE_ENV.E2E_CLERK_TEST_USER_A_EMAIL,
        },
        { writeError: (message) => errors.push(message) },
      ),
    ).resolves.toBe(1);

    await expect(
      runClerkHostedE2E(
        {
          ...COMPLETE_ENV,
          E2E_CLERK_TEST_USER_B_EMAIL: "real-user@example.invalid",
        },
        { writeError: (message) => errors.push(message) },
      ),
    ).resolves.toBe(1);

    expect(errors).toHaveLength(2);
    expect(errors.every((message) => message.includes("distinct +clerk_test identities"))).toBe(
      true,
    );
    expect(errors.join(" ")).not.toContain("real-user@example.invalid");
  });

  it("bootstraps Clerk before launching Playwright", async () => {
    const events: string[] = [];

    await expect(
      runClerkHostedE2E(COMPLETE_ENV, {
        setupClerk: async () => {
          events.push("setup");
        },
        runCommand: async () => {
          events.push("playwright");
          return 0;
        },
      }),
    ).resolves.toBe(0);

    expect(events).toEqual(["setup", "playwright"]);
  });

  it("suppresses raw Clerk setup failures and does not launch Playwright", async () => {
    const commands: unknown[] = [];
    const errors: string[] = [];

    await expect(
      runClerkHostedE2E(COMPLETE_ENV, {
        setupClerk: async () => {
          throw new Error("secret-value-must-not-print");
        },
        runCommand: async (command) => {
          commands.push(command);
          return 0;
        },
        writeError: (message) => errors.push(message),
      }),
    ).resolves.toBe(1);

    expect(commands).toEqual([]);
    expect(errors).toEqual([CLERK_HOSTED_SETUP_FAILURE_MESSAGE]);
    expect(errors.join(" ")).not.toContain("secret-value-must-not-print");
  });

  it("plans only the dedicated hosted config when capability is present", () => {
    expect(planClerkHostedCommand(COMPLETE_ENV, { cwd: "/repo", platform: "linux" })).toEqual({
      ok: true,
      command: {
        command: "/repo/node_modules/.bin/playwright",
        args: ["test", "--config=playwright.clerk.config.ts"],
      },
    });
  });

  it("keeps the hosted project opt-in and artifact-free", async () => {
    const [packageJson, config, spec, docs] = await Promise.all([
      readFile("package.json", "utf8"),
      readFile("playwright.clerk.config.ts", "utf8"),
      readFile("tests/e2e-hosted/clerk-hosted.spec.ts", "utf8"),
      readFile("docs/E2E_VALIDATION.md", "utf8"),
    ]);

    const packageScripts = (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts;

    expect(packageScripts["test:e2e:clerk"]).toContain("run-clerk-e2e.ts");
    expect(packageScripts["test:e2e"]).toContain("run-e2e.ts full");
    expect(packageScripts["test:e2e"]).not.toContain("clerk");
    expect(packageScripts["test:e2e:clerk"]).toContain(
      `NEXT_PUBLIC_APP_URL=http://localhost:${PORT_EXPANSION}`,
    );
    expect(packageScripts["test:e2e:clerk"]).toContain(
      `PLAYWRIGHT_BASE_URL=http://localhost:${PORT_EXPANSION}`,
    );
    expect(config).toContain('testDir: "./tests/e2e-hosted"');
    expect(config).toContain(`http://localhost:${CONFIG_PORT}`);
    expect(config).toContain("NEXT_PUBLIC_APP_URL: baseURL");
    expect(config).toContain("httpCredentials");
    expect(config).toContain("origin: new URL(baseURL).origin");
    expect(config).toContain('screenshot: "off"');
    expect(config).toContain('trace: "off"');
    expect(config).toContain('video: "off"');
    expect(config).not.toContain('dependencies: ["clerk setup"]');
    expect(config).not.toContain('name: "clerk setup"');
    expect(await readFile("scripts/run-clerk-e2e.ts", "utf8")).toContain("clerkSetup");
    expect(spec).toContain('strategy: "email_code"');
    expect(spec).toContain('page.goto("/sign-in", { waitUntil: "domcontentloaded" })');
    expect(spec).toContain("primaryEmailAddress");
    expect(spec).toContain("Current user");
    expect(spec).toContain('name: "Sign out"');
    expect(docs).toContain("bun run test:e2e:clerk");
    expect(docs).toContain("Google and Apple");
    expect(docs).toContain("runner-backed");
  });
});
