import { describe, expect, it } from "vitest";
import { resolveLocalRunnerCommand } from "@/src/server/runners/local-runner-adapter";

describe("local runner adapter command configuration", () => {
  it("defaults to the dummy Node process and keeps Hermes behind explicit configuration", () => {
    expect(resolveLocalRunnerCommand({})).toMatchObject({
      executable: process.execPath,
      args: ["-e", expect.stringContaining("bruno dummy runner started")],
    });
    expect(
      resolveLocalRunnerCommand({
        BRUNO_LOCAL_RUNNER_EXECUTABLE: "/opt/hermes/bin/hermes",
        BRUNO_LOCAL_RUNNER_ARGS_JSON: '["run","--agent-id","demo-agent"]',
      }),
    ).toEqual({
      executable: "/opt/hermes/bin/hermes",
      args: ["run", "--agent-id", "demo-agent"],
    });
    expect(() =>
      resolveLocalRunnerCommand({
        BRUNO_LOCAL_RUNNER_EXECUTABLE: "/opt/hermes/bin/hermes",
        BRUNO_LOCAL_RUNNER_ARGS_JSON: '"run --agent-id demo-agent"',
      }),
    ).toThrow("BRUNO_LOCAL_RUNNER_ARGS_JSON must be a JSON string array.");
  });
});
