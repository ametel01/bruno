import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const BROWSER_RUNNER_FILES = [
  "app/settings/page.tsx",
  "app/api/runners/route.ts",
  "app/api/runners/registration-tokens/route.ts",
  "app/api/runners/[runnerId]/credentials/rotate/route.ts",
  "app/api/runners/[runnerId]/credentials/revoke/route.ts",
] as const;

const MACHINE_RUNNER_FILES = [
  "app/runner/v1/register/route.ts",
  "app/runner/v1/heartbeat/route.ts",
  "app/runner/v1/bootstrap-events/route.ts",
] as const;

describe("runner user-isolation source boundaries", () => {
  it("requires one configured browser user and excludes development-user services", async () => {
    for (const file of BROWSER_RUNNER_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");

      expect(source).toContain("requireConfiguredApplicationUser");
      expect(source).not.toContain("ForDevelopmentUser");
      expect(source).not.toContain("development-user");
    }
  });

  it("threads explicit user IDs into every covered browser runner service", async () => {
    const settingsSource = await readFile(join(process.cwd(), "app/settings/page.tsx"), "utf8");
    const provisioningSource = await readFile(
      join(process.cwd(), "app/api/runners/route.ts"),
      "utf8",
    );
    const tokenSource = await readFile(
      join(process.cwd(), "app/api/runners/registration-tokens/route.ts"),
      "utf8",
    );
    const rotateSource = await readFile(
      join(process.cwd(), "app/api/runners/[runnerId]/credentials/rotate/route.ts"),
      "utf8",
    );
    const revokeSource = await readFile(
      join(process.cwd(), "app/api/runners/[runnerId]/credentials/revoke/route.ts"),
      "utf8",
    );

    for (const service of [
      "listSettingsRunnerManagementSummariesForUser",
      "listCloudRunnerProvisioningSummariesForUser",
      "getCostEstimatesForUser",
    ]) {
      expect(settingsSource).toContain(service);
    }

    expect(provisioningSource).toContain("createDigitalOceanRunnerForUser");
    expect(tokenSource).toContain("createRunnerRegistrationTokenForUser");
    expect(rotateSource).toContain("rotateRunnerCredentialForUser");
    expect(revokeSource).toContain("revokeRunnerCredentialForUser");
  });

  it("keeps runner machine routes independent from Clerk browser authentication", async () => {
    for (const file of MACHINE_RUNNER_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");

      expect(source).not.toContain("requireConfiguredApplicationUser");
      expect(source).not.toContain("@clerk");
    }

    const registerSource = await readFile(
      join(process.cwd(), "app/runner/v1/register/route.ts"),
      "utf8",
    );
    const heartbeatSource = await readFile(
      join(process.cwd(), "app/runner/v1/heartbeat/route.ts"),
      "utf8",
    );
    const bootstrapSource = await readFile(
      join(process.cwd(), "app/runner/v1/bootstrap-events/route.ts"),
      "utf8",
    );

    expect(registerSource).toContain("exchangeRunnerRegistrationTokenForCredential");
    expect(heartbeatSource).toContain("authorizationHeader");
    expect(heartbeatSource).toContain("recordRunnerHeartbeat");
    expect(bootstrapSource).toContain("recordRunnerBootstrapEvent");
  });
});
