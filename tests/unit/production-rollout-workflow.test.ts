import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("protected production rollout workflow", () => {
  it("requires protected authorization and exercises every rollback with provisioning halted", async () => {
    const workflow = await readFile(".github/workflows/rollout-production.yml", "utf8");

    expect(workflow).toContain("environment: production");
    expect(workflow).toContain("authorize-issue-300-protected-production-rollout");
    expect(workflow).toContain("maximum_exercise_spend_cents");
    expect(workflow).toContain('default: "0"');
    expect(workflow).toContain("QSTASH_TOKEN: $" + "{{ secrets.QSTASH_TOKEN }}");
    expect(workflow).toContain(
      "BRUNO_DIGITALOCEAN_TOKEN: $" + "{{ secrets.BRUNO_DIGITALOCEAN_TOKEN }}",
    );
    expect(workflow).toContain("VERCEL_TOKEN: $" + "{{ secrets.VERCEL_TOKEN }}");
    expect(workflow).toContain("BRUNO_COLD_PROVISIONING_HALT_REASON");

    expect(workflow).toContain("run-production-rollout.ts plan");
    expect(workflow).toContain('evaluate "$' + '{ROLLBACK_SOURCE_STEP}"');
    expect(workflow).toContain('for ROLLOUT_STEP in "$' + '{ROLLOUT_STEPS[@]}"');
    expect(workflow).not.toContain('--token="$' + '{VERCEL_TOKEN}"');
    expect(workflow).not.toContain('-H "Authorization: Bearer $' + "{");
    expect(workflow).toContain('--config "$' + '{STATUS_CURL_CONFIG}"');
    const environmentLoopStart = workflow.indexOf("for ENV_NAME in");
    const environmentLoop = workflow.slice(
      environmentLoopStart,
      workflow.indexOf("done", environmentLoopStart),
    );
    for (const credentialName of [
      "BRUNO_AGENT_SECRET_KEYS_JSON",
      "BRUNO_DIGITALOCEAN_TOKEN",
      "BRUNO_RUNNER_BEARER_TOKEN",
      "CRON_SECRET",
      "QSTASH_TOKEN",
      "QSTASH_CURRENT_SIGNING_KEY",
      "QSTASH_NEXT_SIGNING_KEY",
    ]) {
      expect(environmentLoop).not.toContain(credentialName);
    }
  });

  it("verifies sanitized live status, pinning, cleanup, and retained evidence", async () => {
    const workflow = await readFile(".github/workflows/rollout-production.yml", "utf8");

    expect(workflow).toContain("/api/internal/production-rollout/status");
    expect(workflow).toContain("vercel@${" + 'VERCEL_CLI_VERSION}" curl');
    expect(workflow).toContain('--deployment "${' + 'CANDIDATE_URL}"');
    expect(workflow).toContain("X-Bruno-Rollout-Authorization: Bearer %s");
    expect(workflow).toContain("pinnedChoicesValid");
    expect(workflow).toContain("provider-trial-report-digest");
    expect(workflow).toContain("temporaryProviderResources");
    expect(workflow).toContain("retained-snapshot-inventory.json");
    expect(workflow).toContain("signal-policy.jsonl");
    expect(workflow).toContain("actions/attest-build-provenance");
    expect(workflow).toContain("Restore a verified halted generation after any failure");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).not.toContain("pull_request_target");
  });
});
