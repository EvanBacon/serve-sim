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

  test("treats regex metacharacters in the home literally and walks nested values", () => {
    expect(redactHome("/Users/a.b/x /Users/aXb/x", "/Users/a.b")).toBe("~/x /Users/aXb/x");
    expect(redactHome({ list: ["/Users/bob/x", 1, null], nested: { path: "/Users/bob" } }, "/Users/bob"))
      .toEqual({ list: ["~/x", 1, null], nested: { path: "~" } });
  });
});
