import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { act, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { toast } from "sonner";
import { ServeSimToaster, UploadToastContent } from "../client/components/app-toasts";
import { useUploadToasts } from "../client/hooks/use-upload-toasts";

describe("UploadToastContent", () => {
  test("renders determinate upload progress", () => {
    const html = renderToStaticMarkup(
      <UploadToastContent
        toast={{
          id: "1",
          name: "clip.mov",
          kind: "media",
          status: "uploading",
          progress: 0.42,
        }}
      />,
    );

    expect(html).toContain('data-testid="upload-toast"');
    expect(html).toContain("Uploading clip.mov… 42%");
    expect(html).toContain("width:42%");
  });

  test("renders completed media and ipa messages", () => {
    const media = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "1", name: "photo.png", kind: "media", status: "success", progress: null }}
      />,
    );
    const ipa = renderToStaticMarkup(
      <UploadToastContent
        toast={{ id: "2", name: "App.ipa", kind: "ipa", status: "success", progress: null }}
      />,
    );

    expect(media).toContain("Added photo.png to Photos");
    expect(ipa).toContain("Installed App.ipa");
  });
});

const globalCss = readFileSync(join(import.meta.dir, "../client/global.css"), "utf8");

describe("plain toast chrome", () => {
  test("wraps styled toasts inside the shared panel without restyling custom toasts", () => {
    const styled =
      '[data-sonner-toaster].serve-sim-toaster [data-sonner-toast][data-styled="true"]';
    expect(globalCss).toContain(styled);
    expect(globalCss).toContain(`${styled} [data-content]`);
    expect(globalCss).toContain("min-width: 0");
    expect(globalCss).toContain("overflow-wrap: break-word");
    expect(globalCss).toContain("padding: 8px 12px");
    expect(globalCss).toContain("font-size: 12px");
  });

  test("gives toast.error a panel and leaves upload progress unstyled", async () => {
    const dom = new Window({ url: "http://localhost/", width: 1280, height: 800 });
    const globals = [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "SVGElement",
      "Element",
      "Node",
      "Text",
      "Comment",
      "DocumentFragment",
      "MutationObserver",
      "getComputedStyle",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "HTMLDivElement",
      "HTMLSpanElement",
      "HTMLButtonElement",
      "Event",
      "CustomEvent",
      "KeyboardEvent",
      "PointerEvent",
    ] as const;
    const previous = new Map<string, unknown>();
    const assign = (name: (typeof globals)[number], value: unknown) => {
      previous.set(name, (globalThis as Record<string, unknown>)[name]);
      (globalThis as Record<string, unknown>)[name] = value;
    };
    const bindAsMethod = new Set(["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"]);
    for (const name of globals) {
      const value = name === "window" ? dom : (dom as unknown as Record<string, unknown>)[name];
      assign(
        name,
        bindAsMethod.has(name) && typeof value === "function" ? value.bind(dom) : value,
      );
    }
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    let root: Root | undefined;
    try {
      const container = dom.document.createElement("div");
      dom.document.body.appendChild(container);
      root = createRoot(container as unknown as HTMLElement);
      await act(async () => {
        root!.render(
          <>
            <ServeSimToaster />
            <UploadHarness />
          </>,
        );
      });
      await act(async () => {
        toast.error(
          "Device rendering is unavailable. Check the selected Xcode and server log.",
        );
        toast.success("Simulator fold pose updated.");
        // Sonner publishes toasts on a macrotask. Keep that update inside act.
        await new Promise((resolve) => setTimeout(resolve, 20));
      });

      const error = dom.document.querySelector('[data-sonner-toast][data-type="error"]');
      expect(error).not.toBeNull();
      expect(error?.getAttribute("data-styled")).toBe("true");
      expect(error?.textContent).toContain(
        "Device rendering is unavailable. Check the selected Xcode and server log.",
      );
      expect(error?.querySelector("[data-content]")).not.toBeNull();
      const errorDot = error?.querySelector("[data-testid='plain-toast-dot']");
      expect(errorDot?.getAttribute("style")).toContain("#f87171");

      const success = dom.document.querySelector('[data-sonner-toast][data-type="success"]');
      expect(success?.getAttribute("data-styled")).toBe("true");
      expect(success?.querySelector("[data-testid='plain-toast-dot']")?.getAttribute("style")).toContain(
        "#4ade80",
      );

      const upload = dom.document.querySelector("[data-testid='upload-toast']");
      expect(upload?.textContent).toContain("Uploading clip.mov… 42%");
      const progress = upload?.querySelector("div[style]") as unknown as HTMLElement | null;
      expect(progress?.style.width).toBe("42%");
      const uploadHost = upload?.closest("[data-sonner-toast]");
      expect(uploadHost?.getAttribute("data-styled")).toBe("false");
      expect(uploadHost?.querySelector("[data-testid='plain-toast-dot']")).toBeNull();

      const toaster = dom.document.querySelector("[data-sonner-toaster]") as unknown as HTMLElement;
      expect(toaster.classList.contains("serve-sim-toaster")).toBe(true);
      expect(toaster.style.getPropertyValue("--normal-bg")).toBe("#1c1c1e");
      expect(toaster.style.getPropertyValue("--normal-border")).toBe("rgba(255, 255, 255, 0.12)");
      expect(toaster.style.getPropertyValue("--normal-text")).toBe("rgba(255, 255, 255, 0.9)");
      expect(toaster.style.getPropertyValue("--border-radius")).toBe("8px");
      expect(toaster.style.getPropertyValue("--width")).toBe("320px");
    } finally {
      await act(async () => {
        toast.dismiss();
        root?.unmount();
      });
      await dom.happyDOM.abort();
      for (const name of globals) {
        const prior = previous.get(name);
        if (prior === undefined) delete (globalThis as Record<string, unknown>)[name];
        else (globalThis as Record<string, unknown>)[name] = prior;
      }
    }
  });
});

function UploadHarness() {
  const uploads = useUploadToasts();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const id = uploads.add("clip.mov", "media");
    uploads.setProgress(id, 0.42);
  }, [uploads]);
  return null;
}
