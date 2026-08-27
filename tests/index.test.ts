import { describe, expect, it, vi } from "vitest";

import { APPLICATION_NAME, main } from "../src/index.js";

describe("application bootstrap", () => {
  it("exposes its name", () => {
    expect(APPLICATION_NAME).toBe("codex-remote");
  });

  it("can start the foundation entry point", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    main();

    expect(log).toHaveBeenCalledWith("codex-remote foundation is ready");
    log.mockRestore();
  });
});
