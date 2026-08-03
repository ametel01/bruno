import { describe, expect, it, vi } from "vitest";
import {
  TELEGRAM_GET_ME_MAX_BYTES,
  TELEGRAM_GET_ME_TIMEOUT_MS,
  validateTelegramBotTokenWithGetMe,
} from "@/src/server/telegram/telegram-client";

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";

describe("Telegram getMe validation client", () => {
  it("posts once to the fixed Telegram getMe boundary and returns safe bot metadata", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        result: { id: 123456, is_bot: true, username: "Valid_bot" },
      }),
    );

    await expect(validateTelegramBotTokenWithGetMe(TOKEN, { fetch })).resolves.toEqual({
      ok: true,
      bot: { botId: "123456", username: "Valid_bot" },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;

    expect(calls[0]?.[0]).toBe(
      "https://api.telegram.org/bot123456%3Aabcdefghijklmnopqrstuvwxyz/getMe",
    );
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    expect(calls[0]?.[1]).not.toHaveProperty("body");
  });

  it("maps invalid tokens and bounded ok:false responses to invalid_bot_token", async () => {
    await expect(
      validateTelegramBotTokenWithGetMe("bad-token", { fetch: vi.fn() }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_bot_token",
    });
    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch: vi.fn(async () =>
          Response.json({ ok: false, description: "unsafe" }, { status: 400 }),
        ),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_bot_token" });
    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch: vi.fn(async () => Response.json({ ok: false }, { status: 401 })),
      }),
    ).resolves.toEqual({ ok: false, reason: "invalid_bot_token" });
  });

  it("rejects malformed, mismatched, non-bot, unsafe, and oversized responses safely", async () => {
    const cases: Array<() => Response> = [
      () => Response.json({ ok: true, result: { id: 654321, is_bot: true } }),
      () => Response.json({ ok: true, result: { id: 123456, is_bot: false } }),
      () => Response.json({ ok: true, result: { id: 123456, is_bot: true, username: "bad" } }),
      () => new Response("not-json"),
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(TELEGRAM_GET_ME_MAX_BYTES + 1));
              controller.close();
            },
          }),
        ),
      () =>
        new Response("{}", {
          headers: { "content-length": String(TELEGRAM_GET_ME_MAX_BYTES + 1) },
        }),
    ];

    for (const createResponse of cases) {
      await expect(
        validateTelegramBotTokenWithGetMe(TOKEN, { fetch: vi.fn(async () => createResponse()) }),
      ).resolves.toEqual({ ok: false, reason: "telegram_validation_invalid_response" });
    }
  });

  it("maps timeout, unavailable status, and transport throws without upstream detail", async () => {
    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch: vi.fn(async () => Response.json({ ok: false }, { status: 429 })),
      }),
    ).resolves.toEqual({ ok: false, reason: "telegram_validation_unavailable" });
    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch: vi.fn(async () => Response.json({ ok: false }, { status: 500 })),
      }),
    ).resolves.toEqual({ ok: false, reason: "telegram_validation_unavailable" });
    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch: vi.fn(async () => {
          throw new Error("https://api.telegram.org/bot123456:abcdefghijklmnopqrstuvwxyz/getMe");
        }),
      }),
    ).resolves.toEqual({ ok: false, reason: "telegram_validation_unavailable" });

    const controller = new AbortController();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }

      throw new Error("expected aborted signal");
    });

    await expect(
      validateTelegramBotTokenWithGetMe(TOKEN, {
        fetch,
        createAbortController: () => controller,
        setTimeout: ((callback: () => void) => {
          expect(TELEGRAM_GET_ME_TIMEOUT_MS).toBe(5_000);
          callback();
          return 1 as unknown as ReturnType<typeof setTimeout>;
        }) as typeof setTimeout,
        clearTimeout: vi.fn(),
      }),
    ).resolves.toEqual({ ok: false, reason: "telegram_validation_timeout" });
  });
});
