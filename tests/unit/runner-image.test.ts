import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("runner image", () => {
  it("packages the runner service runtime imports", async () => {
    const dockerfile = await readFile(join(process.cwd(), "Dockerfile.runner"), "utf8");

    expect(dockerfile).toContain("COPY src/runner-service ./src/runner-service");
    expect(dockerfile).toContain(
      "COPY src/server/agents/agent-launch-spec.ts ./src/server/agents/agent-launch-spec.ts",
    );
    expect(dockerfile).toContain(
      "COPY src/shared/secret-redaction.ts ./src/shared/secret-redaction.ts",
    );
  });
});
