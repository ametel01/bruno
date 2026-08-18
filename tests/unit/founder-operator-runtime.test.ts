import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFounderOperatorNativeLaunchSpec,
  createFounderOperatorFilesystemAdapter,
} from "@/src/server/operators/founder-operator-runtime";

describe("Founder Operator Hermes runtime boundary", () => {
  let stateRoot: string | null = null;

  afterEach(async () => {
    if (stateRoot) {
      await rm(stateRoot, { recursive: true, force: true });
      stateRoot = null;
    }
  });

  it("prepares one persistent home and workspace with Telegram excluded", async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "bruno-founder-operator-runtime-"));
    const adapter = createFounderOperatorFilesystemAdapter({ stateRoot });
    const input = {
      operatorId: "00000000-0000-4000-8000-000000003381",
      userId: "00000000-0000-4000-8000-000000003382",
      runtimeIdentity: "bruno-operator-00000000-0000-4000-8000-000000003381",
      configRevision: "operator-runtime-1-1723939200000",
      now: new Date("2026-08-18T00:00:00.000Z"),
      launchSpec: buildFounderOperatorNativeLaunchSpec({
        operatorId: "00000000-0000-4000-8000-000000003381",
        timezone: "Asia/Manila",
        configRevision: "operator-runtime-1-1723939200000",
        apiServerKey: "bruno_agent_abcdefghijklmnopqrstuvwxyz0123456789",
      }),
    };

    await expect(adapter.prepare(input)).resolves.toMatchObject({
      ok: true,
      transportState: "connected",
      safetyState: "verified",
    });
    await expect(adapter.verify(input)).resolves.toMatchObject({ ok: true });

    const marker = await readFile(
      join(stateRoot, input.operatorId, "hermes", "bruno-operator-runtime.json"),
      "utf8",
    );
    expect(JSON.parse(marker)).toMatchObject({
      contractVersion: "bruno.operator.safety.v1",
      operatorId: input.operatorId,
      configRevision: input.configRevision,
      telegramRequired: false,
      providerConfigOwner: "hermes",
    });
    expect(
      await readFile(join(stateRoot, input.operatorId, "hermes", "config.yaml"), "utf8"),
    ).toContain("provider: hermes");
    expect(
      JSON.parse(
        await readFile(
          join(stateRoot, input.operatorId, "hermes", "bruno-config-revision.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      version: "bruno.hermes.launch.v2",
      agentId: input.operatorId,
      configRevision: input.configRevision,
    });
  });

  it("builds a native launch path that preserves Hermes provider state", () => {
    const spec = buildFounderOperatorNativeLaunchSpec({
      operatorId: "00000000-0000-4000-8000-000000003381",
      timezone: "Asia/Manila",
      configRevision: "operator-runtime-1-1723939200000",
      apiServerKey: "bruno_agent_abcdefghijklmnopqrstuvwxyz0123456789",
    });

    expect(spec.version).toBe("bruno.hermes.launch.v2");
    expect(spec.model).toEqual({ provider: "hermes", model: "configured-by-hermes" });
    expect(spec.tools.disabled).toContain("browser");
    expect(spec.secrets).toEqual({
      kind: "inline",
      apiServerKey: "bruno_agent_abcdefghijklmnopqrstuvwxyz0123456789",
    });
    expect("platforms" in spec).toBe(false);
  });

  it("rejects a marker symlink instead of writing through it", async () => {
    stateRoot = await mkdtemp(join(tmpdir(), "bruno-founder-operator-runtime-"));
    const adapter = createFounderOperatorFilesystemAdapter({ stateRoot });
    const input = {
      operatorId: "00000000-0000-4000-8000-000000003381",
      userId: "00000000-0000-4000-8000-000000003382",
      runtimeIdentity: "bruno-operator-00000000-0000-4000-8000-000000003381",
      configRevision: "operator-runtime-1-1723939200000",
      now: new Date("2026-08-18T00:00:00.000Z"),
    };
    await expect(adapter.prepare(input)).resolves.toMatchObject({ ok: true });
    const marker = join(stateRoot, input.operatorId, "hermes", "bruno-operator-runtime.json");
    await rm(marker);
    await symlink("/tmp/operator-runtime-outside", marker);

    await expect(
      adapter.prepare({ ...input, configRevision: "operator-runtime-2-1723939201000" }),
    ).resolves.toMatchObject({
      ok: false,
      code: "runtime_prepare_failed",
    });
  });
});
