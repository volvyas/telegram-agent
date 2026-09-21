import { describe, expect, it } from "vitest";

import {
  GitOutputParserError,
  parseNumstat,
  parsePorcelainStatus,
} from "../../src/git/GitOutputParser.js";

describe("GitOutputParser", () => {
  it("parses NUL-delimited status paths and renames literally", () => {
    const output = [
      " M line\nwith\ttabs.txt",
      "R  destination -> name.txt",
      "source\nname.txt",
      "?? unicode-ї.txt",
      "",
    ].join("\0");

    expect(parsePorcelainStatus(output)).toEqual([
      {
        path: "line\nwith\ttabs.txt",
        index: " ",
        workTree: "M",
        kind: "modified",
      },
      {
        path: "destination -> name.txt",
        originalPath: "source\nname.txt",
        index: "R",
        workTree: " ",
        kind: "renamed",
      },
      {
        path: "unicode-ї.txt",
        index: "?",
        workTree: "?",
        kind: "untracked",
      },
    ]);
  });

  it("summarizes text, binary and renamed numstat entries", () => {
    const output = [
      "3\t1\tordinary.txt",
      "-\t-\timage.bin",
      "2\t0\t",
      "old\tname.txt",
      "new\nname.txt",
      "",
    ].join("\0");

    expect(parseNumstat(output)).toEqual({
      filesChanged: 3,
      additions: 5,
      deletions: 1,
      binaryFiles: 1,
      entries: [
        {
          path: "ordinary.txt",
          additions: 3,
          deletions: 1,
          binary: false,
        },
        {
          path: "image.bin",
          additions: null,
          deletions: null,
          binary: true,
        },
        {
          path: "new\nname.txt",
          originalPath: "old\tname.txt",
          additions: 2,
          deletions: 0,
          binary: false,
        },
      ],
    });
  });

  it("rejects malformed or unterminated output", () => {
    expect(() => parsePorcelainStatus("?? file.txt")).toThrow(GitOutputParserError);
    expect(() => parseNumstat("not-numstat\0")).toThrow(GitOutputParserError);
  });
});
