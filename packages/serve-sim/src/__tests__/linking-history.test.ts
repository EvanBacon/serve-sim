import { describe, expect, test } from "bun:test";
import {
  LINKING_HISTORY_LIMIT,
  LINKING_HISTORY_STORAGE_KEY,
  MAX_URL_LENGTH,
  describeInvocation,
  linkingHistoryReducer,
  linkingSuggestions,
  readLinkingHistory,
  urlProblem,
  writeLinkingHistory,
  type LinkingInvocation,
} from "../client/utils/linking";

describe("urlProblem", () => {
  test("accepts URLs with a scheme", () => {
    for (const url of ["myapp://", "myapp://path?q=1", "https://example.com/a", "exp+my-app://x", "App-prefs:", "mailto:a@b.c", "tel:123"]) {
      expect(urlProblem(url)).toBeNull();
    }
  });

  test("rejects non-strings, empties, schemeless text, control chars and long input", () => {
    expect(urlProblem(undefined)).toBe("Enter a URL");
    expect(urlProblem(42)).toBe("Enter a URL");
    expect(urlProblem("  ")).toBe("Enter a URL");
    expect(urlProblem("example.com")).toMatch(/needs a scheme/);
    expect(urlProblem("1abc://x")).toMatch(/needs a scheme/);
    expect(urlProblem("-flag:x")).toMatch(/needs a scheme/);
    expect(urlProblem("myapp://a\nb")).toMatch(/control characters/);
    expect(urlProblem("myapp://a\u007f")).toMatch(/control characters/);
    expect(urlProblem(`myapp://${"a".repeat(MAX_URL_LENGTH)}`)).toMatch(/longer than 2048/);
    expect(urlProblem(`myapp://${"a".repeat(MAX_URL_LENGTH - 8)}`)).toBeNull();
  });
});

const url = (u: string): LinkingInvocation => ({ kind: "url", url: u });

describe("linkingHistoryReducer", () => {
  test("adds newest first and caps the list", () => {
    let state: LinkingInvocation[] = [];
    for (let i = 0; i < LINKING_HISTORY_LIMIT + 3; i++) state = linkingHistoryReducer(state, { type: "add", entry: url(`a://${i}`) });
    expect(state).toHaveLength(LINKING_HISTORY_LIMIT);
    expect(state[0]).toEqual(url(`a://${LINKING_HISTORY_LIMIT + 2}`));
    expect(state.at(-1)).toEqual(url("a://3"));
  });

  test("a rerun moves the entry to the top instead of duplicating it", () => {
    let state = [url("a://1"), url("a://2"), { kind: "action", action: "spotlight", query: "Maps" } as LinkingInvocation];
    state = linkingHistoryReducer(state, { type: "add", entry: url("a://2") });
    expect(state).toEqual([url("a://2"), url("a://1"), { kind: "action", action: "spotlight", query: "Maps" }]);
    state = linkingHistoryReducer(state, { type: "add", entry: { kind: "action", action: "spotlight", query: " Maps " } });
    expect(state[0]).toEqual({ kind: "action", action: "spotlight", query: "Maps" });
    expect(state).toHaveLength(3);
  });

  test("tokens with different arguments are distinct; empty queries are dropped", () => {
    let state: LinkingInvocation[] = [];
    state = linkingHistoryReducer(state, { type: "add", entry: { kind: "action", action: "spotlight" } });
    state = linkingHistoryReducer(state, { type: "add", entry: { kind: "action", action: "spotlight", query: "Notes" } });
    state = linkingHistoryReducer(state, { type: "add", entry: { kind: "action", action: "spotlight", query: "" } });
    expect(state).toEqual([
      { kind: "action", action: "spotlight" },
      { kind: "action", action: "spotlight", query: "Notes" },
    ]);
  });

  test("ignores invalid entries and clears", () => {
    const state = [url("a://1")];
    expect(linkingHistoryReducer(state, { type: "add", entry: url("no scheme") })).toEqual(state);
    expect(linkingHistoryReducer(state, { type: "add", entry: { kind: "action", action: "rm" } as never })).toEqual(state);
    expect(linkingHistoryReducer(state, { type: "clear" })).toEqual([]);
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
  };
}

describe("history persistence", () => {
  test("round-trips per app", () => {
    const storage = fakeStorage();
    const a = [url("a://1"), { kind: "action", action: "settings" } as LinkingInvocation];
    writeLinkingHistory("com.example.a", a, storage);
    writeLinkingHistory("com.example.b", [url("b://x")], storage);
    expect(readLinkingHistory("com.example.a", storage)).toEqual(a);
    expect(readLinkingHistory("com.example.b", storage)).toEqual([url("b://x")]);
    expect(readLinkingHistory("com.example.c", storage)).toEqual([]);
    expect(Object.keys(JSON.parse(storage.data.get(LINKING_HISTORY_STORAGE_KEY)!))).toEqual(["com.example.a", "com.example.b"]);
  });

  test("an empty list drops the app's key", () => {
    const storage = fakeStorage();
    writeLinkingHistory("com.example.a", [url("a://1")], storage);
    writeLinkingHistory("com.example.a", [], storage);
    expect(JSON.parse(storage.data.get(LINKING_HISTORY_STORAGE_KEY)!)).toEqual({});
  });

  test("tolerates corrupt, tampered or missing storage", () => {
    expect(readLinkingHistory("x", null)).toEqual([]);
    expect(readLinkingHistory("x", fakeStorage({ [LINKING_HISTORY_STORAGE_KEY]: "{not json" }))).toEqual([]);
    expect(readLinkingHistory("x", fakeStorage({ [LINKING_HISTORY_STORAGE_KEY]: "[1,2]" }))).toEqual([]);
    const tampered = JSON.stringify({
      x: [url("a://1"), url("a://1"), { kind: "url", url: "bad\nurl" }, { kind: "action", action: "nope" }, null,
        ...Array.from({ length: 10 }, (_, i) => url(`z://${i}`))],
    });
    const read = readLinkingHistory("x", fakeStorage({ [LINKING_HISTORY_STORAGE_KEY]: tampered }));
    expect(read[0]).toEqual(url("a://1"));
    expect(read).toHaveLength(LINKING_HISTORY_LIMIT);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
    expect(readLinkingHistory("x", throwing)).toEqual([]);
    expect(() => writeLinkingHistory("x", [url("a://1")], throwing)).not.toThrow();
  });
});

describe("describeInvocation", () => {
  test("labels URLs and tokens", () => {
    expect(describeInvocation(url("a://1"))).toBe("a://1");
    expect(describeInvocation({ kind: "action", action: "spotlight", query: "Maps" })).toBe("Search “Maps”");
    expect(describeInvocation({ kind: "action", action: "notificationSettings" })).toBe("Notification Settings");
  });
});

describe("linkingSuggestions", () => {
  const info = { schemes: ["myapp", "myapp-dev"], domains: ["example.com", "*.example.org"] };
  test("completes schemes and universal-link hosts by prefix", () => {
    expect(linkingSuggestions("", info)).toEqual(["myapp://", "myapp-dev://", "https://example.com/", "https://example.org/"]);
    expect(linkingSuggestions("MYAPP-", info)).toEqual(["myapp-dev://"]);
    expect(linkingSuggestions("https://ex", info)).toEqual(["https://example.com/", "https://example.org/"]);
    expect(linkingSuggestions("myapp://", info)).toEqual([]);
    expect(linkingSuggestions("x", null)).toEqual([]);
  });
});
