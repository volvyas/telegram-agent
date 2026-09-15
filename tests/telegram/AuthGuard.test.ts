import type { Context } from "grammy";
import { describe, expect, it, vi } from "vitest";

import { AuthGuard, UNAUTHORIZED_MESSAGE } from "../../src/telegram/AuthGuard.js";

describe("AuthGuard", () => {
  it("passes an authorized update to the next middleware", async () => {
    const next = vi.fn(() => Promise.resolve());
    const reply = vi.fn(() => Promise.resolve());
    const context = { from: { id: 42 }, chat: { id: 10 }, reply } as unknown as Context;

    await new AuthGuard(new Set([42])).middleware()(context, next);

    expect(next).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it.each(["/start", "plain text"])(
    "blocks an unauthorized %s update and does not continue",
    async (text) => {
      const next = vi.fn(() => Promise.resolve());
      const reply = vi.fn(() => Promise.resolve());
      const context = {
        from: { id: 99 },
        chat: { id: 10 },
        message: { text },
        reply,
      } as unknown as Context;

      await new AuthGuard(new Set([42])).middleware()(context, next);

      expect(reply).toHaveBeenCalledWith(UNAUTHORIZED_MESSAGE);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("blocks an unauthorized callback and does not continue", async () => {
    const next = vi.fn(() => Promise.resolve());
    const answerCallbackQuery = vi.fn(() => Promise.resolve());
    const context = {
      from: { id: 99 },
      callbackQuery: { id: "callback" },
      answerCallbackQuery,
    } as unknown as Context;

    await new AuthGuard(new Set([42])).middleware()(context, next);

    expect(answerCallbackQuery).toHaveBeenCalledWith({
      text: UNAUTHORIZED_MESSAGE,
      show_alert: true,
    });
    expect(next).not.toHaveBeenCalled();
  });
});
