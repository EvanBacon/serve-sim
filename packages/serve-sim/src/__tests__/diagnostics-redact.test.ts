import { describe, expect, test } from "bun:test";
import { redactHome } from "../diagnostics-redact";

describe("redactHome", () => {
  test("replaces the home when followed by / or the end of the string", () => {
    expect(redactHome("/Users/bob/Library/x", "/Users/bob")).toBe("~/Library/x");
    expect(redactHome("cwd=/Users/bob", "/Users/bob")).toBe("cwd=~");
    expect(redactHome("/Users/bob/a and /Users/bob/b", "/Users/bob")).toBe("~/a and ~/b");
  });

  test("leaves a longer sibling path alone", () => {
    expect(redactHome("/Users/bobby/Library", "/Users/bob")).toBe("/Users/bobby/Library");
    expect(redactHome("/Users/bobby", "/Users/bob")).toBe("/Users/bobby");
    expect(redactHome("/Users/bobby/x /Users/bob/y", "/Users/bob")).toBe("/Users/bobby/x ~/y");
  });

  test("replaces the home when followed by a non-name character", () => {
    expect(redactHome("cwd: /Users/bob.", "/Users/bob")).toBe("cwd: ~.");
    expect(redactHome("/Users/bob\nnext", "/Users/bob")).toBe("~\nnext");
    expect(redactHome("/Users/bob:x", "/Users/bob")).toBe("~:x");
    expect(redactHome("'/Users/bob'", "/Users/bob")).toBe("'~'");
    expect(redactHome('"/Users/bob"', "/Users/bob")).toBe('"~"');
    expect(redactHome("in /Users/bob now", "/Users/bob")).toBe("in ~ now");
    expect(redactHome("(/Users/bob), /Users/bob.", "/Users/bob")).toBe("(~), ~.");
  });

  test("leaves paths whose final component continues the home name alone", () => {
    expect(redactHome("/Users/bob.old", "/Users/bob")).toBe("/Users/bob.old");
    expect(redactHome("/Users/bob-2", "/Users/bob")).toBe("/Users/bob-2");
    expect(redactHome("/Users/bob_x", "/Users/bob")).toBe("/Users/bob_x");
    expect(redactHome("/Users/bob1", "/Users/bob")).toBe("/Users/bob1");
    expect(redactHome("/Users/bob.old and /Users/bob.", "/Users/bob")).toBe("/Users/bob.old and ~.");
  });

  test("treats regex metacharacters in the home literally and walks nested values", () => {
    expect(redactHome("/Users/a.b/x /Users/aXb/x", "/Users/a.b")).toBe("~/x /Users/aXb/x");
    expect(redactHome({ list: ["/Users/bob/x", 1, null], nested: { path: "/Users/bob" } }, "/Users/bob"))
      .toEqual({ list: ["~/x", 1, null], nested: { path: "~" } });
  });
});
