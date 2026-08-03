import { describe, expect, it, vi } from "vitest";
import {
  diagnoseTelegramWebhook,
  TELEGRAM_WEBHOOK_DIAGNOSTIC_MAX_BYTES,
  TELEGRAM_WEBHOOK_DIAGNOSTIC_TIMEOUT_MS,
} from "@/src/server/telegram/telegram-client";

const TOKEN = "123456:abcdefghijklmnopqrstuvwxyz";
const ENCODED_TOKEN = "123456%3Aabcdefghijklmnopqrstuvwxyz";
const WEBHOOK_URL = "https://private.example.test/telegram/owner-secret";

describe("Telegram getWebhookInfo diagnostic", () => {
  it("uses only the fixed encoded getWebhookInfo boundary and returns empty", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        ok: true,
        result: {
          url: "",
          pending_update_count: 0,
        },
      }),
    );

    await expect(diagnoseTelegramWebhook(TOKEN, { fetch })).resolves.toBe("empty");

    expect(fetch).toHaveBeenCalledTimes(1);
    const calls = fetch.mock.calls as unknown as Array<[string, RequestInit]>;
    expect(calls[0]?.[0]).toBe(`https://api.telegram.org/bot${ENCODED_TOKEN}/getWebhookInfo`);
    expect(calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    expect(calls[0]?.[1]).not.toHaveProperty("body");
    expect(calls[0]?.[0]).not.toContain("deleteWebhook");
    expect(calls[0]?.[0]).not.toContain("getUpdates");
    expect(calls[0]?.[0]).not.toContain("send");
  });

  it("returns only nonempty while discarding all webhook metadata", async () => {
    const hostileMetadata = {
      ok: true,
      result: {
        url: WEBHOOK_URL,
        pending_update_count: 91,
        ip_address: "10.20.30.40",
        has_custom_certificate: true,
        last_error_message: "upstream secret error",
        certificate: "private certificate",
        bot: { id: 123456, username: "private_bot" },
        user: { id: "998877665544" },
      },
    };
    const fetch = vi.fn(async () => Response.json(hostileMetadata));

    const result = await diagnoseTelegramWebhook(TOKEN, { fetch });

    expect(result).toBe("nonempty");
    const serialized = JSON.stringify(result);
    for (const secret of [
      TOKEN,
      ENCODED_TOKEN,
      WEBHOOK_URL,
      "91",
      "10.20.30.40",
      "upstream secret error",
      "private certificate",
      "123456",
      "private_bot",
      "998877665544",
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("maps every malformed or non-success response to uncertain", async () => {
    const responses = [
      () => new Response("not-json"),
      () => Response.json([]),
      () => Response.json({ ok: false, result: { url: "" } }),
      () => Response.json({ ok: true, result: null }),
      () => Response.json({ ok: true, result: [] }),
      () => Response.json({ ok: true, result: { url: null } }),
      () => Response.json({ ok: true, result: { url: 123 } }),
      () => Response.json({ ok: true, result: { url: "" } }, { status: 503 }),
    ];

    for (const createResponse of responses) {
      await expect(
        diagnoseTelegramWebhook(TOKEN, {
          fetch: vi.fn(async () => createResponse()),
        }),
      ).resolves.toBe("uncertain");
    }
  });

  it("rejects accessor and exotic parsed records without invoking them", async () => {
    const outerAccessor = vi.fn(() => true);
    const outer = Object.defineProperty({}, "ok", { get: outerAccessor });
    const urlAccessor = vi.fn(() => WEBHOOK_URL);
    const result = Object.defineProperty({}, "url", { get: urlAccessor });
    const nested = { ok: true, result };
    const exotic = Object.create({ inherited: true }) as Record<string, unknown>;
    exotic.ok = true;
    exotic.result = { url: "" };

    for (const parsed of [outer, nested, exotic]) {
      await expect(
        diagnoseTelegramWebhook(TOKEN, {
          fetch: vi.fn(async () => new Response("{}")),
          parseJson: () => parsed,
        }),
      ).resolves.toBe("uncertain");
    }

    expect(outerAccessor).not.toHaveBeenCalled();
    expect(urlAccessor).not.toHaveBeenCalled();
  });

  it("rejects oversized declared and streamed bodies", async () => {
    const declared = new Response("{}", {
      headers: {
        "content-length": String(TELEGRAM_WEBHOOK_DIAGNOSTIC_MAX_BYTES + 1),
      },
    });
    const streamed = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(TELEGRAM_WEBHOOK_DIAGNOSTIC_MAX_BYTES));
          controller.enqueue(new Uint8Array(1));
          controller.close();
        },
      }),
    );

    for (const response of [declared, streamed]) {
      await expect(
        diagnoseTelegramWebhook(TOKEN, {
          fetch: vi.fn(async () => response),
        }),
      ).resolves.toBe("uncertain");
    }
  });

  it("aborts at five seconds and returns only uncertain", async () => {
    const abortController = new AbortController();
    const clearTimeout = vi.fn();
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("private slow upstream detail", "AbortError");
    });

    const result = await diagnoseTelegramWebhook(TOKEN, {
      fetch,
      createAbortController: () => abortController,
      setTimeout: ((callback: () => void, milliseconds?: number) => {
        expect(milliseconds).toBe(TELEGRAM_WEBHOOK_DIAGNOSTIC_TIMEOUT_MS);
        callback();
        return 77 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout,
      clearTimeout,
    });

    expect(result).toBe("uncertain");
    expect(clearTimeout).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain("private slow upstream detail");
  });

  it("refuses redirects and redacts hostile response and transport accessors", async () => {
    const responseSecret = "private response accessor detail";
    const hostileResponse = Object.defineProperty({}, "ok", {
      get() {
        throw new Error(responseSecret);
      },
    }) as Response;
    const redirectFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError(`redirected to ${WEBHOOK_URL} with ${TOKEN}`);
    });

    const outcomes = await Promise.all([
      diagnoseTelegramWebhook(TOKEN, {
        fetch: vi.fn(async () => hostileResponse),
      }),
      diagnoseTelegramWebhook(TOKEN, { fetch: redirectFetch }),
    ]);

    expect(outcomes).toEqual(["uncertain", "uncertain"]);
    const serialized = JSON.stringify(outcomes);
    expect(serialized).not.toContain(responseSecret);
    expect(serialized).not.toContain(WEBHOOK_URL);
    expect(serialized).not.toContain(TOKEN);
  });

  it("does not make a request for a malformed token", async () => {
    const fetch = vi.fn();

    await expect(diagnoseTelegramWebhook("not-a-token", { fetch })).resolves.toBe("uncertain");
    expect(fetch).not.toHaveBeenCalled();
  });
});
