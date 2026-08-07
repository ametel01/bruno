import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  planVercelBuildCommands,
  runVercelBuild,
  type VercelBuildCommand,
} from "@/scripts/vercel-build";

const PRODUCTION_RUNNER_ENV = {
  AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
  AGENTBAY_DIGITALOCEAN_TOKEN: "provider-token-present",
  AGENTBAY_RUNNER_BEARER_TOKEN: "runner-token-present",
  AGENTBAY_RUNNER_IMAGE: `ghcr.io/ametel01/agentbay-runner:${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
};

describe("Vercel build workflow", () => {
  it("migrates the production database before building", async () => {
    const commands: VercelBuildCommand[] = [];
    const runCommand = vi.fn(async (command: VercelBuildCommand) => {
      commands.push(command);
    });

    await runVercelBuild(
      {
        ...PRODUCTION_RUNNER_ENV,
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: "secret-key-present",
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      },
      runCommand,
    );

    expect(commands).toEqual([
      { command: "bun", args: ["run", "db:migrate"] },
      { command: "bun", args: ["run", "build"] },
    ]);
  });

  it("migrates and builds a pre-cutover operator-protected production deployment", () => {
    expect(
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "operator",
        AGENTBAY_OPERATOR_PASSWORD: "operator-password-present",
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      }),
    ).toEqual([
      { command: "bun", args: ["run", "db:migrate"] },
      { command: "bun", args: ["run", "build"] },
    ]);
  });

  it("migrates and builds an explicitly public development production deployment", () => {
    expect(
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT: "true",
        NEXT_PUBLIC_APP_URL: "https://getbruno.xyz",
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      }),
    ).toEqual([
      { command: "bun", args: ["run", "db:migrate"] },
      { command: "bun", args: ["run", "build"] },
    ]);
  });

  it("fails an operator production build closed when Basic auth is not configured", () => {
    expect(() =>
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "operator",
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      }),
    ).toThrow("Operator authentication is not configured.");
  });

  it("fails closed when a production build has no database URL", () => {
    expect(() =>
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "clerk",
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: "secret-key-present",
        VERCEL_ENV: "production",
      }),
    ).toThrow("DATABASE_URL is required for production Vercel migrations.");
  });

  it("fails a ready-agent production build before deployment without an immutable runner", () => {
    expect(() =>
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT: "true",
        AGENTBAY_READY_AGENT_CREATION_ENABLED: "true",
        AGENTBAY_DIGITALOCEAN_TOKEN: "provider-token-present",
        AGENTBAY_RUNNER_BEARER_TOKEN: "runner-token-present",
        NEXT_PUBLIC_APP_URL: "https://getbruno.xyz",
        VERCEL_ENV: "production",
        DATABASE_URL: "postgres://production.example/agentbay",
      }),
    ).toThrow("AGENTBAY_RUNNER_IMAGE must be an immutable registry image reference");
  });

  it.each([
    ["explicit", "clerk"],
    ["unset", undefined],
  ])("does not migrate an %s Clerk preview build without a preview database", (_label, mode) => {
    expect(
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: mode,
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "publishable-key-present",
        CLERK_SECRET_KEY: "secret-key-present",
        VERCEL_ENV: "preview",
      }),
    ).toEqual([{ command: "bun", args: ["run", "build"] }]);
  });

  it.each([
    ["both keys missing", undefined, undefined],
    ["secret key missing", "publishable-key-present", undefined],
  ])("fails an unset preview build closed when %s", (_label, publishableKey, secretKey) => {
    expect(() =>
      planVercelBuildCommands({
        NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: publishableKey,
        CLERK_SECRET_KEY: secretKey,
        VERCEL_ENV: "preview",
      }),
    ).toThrow("Clerk authentication is not configured.");
  });

  it("permits only an explicit attested development preview", () => {
    const previewEnv = {
      AGENTBAY_AUTH_MODE: "development",
      AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
      NEXT_PUBLIC_APP_URL: "https://agentbay-git-feature.example.vercel.app",
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "agentbay-git-feature.example.vercel.app",
    };

    expect(planVercelBuildCommands(previewEnv)).toEqual([
      { command: "bun", args: ["run", "build"] },
    ]);
    expect(() =>
      planVercelBuildCommands({
        ...previewEnv,
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: undefined,
      }),
    ).toThrow("Preview development authentication requires verified deployment protection.");
  });

  it.each([
    ["missing", undefined, undefined],
    ["malformed", "not a URL", "not a hostname"],
  ])("fails closed before planning an attested preview build with %s hosts", (_label, appUrl, vercelUrl) => {
    expect(() =>
      planVercelBuildCommands({
        AGENTBAY_AUTH_MODE: "development",
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: "true",
        NEXT_PUBLIC_APP_URL: appUrl,
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: vercelUrl,
      }),
    ).toThrow("Development authentication is not allowed in this environment.");
  });

  it("allows a no-key local build through the loopback development default", () => {
    expect(planVercelBuildCommands({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" })).toEqual([
      { command: "bun", args: ["run", "build"] },
    ]);
  });

  it("fails the real build entrypoint before spawning commands for an unattested preview", async () => {
    const sensitiveValue = "publishable-value-that-must-not-be-echoed";
    const result = await runRealVercelBuild({
      AGENTBAY_AUTH_MODE: "development",
      NEXT_PUBLIC_APP_URL: "https://agentbay-git-feature.example.vercel.app",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: sensitiveValue,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "agentbay-git-feature.example.vercel.app",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "Preview development authentication requires verified deployment protection.",
    );
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(result.stderr).not.toContain("ENOENT");
  });

  it("fails the real unset-preview build entrypoint closed when Clerk keys are incomplete", async () => {
    const sensitiveValue = "publishable-value-that-must-not-be-echoed";
    const result = await runRealVercelBuild({
      AGENTBAY_AUTH_MODE: undefined,
      NEXT_PUBLIC_APP_URL: "https://agentbay-git-feature.example.vercel.app",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: sensitiveValue,
      VERCEL: "1",
      VERCEL_ENV: "preview",
      VERCEL_URL: "agentbay-git-feature.example.vercel.app",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Clerk authentication is not configured.");
    expect(result.stderr).not.toContain(
      "Development authentication is not allowed in this environment.",
    );
    expect(result.stderr).not.toContain(sensitiveValue);
    expect(result.stderr).not.toContain("ENOENT");
  });
});

async function runRealVercelBuild(
  values: Record<string, string | undefined>,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["--no-env-file", "scripts/vercel-build.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...values,
        AGENTBAY_PREVIEW_PROTECTION_VERIFIED: undefined,
        CLERK_SECRET_KEY: undefined,
      },
    });
    let stderr = "";
    let stdout = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stderr, stdout });
    });
  });
}
