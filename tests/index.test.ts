import { describe, expect, it } from "vitest";

import { APPLICATION_NAME } from "../src/index.js";

describe("application bootstrap", () => {
  it("exposes its name", () => {
    expect(APPLICATION_NAME).toBe("codex-remote");
  });
});
