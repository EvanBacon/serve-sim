import { describe, expect, test } from "bun:test";
import { isPasteShortcut, stageGuestPasteboard } from "../client/utils/paste-bridge";

const key = (code: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isPasteShortcut", () => {
  test("Cmd+V and Ctrl+V go to the browser's paste event", () => {
    expect(isPasteShortcut(key("KeyV", { metaKey: true }))).toBe(true);
    expect(isPasteShortcut(key("KeyV", { ctrlKey: true }))).toBe(true);
  });
  test("other chords keep forwarding as HID", () => {
    expect(isPasteShortcut(key("KeyV"))).toBe(false);
    expect(isPasteShortcut(key("KeyV", { metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPasteShortcut(key("KeyV", { metaKey: true, ctrlKey: true }))).toBe(false);
    expect(isPasteShortcut(key("KeyC", { metaKey: true }))).toBe(false);
  });
});

describe("stageGuestPasteboard", () => {
  const PAYLOAD = "Bridge123 ёж ёж \u{1F469}‍\u{1F373}";
  const reply = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  test("sends {text} as JSON and reports verified success", async () => {
    let sent: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ ok: true, verified: true, bytes: 7 }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await stageGuestPasteboard("/pasteboard?device=X", PAYLOAD, { fetchImpl })).toEqual({ ok: true, bytes: 7 });
    expect(sent!.url).toBe("/pasteboard?device=X");
    expect(sent!.init?.method).toBe("POST");
    expect(JSON.parse(String(sent!.init?.body))).toEqual({ text: PAYLOAD });
  });

  test("an unverified or failed stage is not success", async () => {
    expect(await stageGuestPasteboard("/p", "x", { fetchImpl: reply(502, { ok: false, error: "readback_mismatch" }) }))
      .toEqual({ ok: false, error: "readback_mismatch" });
    expect((await stageGuestPasteboard("/p", "x", { fetchImpl: reply(200, { ok: true }) })).ok).toBe(false);
    expect((await stageGuestPasteboard("/p", "x", { fetchImpl: reply(404, {}) })).ok).toBe(false);
  });

  test("oversized text never leaves the page", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return new Response("{}"); }) as unknown as typeof fetch;
    expect((await stageGuestPasteboard("/p", "a".repeat(256 * 1024 + 1), { fetchImpl })).ok).toBe(false);
    expect(called).toBe(false);
  });
});
