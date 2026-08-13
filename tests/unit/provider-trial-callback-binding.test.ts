import { describe, expect, it, vi } from "vitest";
import {
  cleanupProviderTrialCallbackAttribution,
  observeProviderTrialCallbackDatabaseBinding,
  type ProviderTrialCallbackProof,
} from "@/src/server/agents/provider-trial-callback-binding";

const RUNNER_ID = "b02f10c4-5201-49a9-b4d7-ded9420e734e";
const PROOF: ProviderTrialCallbackProof = {
  tokenId: "8af39dc0-d150-420c-a20f-ffdd11673207",
  registrationToken: "bruno_reg_do-not-log-this-registration-token",
  endpointUrl: "https://8af39dc0-d150-420c-a20f-ffdd11673207.provider-trial.invalid",
};

describe("Provider Trial callback database binding", () => {
  it("accepts a registered runner only when it is observable through the operator database", async () => {
    const cleanupProof = vi.fn(async () => undefined);
    const isLocalRunner = vi.fn(async () => true);
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { ok: true, runner: { id: RUNNER_ID }, credential: { token: "secret" } },
        { status: 201 },
      ),
    );

    await expect(
      observeProviderTrialCallbackDatabaseBinding("https://bruno.example", {
        createProof: async () => PROOF,
        cleanupProof,
        fetchImpl,
        isLocalRunner,
      }),
    ).resolves.toBe(true);

    expect(isLocalRunner).toHaveBeenCalledWith(RUNNER_ID, PROOF);
    expect(cleanupProof).toHaveBeenCalledWith(PROOF, RUNNER_ID);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects an unknown token response and still revokes the local proof", async () => {
    const cleanupProof = vi.fn(async () => undefined);
    const isLocalRunner = vi.fn(async () => true);

    await expect(
      observeProviderTrialCallbackDatabaseBinding("https://bruno.example", {
        createProof: async () => PROOF,
        cleanupProof,
        fetchImpl: async () =>
          Response.json(
            { ok: false, error: { code: "invalid_registration_token" } },
            { status: 401 },
          ),
        isLocalRunner,
      }),
    ).resolves.toBe(false);

    expect(isLocalRunner).not.toHaveBeenCalled();
    expect(cleanupProof).toHaveBeenCalledWith(PROOF, null);
  });

  it("rejects a runner created in another database", async () => {
    const cleanupProof = vi.fn(async () => undefined);

    await expect(
      observeProviderTrialCallbackDatabaseBinding("https://bruno.example", {
        createProof: async () => PROOF,
        cleanupProof,
        fetchImpl: async () =>
          Response.json({ ok: true, runner: { id: RUNNER_ID } }, { status: 201 }),
        isLocalRunner: async () => false,
      }),
    ).resolves.toBe(false);

    expect(cleanupProof).toHaveBeenCalledWith(PROOF, RUNNER_ID);
  });

  it("rejects a callback runner that is not linked to the proof token", async () => {
    const cleanupProof = vi.fn(async () => undefined);

    await expect(
      observeProviderTrialCallbackDatabaseBinding("https://bruno.example", {
        createProof: async () => PROOF,
        cleanupProof,
        fetchImpl: async () =>
          Response.json({ ok: true, runner: { id: RUNNER_ID } }, { status: 201 }),
        isLocalRunner: async (_runnerId, proof) => proof.tokenId !== PROOF.tokenId,
      }),
    ).resolves.toBe(false);

    expect(cleanupProof).toHaveBeenCalledWith(PROOF, RUNNER_ID);
  });

  it("fails closed when proof cleanup cannot be completed", async () => {
    await expect(
      observeProviderTrialCallbackDatabaseBinding("https://bruno.example", {
        createProof: async () => PROOF,
        cleanupProof: async () => {
          throw new Error("cleanup failed");
        },
        fetchImpl: async () =>
          Response.json({ ok: true, runner: { id: RUNNER_ID } }, { status: 201 }),
        isLocalRunner: async () => true,
      }),
    ).resolves.toBe(false);
  });
});

describe("Provider Trial callback proof attribution cleanup", () => {
  it("revokes a pending proof token after a mismatched response runner", async () => {
    const revokePendingToken = vi.fn(async () => undefined);
    const revokeAndDeleteRunner = vi.fn(async () => undefined);

    await cleanupProviderTrialCallbackAttribution({
      proof: PROOF,
      observedRunnerId: RUNNER_ID,
      token: { status: "pending", runnerId: null },
      findAttributableRunner: async () => false,
      revokeAndDeleteRunner,
      revokePendingToken,
    });

    expect(revokePendingToken).toHaveBeenCalledOnce();
    expect(revokeAndDeleteRunner).not.toHaveBeenCalled();
  });

  it("revokes the token-linked runner and any separately attributable response runner", async () => {
    const tokenRunnerId = "f0ac18c8-a99b-468a-ae7c-e98982183348";
    const revokeAndDeleteRunner = vi.fn(async () => undefined);
    const revokePendingToken = vi.fn(async () => undefined);

    await cleanupProviderTrialCallbackAttribution({
      proof: PROOF,
      observedRunnerId: RUNNER_ID,
      token: { status: "used", runnerId: tokenRunnerId },
      findAttributableRunner: async (runnerId) => runnerId === RUNNER_ID,
      revokeAndDeleteRunner,
      revokePendingToken,
    });

    expect(revokeAndDeleteRunner).toHaveBeenCalledTimes(2);
    expect(revokeAndDeleteRunner).toHaveBeenCalledWith(tokenRunnerId);
    expect(revokeAndDeleteRunner).toHaveBeenCalledWith(RUNNER_ID);
    expect(revokePendingToken).not.toHaveBeenCalled();
  });
});
