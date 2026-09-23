import { describe, expect, it, vi } from "vitest";

import { withTelegramRetry } from "../../src/telegram/TelegramRetry.js";

describe("withTelegramRetry", () => {
  it("retries rate limits and then succeeds", async () => {
    const action = vi.fn()
      .mockRejectedValueOnce({ error_code: 429, parameters: { retry_after: 0 } })
      .mockResolvedValue("ok");
    const sleep = vi.fn(() => Promise.resolve());

    await expect(withTelegramRetry(action, { sleep })).resolves.toBe("ok");
    expect(action).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("does not retry permanent failures", async () => {
    const action = vi.fn(() => Promise.reject({ error_code: 400 }));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(withTelegramRetry(action, { sleep })).rejects.toMatchObject({ error_code: 400 });
    expect(action).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});
